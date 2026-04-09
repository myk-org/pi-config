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
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def eprint(*args: Any, **kwargs: Any) -> None:
    """Print to stderr."""
    print(*args, file=sys.stderr, **kwargs)


def check_dependencies() -> None:
    """Check required dependencies are available."""
    for cmd in ["gh"]:
        if shutil.which(cmd) is None:
            eprint(f"Error: '{cmd}' is required but not installed.")
            sys.exit(1)


def run_graphql(query: str, variables: dict[str, str]) -> tuple[bool, dict[str, Any] | str]:
    """Run a GraphQL query via gh api graphql.

    Returns (success, result) where result is parsed JSON on success or error string on failure.
    """
    payload = {"query": query, "variables": variables}
    cmd = ["gh", "api", "graphql", "--input", "-"]

    try:
        result = subprocess.run(
            cmd,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return False, "GraphQL query timed out after 120 seconds"

    # Use stdout for JSON parsing, combined output for error reporting
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    error_output = (stdout + ("\n" + stderr if stderr else "")).strip()

    if result.returncode != 0:
        return False, error_output

    # Validate JSON response - parse stdout only
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return False, error_output

    # Check for GraphQL errors
    if data.get("errors") and len(data["errors"]) > 0:
        error_msg = data["errors"][0].get("message", "Unknown error")
        return False, error_msg

    return True, data


def post_thread_reply(thread_id: str, body: str) -> bool:
    """Post a reply to a review thread using GraphQL.

    Returns True on success, False on failure.
    """
    # GitHub comment bodies have a size limit (~65KB); truncate to avoid failures
    max_len = 60000
    if len(body) > max_len:
        body = body[:max_len] + "\n...[truncated]"

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
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def apply_updates_to_json(json_path: Path, updates: list[dict[str, Any]]) -> None:
    """Apply updates to JSON file atomically."""
    if not updates:
        return

    eprint("")
    eprint(f"Updating JSON file with {len(updates)} timestamps...")

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
    fd, tmp_path = tempfile.mkstemp(dir=json_path.parent, suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, json_path)
    except (json.JSONDecodeError, OSError, KeyError) as exc:
        # Clean up temp file on error
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
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
    chunk_body = header + "".join(text for text, _ in chunk).strip()
    if total_chunks > 1:
        chunk_body = f"(Part {chunk_idx + 1}/{total_chunks})\n\n" + chunk_body

    if len(chunk_body) > max_len:
        keep = max(0, max_len - len(truncated_suffix))
        chunk_body = chunk_body[:keep] + truncated_suffix

    posted_updates: list[dict[str, Any]] = []
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{owner}/{repo}/issues/{pr_number}/comments", "-f", f"body={chunk_body}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode == 0:
            chunk_count = len(chunk)
            eprint(f"Posted consolidated reply for {chunk_count} body comment(s) mentioning @{reviewer}")
            ts = get_utc_timestamp()
            for _, entry in chunk:
                posted_updates.append({
                    "cat": entry["cat"],
                    "idx": entry["idx"],
                    "field": "posted_at",
                    "ts": ts,
                })
            return True, posted_updates
        eprint(f"Error posting consolidated reply for @{reviewer}: {result.stderr}")
        return False, []
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        eprint(f"Error posting consolidated reply for @{reviewer}: {e}")
        return False, []


def post_body_comment_replies(
    owner: str,
    repo: str,
    pr_number: str | int,
    body_comments: dict[str, list[dict[str, Any]]],
) -> tuple[int, list[dict[str, Any]]]:
    """Post consolidated PR comments for body comments (outside_diff, nitpick, duplicate).

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

    eprint(f"Processing reviews for {owner}/{repo}#{pr_number}")

    # Categories to process
    categories = ["human", "qodo", "coderabbit"]

    # Get total thread count across all categories
    total_thread_count = sum(len(data.get(cat, [])) for cat in categories)

    if total_thread_count == 0:
        eprint("No threads to process")
        sys.exit(0)

    eprint(f"Processing {total_thread_count} threads sequentially...")

    # Counters for summary
    addressed_count = 0
    skipped_count = 0
    pending_count = 0
    failed_count = 0
    no_thread_id_count = 0
    replied_not_resolved_count = 0
    already_posted_count = 0
    outside_diff_count = 0
    nitpick_count = 0
    duplicate_count = 0

    # Collect body comments for consolidated PR comments
    body_comments_by_reviewer: dict[str, list[dict[str, Any]]] = {}

    # Track updates for atomic application
    updates: list[dict[str, Any]] = []

    # Process each category
    for category in categories:
        category_threads = data.get(category, [])
        thread_count = len(category_threads)

        if thread_count == 0:
            continue

        eprint(f"Processing {thread_count} threads in {category}...")

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

            # Outside-diff and nitpick comments have no GitHub thread to post to or resolve.
            # They are tracked via the review database only.
            comment_type = thread_data.get("type")
            if comment_type in ("outside_diff_comment", "nitpick_comment", "duplicate_comment"):
                if status == "pending":
                    pending_count += 1
                    eprint(f"Skipping {category}[{i}] ({path}): {comment_type} status is pending")
                    continue
                if status in ("addressed", "not_addressed", "skipped", "failed"):
                    # Skip if already posted (idempotency)
                    if posted_at:
                        already_posted_count += 1
                        eprint(f"Skipping {category}[{i}] ({path}): {comment_type} already posted at {posted_at}")
                        continue

                    # Skip auto-skipped entries — they were already replied to in a previous cycle
                    if thread_data.get("is_auto_skipped"):
                        already_posted_count += 1
                        eprint(
                            f"Skipping {category}[{i}] ({path}): {comment_type}"
                            " auto-skipped (already replied in previous cycle)"
                        )
                        continue

                    # Collect for consolidated PR comment (counts tracked after posting)
                    author_raw = thread_data.get("author")
                    author = author_raw.strip() if isinstance(author_raw, str) and author_raw.strip() else "unknown"
                    if author not in body_comments_by_reviewer:
                        body_comments_by_reviewer[author] = []
                    body_comments_by_reviewer[author].append({"data": thread_data, "cat": category, "idx": i})

                    eprint(
                        f"{comment_type.replace('_', ' ').title()} {category}[{i}] ({path})"
                        " - collected for consolidated PR comment"
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
                    eprint(f"Retrying resolve for {category}[{i}] ({path}): posted at {posted_at} but not resolved")
                else:
                    already_posted_count += 1
                    eprint(
                        f"Skipping {category}[{i}] ({path}): reply already posted at "
                        f"{posted_at} (not resolving by policy)"
                    )
                    continue
            elif posted_at:
                # Already fully processed (posted and resolved)
                already_posted_count += 1
                eprint(f"Skipping {category}[{i}] ({path}): already posted at {posted_at}")
                continue

            # Skip pending threads
            if status == "pending":
                pending_count += 1
                eprint(f"Skipping {category}[{i}] ({path}): status is pending")
                continue

            # Determine which ID to use for GraphQL
            effective_thread_id = ""
            if thread_id and thread_id != "null":
                effective_thread_id = thread_id
            elif node_id and node_id != "null":
                # Try to derive thread_id from the review comment node id
                looked_up_id = lookup_thread_id_from_node_id(node_id)
                if looked_up_id is None:
                    eprint(f"Warning: Failed to look up thread_id from node_id for {category}[{i}] ({path})")
                else:
                    effective_thread_id = looked_up_id

            # Check if we have a usable thread ID
            if not effective_thread_id:
                no_thread_id_count += 1
                eprint(f"Warning: No resolvable thread_id for {category}[{i}] ({path}) - cannot post reply")
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

            # Post reply only if not already posted
            if not resolve_only_retry:
                if not post_thread_reply(effective_thread_id, reply_message):
                    failed_count += 1
                    eprint(f"Failed to post reply for {category}[{i}] ({path})")
                    continue

            # Resolve thread only if appropriate
            if should_resolve:
                if not resolve_thread(effective_thread_id):
                    # Record posted_at if we just posted (so next run can retry resolve only)
                    if not resolve_only_retry:
                        posted_at_timestamp = get_utc_timestamp()
                        updates.append({"cat": category, "idx": i, "field": "posted_at", "ts": posted_at_timestamp})
                    failed_count += 1
                    eprint(f"Failed to resolve {category}[{i}] ({path}) - reply was posted but thread not resolved")
                    continue

                # Record both timestamps after successful resolve
                if not resolve_only_retry:
                    posted_at_timestamp = get_utc_timestamp()
                    updates.append({"cat": category, "idx": i, "field": "posted_at", "ts": posted_at_timestamp})
                resolved_at_timestamp = get_utc_timestamp()
                updates.append({"cat": category, "idx": i, "field": "resolved_at", "ts": resolved_at_timestamp})

                if status in ("addressed", "not_addressed", "failed"):
                    addressed_count += 1
                elif status == "skipped":
                    skipped_count += 1

                eprint(f"Resolved {category}[{i}] ({path})")
            else:
                # For threads we don't resolve, record posted_at after successful reply
                if not resolve_only_retry:
                    posted_at_timestamp = get_utc_timestamp()
                    updates.append({"cat": category, "idx": i, "field": "posted_at", "ts": posted_at_timestamp})
                replied_not_resolved_count += 1
                eprint(f"Replied to {category}[{i}] ({path}) (not resolved)")

    # Post consolidated PR comments for body comments
    if body_comments_by_reviewer:
        total_body = sum(len(c) for c in body_comments_by_reviewer.values())
        eprint(f"\nPosting consolidated replies for {total_body} body comment(s)...")
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
            elif comment_type == "nitpick_comment":
                nitpick_count += 1
            elif comment_type == "duplicate_comment":
                duplicate_count += 1

        body_comment_failed = total_body - len(body_updates)
        if body_comment_failed > 0:
            failed_count += body_comment_failed

    # Apply all JSON updates atomically
    apply_updates_to_json(json_path_obj, updates)

    # Print summary
    total_resolved = addressed_count + skipped_count
    total_processed = total_resolved + replied_not_resolved_count + outside_diff_count + nitpick_count + duplicate_count
    eprint("")
    eprint("=== Summary ===")
    eprint(f"Processed {total_processed} threads")
    eprint(f"  Resolved: {total_resolved} ({addressed_count} addressed, {skipped_count} skipped)")

    if replied_not_resolved_count > 0:
        eprint(f"  Replied only: {replied_not_resolved_count} (human reviews - awaiting reviewer follow-up)")

    if outside_diff_count > 0:
        eprint(f"  Outside-diff: {outside_diff_count} (replied via consolidated PR comment)")

    if nitpick_count > 0:
        eprint(f"  Nitpick: {nitpick_count} (replied via consolidated PR comment)")

    if duplicate_count > 0:
        eprint(f"  Duplicate: {duplicate_count} (replied via consolidated PR comment)")

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
