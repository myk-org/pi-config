"""Post replies and resolve review threads from a JSON file.

This module posts replies and resolves review threads based on the JSON file
created by the fetch module and processed by an AI handler to add status/reply fields.

Expected JSON structure:
  {
    "metadata": { "owner": "...", "repo": "...", "pr_number": "..." },
    "human": [ ... ],      # Human review threads
    "qodo": [ ... ],       # Qodo AI review threads
    "coderabbit": [ ... ]  # CodeRabbit AI review threads
  }

Each thread in human/qodo/coderabbit arrays has:
  {
    "thread_id": "...",      # GraphQL thread ID (preferred)
    "node_id": "...",        # REST API node ID (fallback)
    "comment_id": 123,       # REST API comment ID
    "status": "addressed|skipped|pending|failed",
    "reply": "...",          # Reply message to post
    "skip_reason": "..."     # Reason for skipping (optional)
  }

Status handling:
  - addressed: Post reply and resolve thread
  - not_addressed: Post reply and resolve thread (similar to addressed)
  - skipped: Post reply (with skip reason) and resolve thread
  - pending: Skip (not processed yet)
  - failed: Retry posting

Resolution behavior by source:
  - qodo/coderabbit: Always resolve threads after replying
  - human: Only resolve if status is "addressed"; skipped/not_addressed
          threads are not resolved to allow reviewer follow-up
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from myk_pi_tools.github import (
    check_dependencies,
    post_issue_comment,
    run_graphql,
    run_graphql_raw,
)
from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.constants import BODY_EMBEDDED_COMMENT_TYPES, QODO_STICKY_TYPES, QODO_USERS
from myk_pi_tools.utils import atomic_write_json

log = create_logger(__name__)

# Lazy reply patterns that indicate the AI didn't write a real response
_INTERNAL_ISSUE_REFERENCE = re.compile(r"\binternal\s+(?:issue\s+)?#\d+\b", re.IGNORECASE)
_GITHUB_ISSUE_URL = re.compile(r"https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+(?:[/?#]|\b)", re.IGNORECASE)
_COMPLETED_ISSUE_SPEC_UPDATE = re.compile(
    r"\b(?:(?:have|has)\s+)?(?:updated|amended|clarified|revised|changed)\s+(?:the\s+)?issue\s+spec(?:ification)?\b"
    r"|\bissue\s+spec(?:ification)?\s+(?:was|has\s+been|is)\s+(?:updated|amended|clarified|revised|changed)\b",
    re.IGNORECASE,
)
_UNAFFIRMATIVE_SPEC_RESOLUTION = re.compile(
    r"\b(?:not|never|no|cannot|can't|won't|wasn't|weren't|hasn't|haven't|if|unless|conditional(?:ly)?|"
    r"will|would|could|might|may|future|planned?|planning|proposed?|hypothetical(?:ly)?|should|recommend(?:ed|ation)?|suggest(?:ed|ion)?)\b",
    re.IGNORECASE,
)

_LAZY_REPLY_PATTERNS = [
    "previously addressed",
    "see earlier replies",
    "see earlier",
    "see above",
    "see sticky",
    "see sticky finding",
    "already handled",
    "already covered",
    "same as above",
    "refer to previous",
    "see prior",
    "addressed above",
    "covered above",
    "handled above",
    "see previous reply",
    "see previous comment",
    "see consolidated",
]


def is_linked_issue_spec_resolution(reply: str) -> bool:
    """Return whether a reply affirms a completed spec update linked to an issue.

    The completed update and an allowed internal or GitHub issue reference must
    appear in the same statement. Negated, conditional, future, hypothetical,
    proposed, and recommended statements are deliberately rejected.
    """
    for statement in re.split(r"(?<=[.;!?])\s+|\n+", reply):
        has_issue_reference = bool(_INTERNAL_ISSUE_REFERENCE.search(statement) or _GITHUB_ISSUE_URL.search(statement))
        prose = _GITHUB_ISSUE_URL.sub("", _INTERNAL_ISSUE_REFERENCE.sub("", statement))
        if (
            has_issue_reference
            and _COMPLETED_ISSUE_SPEC_UPDATE.search(statement)
            and not _UNAFFIRMATIVE_SPEC_RESOLUTION.search(prose)
        ):
            log.debug("Accepted linked completed issue-spec resolution")
            return True

    log.debug("Rejected linked issue-spec resolution")
    return False


def _is_auto_skipped(entry: dict[str, Any]) -> bool:
    """True only for a real JSON ``true``.

    ``bool("false")`` is True, so a hand-written string must not buy an exemption
    that suppresses the reply requirement and posts a generic reply instead.
    """
    return entry.get("is_auto_skipped") is True


def validate_reply(reply: str, path: str, status: str, *, auto_skipped: bool = False) -> str | None:
    """Validate a reply is not lazy/vague. Returns error message or None if OK.

    Pending entries are skipped (no reply expected).

    Auto-skipped entries are skipped too: they were never actionable (a Qodo
    finding the CLI reports closed, an informational reply), so nothing is posted
    for them and demanding a reply blocked the entire PR on findings the pipeline
    deliberately does not answer. They used to pass only because closed findings
    carried a synthetic "finding closed" reply, which #1033 removed as untrue.
    """
    if status == "pending":
        return None
    if auto_skipped:
        return None
    if not isinstance(reply, str):
        reply = str(reply) if reply is not None else ""
    if not reply or not reply.strip():
        return f"{path}: Empty reply for status '{status}'. Every non-pending entry needs a specific reply."

    reply_lower = reply.lower().strip()
    for pattern in _LAZY_REPLY_PATTERNS:
        if pattern in reply_lower:
            return (
                f"{path}: Lazy reply detected — contains '{pattern}'. "
                f"Write a specific reply explaining what was done or why it was skipped. "
                f"Current reply: {reply[:100]}"
            )
    return None


def eprint(*args: Any, **kwargs: Any) -> None:
    """Print to stderr."""
    print(*args, file=sys.stderr, **kwargs)


def _prepare_reply_body(body: str) -> str:
    """Sign and truncate a review thread reply body."""
    from myk_pi_tools.comment_signature import append_signature

    signed = append_signature(body)
    max_len = 60000
    if len(signed) > max_len:
        signed = signed[:max_len] + "\n...[truncated]"
    return signed


def post_thread_reply(thread_id: str, body: str) -> bool:
    """Post a reply to a review thread using GraphQL.

    Returns True on success, False on failure.
    """
    body = _prepare_reply_body(body)
    log.debug(
        "Prepared signed review thread reply",
        extra={"thread_id": thread_id, "operation_model_present": bool(os.environ.get("PI_MODEL"))},
    )

    query = """
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
        comment {
          id
        }
      }
    }
    """

    success, result = run_graphql(query, {"threadId": thread_id, "body": body})
    if not success:
        eprint(f"Error posting reply: {result}")
        return False

    return True


def resolve_thread(thread_id: str) -> bool:
    """Resolve a review thread using GraphQL.

    Returns True on success, False on failure.
    """
    query = """
    mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread {
          id
          isResolved
        }
      }
    }
    """

    success, result = run_graphql(query, {"threadId": thread_id})
    if not success:
        eprint(f"Error resolving thread: {result}")
        return False

    return True


def unresolve_thread(thread_id: str) -> bool:
    """Reopen a review thread when resolution ran without a successful reply."""
    query = """
    mutation($threadId: ID!) {
      unresolveReviewThread(input: {threadId: $threadId}) {
        thread {
          id
          isResolved
        }
      }
    }
    """

    success, result = run_graphql(query, {"threadId": thread_id})
    if not success:
        eprint(f"Error unresolving thread: {result}")
        return False

    return True


def reply_and_resolve_thread(thread_id: str, body: str) -> tuple[bool, bool]:
    """Post a reply and resolve the thread in a single GraphQL request.

    Inspects ``data["addPullRequestReviewThreadReply"]`` and
    ``data["resolveReviewThread"]`` independently so a partial failure (reply
    succeeded, resolve failed) returns ``(True, False)`` and records
    ``posted_at``. If the reply failed while ``resolveReviewThread`` succeeded,
    reopens the thread via ``unresolve_thread`` so the thread never closes
    without a reply.
    """
    body = _prepare_reply_body(body)
    log.debug(
        "Prepared combined reply+resolve mutation",
        extra={"thread_id": thread_id, "operation_model_present": bool(os.environ.get("PI_MODEL"))},
    )

    query = """
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
        comment {
          id
        }
      }
      resolveReviewThread(input: {threadId: $threadId}) {
        thread {
          id
          isResolved
        }
      }
    }
    """

    ok, data, err = run_graphql_raw(query, {"threadId": thread_id, "body": body})
    if not ok or data is None:
        eprint(f"Error posting reply and resolving thread: {err}")
        return False, False

    gql_data = data.get("data") or {}
    reply_node = gql_data.get("addPullRequestReviewThreadReply")
    resolve_node = gql_data.get("resolveReviewThread")

    reply_ok = isinstance(reply_node, dict) and reply_node.get("comment") is not None
    resolve_ok = isinstance(resolve_node, dict) and resolve_node.get("thread") is not None

    errors = data.get("errors") or []
    if errors and (not reply_ok or not resolve_ok):
        first_err = errors[0].get("message", "Unknown error")
        if not reply_ok:
            eprint(f"Error posting reply: {first_err}")
        elif not resolve_ok:
            eprint(f"Error resolving thread: {first_err}")

    if not reply_ok and resolve_ok:
        log.warning("Reply failed while resolve succeeded; reopening thread %s", thread_id)
        unresolve_thread(thread_id)
        return False, False

    return reply_ok, resolve_ok


_DEFAULT_POST_THREAD_REPLY = post_thread_reply
_DEFAULT_RESOLVE_THREAD = resolve_thread


def lookup_thread_id_from_node_id(node_id: str) -> str | None:
    """Look up thread_id from a review comment node_id via GraphQL.

    Returns thread_id on success, None on failure.
    """
    query = """
    query($nodeId: ID!) {
      node(id: $nodeId) {
        ... on PullRequestReviewComment {
          pullRequestReviewThread {
            id
          }
        }
      }
    }
    """

    success, result = run_graphql(query, {"nodeId": node_id})
    if not success:
        return None

    if not isinstance(result, dict):
        return None

    # Navigate the response structure
    try:
        thread_id = result["data"]["node"]["pullRequestReviewThread"]["id"]
        return thread_id if thread_id else None
    except (KeyError, TypeError):
        return None


def get_utc_timestamp() -> str:
    """Get current UTC timestamp in ISO format."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def apply_updates_to_json(json_path: Path, updates: list[dict[str, Any]]) -> None:
    """Apply updates to JSON file atomically."""
    if not updates:
        return

    log.debug("Updating JSON file with %d timestamps", len(updates))

    # Read current JSON
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    # Valid fields that can be updated
    valid_fields = {"posted_at", "resolved_at"}

    # Apply updates with validation
    for update in updates:
        cat = update["cat"]
        idx = update["idx"]
        field = update["field"]
        ts = update["ts"]

        # Validate category exists
        if cat not in data:
            eprint(f"Warning: category '{cat}' not found in JSON, skipping update")
            continue

        # Validate index is valid
        if not isinstance(data[cat], list) or idx < 0 or idx >= len(data[cat]):
            eprint(f"Warning: invalid index {idx} for category '{cat}', skipping update")
            continue

        # Validate field is valid
        if field not in valid_fields:
            eprint(f"Warning: invalid field '{field}', expected one of {valid_fields}, skipping update")
            continue

        # Validate timestamp is non-empty string
        if not isinstance(ts, str) or not ts:
            eprint(f"Warning: invalid timestamp '{ts}' for {cat}[{idx}].{field}, skipping update")
            continue

        data[cat][idx][field] = ts

    # Write atomically via temp file
    try:
        atomic_write_json(json_path, data, indent=2, suffix=".json")
    except (json.JSONDecodeError, OSError, KeyError) as exc:
        eprint(f"Error: Failed to apply JSON updates: {exc}")
        sys.exit(1)


def _build_comment_section(entry: dict[str, Any], max_section_len: int) -> str:
    """Build a formatted markdown section for a single body comment entry.

    Args:
        entry: Entry dict with {"data": thread_data, "cat": category, "idx": index}
        max_section_len: Maximum allowed length for the section text.

    Returns:
        Formatted section text.
    """
    truncated_suffix = "\n...[truncated]"
    comment = entry["data"]
    path = comment.get("path", "unknown")
    line_num = comment.get("line", "")
    status = comment.get("status", "")
    reply = comment.get("reply", "") or comment.get("skip_reason", "")
    comment_type = comment.get("type", "").replace("_", " ").replace("comment", "").strip()

    body = comment.get("body", "")
    summary = body.split("\n")[0][:100] if body else "No description"
    summary = summary.strip("*").strip()

    location = f"`{path}:{line_num}`" if line_num else f"`{path}`"
    type_label = f" ({comment_type})" if comment_type else ""

    section_lines = [f"### {location}{type_label} — {summary}"]
    if status == "addressed":
        section_lines.append(f"> Addressed: {reply}" if reply else "> Addressed.")
    elif status == "skipped":
        section_lines.append(f"> Skipped: {reply}" if reply else "> Skipped.")
    elif status == "not_addressed":
        section_lines.append(f"> Not addressed: {reply}" if reply else "> Not addressed.")
    elif status == "failed":
        section_lines.append(f"> Retry: {reply}" if reply else "> Retry.")
    section_lines.append("")

    section_text = "\n".join(section_lines)
    if len(section_text) > max_section_len:
        keep = max(0, max_section_len - len(truncated_suffix))
        section_text = section_text[:keep] + truncated_suffix

    return section_text


def _chunk_sections(
    header: str,
    sections: list[tuple[str, dict[str, Any]]],
    max_len: int,
) -> list[list[tuple[str, dict[str, Any]]]]:
    """Split sections into chunks that fit within the GitHub comment size limit.

    Args:
        header: Comment header text (included in each chunk's size budget).
        sections: List of (section_text, entry) tuples.
        max_len: Maximum allowed body length per chunk.

    Returns:
        List of chunks, where each chunk is a list of (section_text, entry) tuples.
    """
    chunks: list[list[tuple[str, dict[str, Any]]]] = []
    current_chunk: list[tuple[str, dict[str, Any]]] = []
    current_size = len(header)

    for section_text, entry in sections:
        section_size = len(section_text)
        if current_chunk and current_size + section_size > max_len:
            chunks.append(current_chunk)
            current_chunk = []
            current_size = len(header)
        current_chunk.append((section_text, entry))
        current_size += section_size

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def _post_chunk(
    owner: str,
    repo: str,
    pr_number: str | int,
    reviewer: str,
    chunk: list[tuple[str, dict[str, Any]]],
    header: str,
    chunk_idx: int,
    total_chunks: int,
    max_len: int,
) -> tuple[bool, list[dict[str, Any]]]:
    """Post a single consolidated comment chunk to a pull request.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
        reviewer: Reviewer username.
        chunk: List of (section_text, entry) tuples for this chunk.
        header: Comment header text.
        chunk_idx: Zero-based index of this chunk.
        total_chunks: Total number of chunks being posted.
        max_len: Maximum allowed body length.

    Returns:
        Tuple of (success, list of posted_at update dicts).
    """
    truncated_suffix = "\n...[truncated]"
    from myk_pi_tools.comment_signature import append_signature

    chunk_body = append_signature(header + "".join(text for text, _ in chunk).strip())
    if total_chunks > 1:
        chunk_body = f"(Part {chunk_idx + 1}/{total_chunks})\n\n" + chunk_body

    if len(chunk_body) > max_len:
        keep = max(0, max_len - len(truncated_suffix))
        chunk_body = chunk_body[:keep] + truncated_suffix

    posted_updates: list[dict[str, Any]] = []
    ok, _stdout, err = post_issue_comment(owner, repo, pr_number, chunk_body, timeout=30)
    if ok:
        chunk_count = len(chunk)
        log.debug("Posted consolidated reply for %d body comment(s) mentioning %s", chunk_count, reviewer)
        ts = get_utc_timestamp()
        for _, entry in chunk:
            posted_updates.append({
                "cat": entry["cat"],
                "idx": entry["idx"],
                "field": "posted_at",
                "ts": ts,
            })
        return True, posted_updates
    eprint(f"Error posting consolidated reply for {reviewer}: {err}")
    return False, []


def post_body_comment_replies(
    owner: str,
    repo: str,
    pr_number: str | int,
    body_comments: dict[str, list[dict[str, Any]]],
) -> tuple[int, list[dict[str, Any]]]:
    """Post consolidated PR comments for body comments (outside_diff, major, minor, nitpick, duplicate, qodo sticky).

    Groups comments by reviewer author and posts one or more PR comments per reviewer
    mentioning the reviewer so they know the comments were reviewed.
    Chunks into multiple comments if the combined body exceeds GitHub's size limit.

    Args:
        owner: Repository owner
        repo: Repository name
        pr_number: Pull request number
        body_comments: Dict mapping reviewer username to list of entry dicts
            Each entry has {"data": thread_data, "cat": category, "idx": index}

    Returns:
        Tuple of (number of chunks successfully posted, list of posted_at updates)
    """
    max_len = 55000  # Leave margin below GitHub's ~65KB limit
    header_template = "@{reviewer}\n\nThe following review comments were reviewed and a decision was made:\n\n"
    posted = 0
    posted_updates: list[dict[str, Any]] = []

    for reviewer, entries in body_comments.items():
        if not entries:
            continue

        # Qodo v2 responds to /qodo, not @qodo-code-review[bot]
        if reviewer in QODO_USERS:
            header = "/qodo\n\nThe following review comments were reviewed and a decision was made:\n\n"
        else:
            header = header_template.format(reviewer=reviewer)
        part_prefix_budget = 32  # "(Part N/M)\n\n" safety margin
        max_section_len = max_len - len(header) - part_prefix_budget

        # Build individual sections for each comment
        sections: list[tuple[str, dict[str, Any]]] = []
        for entry in entries:
            section_text = _build_comment_section(entry, max_section_len)
            sections.append((section_text, entry))

        # Chunk sections into posts that fit within the size limit
        chunks = _chunk_sections(header, sections, max_len)

        # Post each chunk
        for chunk_idx, chunk in enumerate(chunks):
            success, chunk_updates = _post_chunk(
                owner, repo, pr_number, reviewer, chunk, header, chunk_idx, len(chunks), max_len
            )
            if success:
                posted += 1
                posted_updates.extend(chunk_updates)

    return posted, posted_updates


def _process_one_thread(task: dict[str, Any]) -> dict[str, Any]:
    """Execute GraphQL lookup/post/resolve for a single review thread."""
    category = task["category"]
    idx = task["idx"]
    thread_id = task["thread_id"]
    node_id = task["node_id"]
    path = task["path"]
    status = task["status"]
    reply_message = task["reply_message"]
    should_resolve = task["should_resolve"]
    resolve_only_retry = task["resolve_only_retry"]

    effective_thread_id = ""
    if thread_id and thread_id != "null":
        effective_thread_id = thread_id
    elif node_id and node_id != "null":
        looked_up_id = lookup_thread_id_from_node_id(node_id)
        if looked_up_id is None:
            eprint(f"Warning: Failed to look up thread_id from node_id for {category}[{idx}] ({path})")
        else:
            effective_thread_id = looked_up_id

    if not effective_thread_id:
        eprint(f"Warning: No resolvable thread_id for {category}[{idx}] ({path}) - cannot post reply")
        return {"outcome": "no_thread_id"}

    use_combined = (
        not resolve_only_retry
        and should_resolve
        and post_thread_reply is _DEFAULT_POST_THREAD_REPLY
        and resolve_thread is _DEFAULT_RESOLVE_THREAD
    )

    if use_combined:
        reply_ok, resolve_ok = reply_and_resolve_thread(effective_thread_id, reply_message)
        if not reply_ok:
            eprint(f"Failed to post reply for {category}[{idx}] ({path})")
            return {"outcome": "reply_failed"}
        posted_ts = get_utc_timestamp()
        if not resolve_ok:
            eprint(f"Failed to resolve {category}[{idx}] ({path}) - reply was posted but thread not resolved")
            return {"outcome": "resolve_failed", "posted_ts": posted_ts}
        resolved_ts = get_utc_timestamp()
        log.debug("Resolved %s[%d] (%s)", category, idx, path)
        return {"outcome": "resolved", "posted_ts": posted_ts, "resolved_ts": resolved_ts, "status": status}

    if not resolve_only_retry:
        if not post_thread_reply(effective_thread_id, reply_message):
            eprint(f"Failed to post reply for {category}[{idx}] ({path})")
            return {"outcome": "reply_failed"}

    fallback_posted_ts: str | None = get_utc_timestamp() if not resolve_only_retry else None
    if should_resolve:
        if not resolve_thread(effective_thread_id):
            eprint(f"Failed to resolve {category}[{idx}] ({path}) - reply was posted but thread not resolved")
            return {"outcome": "resolve_failed", "posted_ts": fallback_posted_ts}
        resolved_ts = get_utc_timestamp()
        log.debug("Resolved %s[%d] (%s)", category, idx, path)
        return {"outcome": "resolved", "posted_ts": fallback_posted_ts, "resolved_ts": resolved_ts, "status": status}

    log.debug("Replied to %s[%d] (%s) (not resolved)", category, idx, path)
    return {"outcome": "replied_only", "posted_ts": fallback_posted_ts}


def run(json_path: str) -> None:
    """Main entry point.

    Args:
        json_path: Path to JSON file with review data.
    """
    check_dependencies()

    json_path_obj = Path(json_path).resolve()

    # Validate JSON file exists
    if not json_path_obj.is_file():
        eprint(f"Error: JSON file not found: {json_path}")
        sys.exit(1)

    # Validate JSON is readable and well-formed
    try:
        with open(json_path_obj, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        eprint(f"Error: Invalid JSON file: {json_path}")
        sys.exit(1)

    # Extract metadata
    metadata = data.get("metadata", {})
    owner = metadata.get("owner", "")
    repo = metadata.get("repo", "")
    pr_number = metadata.get("pr_number", "")

    if not owner or not repo or not pr_number:
        eprint("Error: Missing metadata in JSON file (owner, repo, or pr_number)")
        sys.exit(1)

    # Categories to process
    categories = ["human", "qodo", "coderabbit"]

    # Get total thread count across all categories
    total_thread_count = sum(len(data.get(cat, [])) for cat in categories)

    if total_thread_count == 0:
        eprint("No threads to process")
        sys.exit(0)

    log.debug("Posting review comments for %s/%s#%s (%d threads)", owner, repo, pr_number, total_thread_count)

    # Validate replies — block lazy/vague replies before posting
    lazy_errors: list[str] = []
    for cat in categories:
        for comment in data.get(cat, []):
            reply = str(comment.get("reply") or comment.get("skip_reason") or "")
            status = comment.get("status", "pending")
            comment_path = comment.get("path", "unknown")
            err = validate_reply(reply, comment_path, status, auto_skipped=_is_auto_skipped(comment))
            if err:
                lazy_errors.append(err)
            # Ensure reply field is always populated (posting uses reply, not skip_reason)
            elif status != "pending" and not comment.get("reply") and comment.get("skip_reason"):
                comment["reply"] = comment["skip_reason"]
    if lazy_errors:
        eprint(f"\nError: {len(lazy_errors)} lazy/vague replies detected. Fix them before posting:\n")
        for err in lazy_errors:
            eprint(f"  ✗ {err}")
        eprint(
            "\nEvery reply must be specific — explain what was fixed"
            " (with commit SHA) or why it was skipped (with technical reason)."
        )
        sys.exit(1)

    # Enforce: Qodo sticky findings require a code fix unless a skipped reply
    # truthfully documents a linked issue-spec update. This is enforced in code
    # because LLMs find ways to bypass prompt rules.
    sticky_errors: list[str] = []
    for cat in categories:
        for comment in data.get(cat, []):
            comment_type = comment.get("type", "")
            if comment_type not in QODO_STICKY_TYPES:
                continue
            status = comment.get("status", "pending")
            if status == "pending":
                continue  # Not processed yet — OK
            if _is_auto_skipped(comment):
                continue  # Auto-skipped from previous cycle — OK
            reply = str(comment.get("reply") or "")
            is_linked_spec_skip = status == "skipped" and is_linked_issue_spec_resolution(reply)
            if status != "addressed" and not is_linked_spec_skip:
                path = comment.get("path", "unknown")
                line = comment.get("line", "")
                location = f"{path}:{line}" if line else path
                sticky_errors.append(
                    f"{location}: Qodo sticky ({comment_type}) has status '{status}' — "
                    f"MUST be 'addressed', unless status is 'skipped' with a reply that "
                    f"explicitly documents an issue-spec update and references an internal issue "
                    f"(for example, internal #782) or a GitHub issue URL."
                )
    if sticky_errors:
        eprint(f"\n{'=' * 70}")
        eprint(f"BLOCKED: {len(sticky_errors)} Qodo sticky finding(s) not addressed.")
        eprint(f"{'=' * 70}\n")
        for err in sticky_errors:
            eprint(f"  ✗ {err}")
        eprint(
            "\n"
            "Qodo sticky findings MUST be fixed with code changes, except for a documented "
            "issue-spec resolution.\n"
            "  - 'not_addressed' is NOT allowed — fix the code\n"
            "  - 'by design' is NOT a valid reason\n"
            "  - 'skipped' is allowed only when its reply explicitly says the issue spec was "
            "updated and includes internal #<number> or a GitHub /issues/<number> URL\n"
            "  - Otherwise, fix the code and set status to 'addressed'\n"
            "\n"
            "This validation is enforced in code and cannot be bypassed."
        )
        sys.exit(1)

    # Counters for summary
    addressed_count = 0
    skipped_count = 0
    pending_count = 0
    failed_count = 0
    no_thread_id_count = 0
    replied_not_resolved_count = 0
    already_posted_count = 0
    outside_diff_count = 0
    major_count = 0
    minor_count = 0
    nitpick_count = 0
    duplicate_count = 0
    qodo_sticky_count = 0

    # Collect body comments for consolidated PR comments
    body_comments_by_reviewer: dict[str, list[dict[str, Any]]] = {}

    # Track updates for atomic application
    updates: list[dict[str, Any]] = []

    # Collect threaded work items for bounded parallel execution
    thread_tasks: list[dict[str, Any]] = []

    # Process each category
    for category in categories:
        category_threads = data.get(category, [])
        thread_count = len(category_threads)

        if thread_count == 0:
            continue

        log.debug("Processing %d threads in %s", thread_count, category)

        for i, thread_data in enumerate(category_threads):
            # Extract fields
            thread_id = thread_data.get("thread_id", "") or ""
            node_id = thread_data.get("node_id", "") or ""
            status = thread_data.get("status", "pending") or "pending"
            reply = thread_data.get("reply", "") or ""
            skip_reason = thread_data.get("skip_reason", "") or ""
            posted_at = thread_data.get("posted_at", "") or ""
            resolved_at = thread_data.get("resolved_at", "") or ""
            path = thread_data.get("path", "unknown") or "unknown"

            # Body-embedded comments (outside-diff, major, minor, nitpick, duplicate, qodo sticky)
            # have no GitHub thread to post to or resolve.
            # They are tracked via the review database only.
            comment_type = thread_data.get("type")
            if comment_type in BODY_EMBEDDED_COMMENT_TYPES:
                if status == "pending":
                    pending_count += 1
                    log.debug("Skipping %s[%d] (%s): %s status is pending", category, i, path, comment_type)
                    continue
                if status in ("addressed", "not_addressed", "skipped", "failed"):
                    # Skip if already posted (idempotency)
                    if posted_at:
                        already_posted_count += 1
                        log.debug(
                            "Skipping %s[%d] (%s): %s already posted at %s",
                            category,
                            i,
                            path,
                            comment_type,
                            posted_at,
                        )
                        continue

                    # Skip auto-skipped entries — they were already replied to in a previous cycle
                    if _is_auto_skipped(thread_data):
                        already_posted_count += 1
                        log.debug(
                            "Skipping %s[%d] (%s): %s auto-skipped (already replied in previous cycle)",
                            category,
                            i,
                            path,
                            comment_type,
                        )
                        continue

                    # Collect for consolidated PR comment (counts tracked after posting)
                    author_raw = thread_data.get("author")
                    author = author_raw.strip() if isinstance(author_raw, str) and author_raw.strip() else "unknown"
                    if author not in body_comments_by_reviewer:
                        body_comments_by_reviewer[author] = []
                    body_comments_by_reviewer[author].append({"data": thread_data, "cat": category, "idx": i})

                    log.debug(
                        "%s %s[%d] (%s) - collected for consolidated PR comment",
                        comment_type.replace("_", " ").title(),
                        category,
                        i,
                        path,
                    )
                    continue
                # Unknown status - skip with warning
                eprint(f"Warning: Unknown status for {comment_type} {category}[{i}] ({path}): {status}")
                continue

            # Determine if we should resolve this thread (MUST be before resolve_only_retry check)
            should_resolve = True
            if category == "human" and status != "addressed":
                should_resolve = False

            # Determine if this is a resolve-only retry (posted but not resolved)
            resolve_only_retry = False
            if posted_at and not resolved_at:
                if should_resolve:
                    resolve_only_retry = True
                    log.debug(
                        "Retrying resolve for %s[%d] (%s): posted at %s but not resolved",
                        category,
                        i,
                        path,
                        posted_at,
                    )
                else:
                    already_posted_count += 1
                    log.debug(
                        "Skipping %s[%d] (%s): reply already posted at %s (not resolving by policy)",
                        category,
                        i,
                        path,
                        posted_at,
                    )
                    continue
            elif posted_at:
                # Already fully processed (posted and resolved)
                already_posted_count += 1
                log.debug("Skipping %s[%d] (%s): already posted at %s", category, i, path, posted_at)
                continue

            # Skip pending threads
            if status == "pending":
                pending_count += 1
                log.debug("Skipping %s[%d] (%s): status is pending", category, i, path)
                continue

            # Auto-skipped entries with nothing to say are skipped: the threaded path
            # below would otherwise post a generic "Addressed."/"Skipped." reply and
            # resolve the thread. A dismissed-thread match DOES carry its reason, and
            # that reason must still be posted and the thread resolved.
            if _is_auto_skipped(thread_data) and not (reply.strip() or skip_reason.strip()):
                already_posted_count += 1
                log.debug("Skipping threaded auto-skipped entry", extra={"category": category, "path": path})
                continue

            # Build reply message based on status
            reply_message = ""
            if status == "addressed":
                reply_message = reply if reply else "Addressed."
            elif status == "skipped":
                if skip_reason:
                    reply_message = f"Skipped: {skip_reason}"
                elif reply:
                    reply_message = reply
                else:
                    reply_message = "Skipped."
            elif status == "not_addressed":
                reply_message = reply if reply else "Not addressed - see reply for details."
            elif status == "failed":
                reply_message = reply if reply else "Addressed."
            else:
                eprint(f"Warning: Unknown status for {category}[{i}] ({path}): {status}")
                continue

            thread_tasks.append({
                "category": category,
                "idx": i,
                "thread_id": thread_id,
                "node_id": node_id,
                "path": path,
                "status": status,
                "reply_message": reply_message,
                "should_resolve": should_resolve,
                "resolve_only_retry": resolve_only_retry,
            })

    if thread_tasks:
        if len(thread_tasks) == 1:
            thread_results = [_process_one_thread(thread_tasks[0])]
        else:
            with ThreadPoolExecutor(max_workers=min(4, len(thread_tasks))) as executor:
                thread_results = list(executor.map(_process_one_thread, thread_tasks))

        for task, res in zip(thread_tasks, thread_results, strict=True):
            outcome = res["outcome"]
            category = task["category"]
            idx = task["idx"]
            if outcome == "no_thread_id":
                no_thread_id_count += 1
            elif outcome == "reply_failed":
                failed_count += 1
            elif outcome == "resolve_failed":
                if res.get("posted_ts"):
                    updates.append({"cat": category, "idx": idx, "field": "posted_at", "ts": res["posted_ts"]})
                failed_count += 1
            elif outcome == "resolved":
                if res.get("posted_ts"):
                    updates.append({"cat": category, "idx": idx, "field": "posted_at", "ts": res["posted_ts"]})
                updates.append({"cat": category, "idx": idx, "field": "resolved_at", "ts": res["resolved_ts"]})
                if res["status"] in ("addressed", "not_addressed", "failed"):
                    addressed_count += 1
                elif res["status"] == "skipped":
                    skipped_count += 1
            elif outcome == "replied_only":
                if res.get("posted_ts"):
                    updates.append({"cat": category, "idx": idx, "field": "posted_at", "ts": res["posted_ts"]})
                replied_not_resolved_count += 1

    # Post consolidated PR comments for body comments
    if body_comments_by_reviewer:
        total_body = sum(len(c) for c in body_comments_by_reviewer.values())
        log.debug("Posting consolidated replies for %d body comment(s)", total_body)
        _, body_updates = post_body_comment_replies(owner, repo, pr_number, body_comments_by_reviewer)
        updates.extend(body_updates)

        # Count successfully posted body comments by type
        for update in body_updates:
            cat = update["cat"]
            idx = update["idx"]
            comment_data = data.get(cat, [])[idx] if idx < len(data.get(cat, [])) else {}
            comment_type = comment_data.get("type", "")
            if comment_type == "outside_diff_comment":
                outside_diff_count += 1
            elif comment_type == "major_comment":
                major_count += 1
            elif comment_type == "minor_comment":
                minor_count += 1
            elif comment_type == "nitpick_comment":
                nitpick_count += 1
            elif comment_type == "duplicate_comment":
                duplicate_count += 1
            elif comment_type in QODO_STICKY_TYPES or comment_type == "qodo_reply":
                qodo_sticky_count += 1

        body_comment_failed = total_body - len(body_updates)
        if body_comment_failed > 0:
            failed_count += body_comment_failed

    # Apply all JSON updates atomically
    apply_updates_to_json(json_path_obj, updates)

    # Print summary
    total_resolved = addressed_count + skipped_count
    total_processed = (
        total_resolved
        + replied_not_resolved_count
        + outside_diff_count
        + major_count
        + minor_count
        + nitpick_count
        + duplicate_count
        + qodo_sticky_count
    )
    eprint(f"Posted {total_processed} comment(s)")
    eprint("")
    eprint("=== Summary ===")
    eprint(f"Processed {total_processed} threads")
    eprint(f"  Resolved: {total_resolved} ({addressed_count} addressed, {skipped_count} skipped)")

    if replied_not_resolved_count > 0:
        eprint(f"  Replied only: {replied_not_resolved_count} (human reviews - awaiting reviewer follow-up)")

    if outside_diff_count > 0:
        eprint(f"  Outside-diff: {outside_diff_count} (replied via consolidated PR comment)")

    if major_count > 0:
        eprint(f"  Major: {major_count} (replied via consolidated PR comment)")

    if minor_count > 0:
        eprint(f"  Minor: {minor_count} (replied via consolidated PR comment)")

    if nitpick_count > 0:
        eprint(f"  Nitpick: {nitpick_count} (replied via consolidated PR comment)")

    if duplicate_count > 0:
        eprint(f"  Duplicate: {duplicate_count} (replied via consolidated PR comment)")

    if qodo_sticky_count > 0:
        eprint(f"  Qodo sticky: {qodo_sticky_count} (replied via consolidated PR comment)")

    if pending_count > 0:
        eprint(f"  Pending: {pending_count} threads (not processed yet)")

    if no_thread_id_count > 0:
        eprint(
            f"  Skipped: {no_thread_id_count} threads "
            "(no thread_id - likely fetched via REST API without GraphQL thread ID)"
        )

    if already_posted_count > 0:
        eprint(f"  Already posted: {already_posted_count} threads")

    if failed_count > 0:
        eprint(f"Failed: {failed_count} threads")
        # Print actionable retry instruction to stdout for AI callers
        print(
            f"\nACTION REQUIRED: {failed_count} thread(s) failed to post."
            f" Re-run the command to retry failed entries:"
            f"\n  myk-pi-tools reviews post {shlex.quote(str(json_path_obj))}",
            flush=True,
        )
        sys.exit(1)

    sys.exit(0)
