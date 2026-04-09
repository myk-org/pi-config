"""Fetch unresolved review threads from a PR.

This module fetches ALL unresolved review threads from the current branch's PR
and categorizes them by source (human, qodo, coderabbit).

Output: JSON with metadata and categorized comments saved to /tmp/pi-work/pr-<number>-reviews.json
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# Known AI reviewer usernames
QODO_USERS = ["qodo-code-review", "qodo-code-review[bot]"]
CODERABBIT_USERS = ["coderabbitai", "coderabbitai[bot]"]

# Priority classification keywords
HIGH_PRIORITY_KEYWORDS = re.compile(
    r"(security|vulnerability|critical|bug|error|crash|must|required|breaking|urgent|injection|xss|csrf|auth)",
    re.IGNORECASE,
)
LOW_PRIORITY_KEYWORDS = re.compile(
    r"(style|formatting|typo|nitpick|nit:|minor|optional|cosmetic|whitespace|indentation)",
    re.IGNORECASE,
)

# Track temp files for cleanup
TEMP_FILES: list[Path] = []


def cleanup() -> None:
    """Remove tracked temp files and any orphaned .new files from atomic updates."""
    for f in TEMP_FILES:
        try:
            f.unlink(missing_ok=True)
            Path(str(f) + ".new").unlink(missing_ok=True)
        except OSError:
            pass


def print_stderr(msg: str) -> None:
    """Print message to stderr."""
    print(msg, file=sys.stderr)


def _fallback_body_similarity(body1: str, body2: str) -> float:
    """Calculate word overlap ratio between two bodies using Jaccard similarity."""
    tokens1 = set(re.findall(r"[a-z0-9]+", body1.lower()))
    tokens2 = set(re.findall(r"[a-z0-9]+", body2.lower()))
    if not tokens1 or not tokens2:
        return 0.0

    # Guard against huge bodies (e.g., pasted logs)
    # Sort before truncating for deterministic behavior
    if len(tokens1) > 2000:
        tokens1 = set(sorted(tokens1)[:2000])
    if len(tokens2) > 2000:
        tokens2 = set(sorted(tokens2)[:2000])

    intersection = tokens1 & tokens2
    union = tokens1 | tokens2
    return len(intersection) / len(union)


def _load_review_db() -> tuple[type | None, Any | None]:
    """Try to load ReviewDB from db module."""
    try:
        from myk_pi_tools.db.query import ReviewDB, _body_similarity  # noqa: PLC0415

        return ReviewDB, _body_similarity
    except ImportError:
        return None, None


def check_dependencies() -> None:
    """Check required dependencies."""
    for cmd in ("gh", "git"):
        if shutil.which(cmd) is None:
            print_stderr(f"Error: '{cmd}' is required but not installed.")
            sys.exit(1)


def parse_pr_url(url: str) -> tuple[str, str, str] | None:
    """Parse a GitHub PR URL into (owner, repo, pr_number).

    Supports formats:
        https://github.com/OWNER/REPO/pull/NUMBER
        https://github.com/OWNER/REPO/pull/NUMBER#pullrequestreview-XXX
        https://github.com/OWNER/REPO/pull/NUMBER#discussion_rXXX

    Returns:
        Tuple of (owner, repo, pr_number) or None if URL doesn't match.
    """
    match = re.match(r"https?://github\.com/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/pull/(\d+)", url)
    if match:
        return match.group(1), match.group(2), match.group(3)
    return None


def _get_upstream_repo() -> str | None:
    """Get upstream remote's owner/repo if configured.

    Returns:
        Repository in 'owner/repo' format, or None.
    """
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "upstream"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None

        url = result.stdout.strip()
        # Match SSH: git@github.com:owner/repo.git
        match = re.match(r"git@github\.com:([^/]+/[^/]+?)(?:\.git)?$", url)
        if match:
            return match.group(1)
        # Match SSH URL: ssh://git@github.com/owner/repo.git
        match = re.match(r"ssh://git@github\.com/([^/]+/[^/]+?)(?:\.git)?$", url)
        if match:
            return match.group(1)
        # Match HTTPS: https://github.com/owner/repo.git
        match = re.match(r"https?://github\.com/([^/]+/[^/]+?)(?:\.git)?$", url)
        if match:
            return match.group(1)
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def get_pr_info(pr_url: str = "") -> tuple[str, str, str]:
    """Get PR info using gh CLI.

    Args:
        pr_url: Optional PR URL or string that may contain a GitHub PR URL.
            If a valid PR URL is found, owner/repo/number are extracted directly.

    Returns:
        Tuple of (owner, repo, pr_number)
    """
    # Try to extract PR info from URL first
    if pr_url:
        parsed = parse_pr_url(pr_url)
        if parsed:
            return parsed
        print_stderr(f"Warning: '{pr_url}' did not match a GitHub PR URL pattern, falling back to branch detection")

    # Get current branch
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            print_stderr("Error: Could not get current branch")
            sys.exit(1)
        current_branch = result.stdout.strip()
        if current_branch == "HEAD":
            print_stderr("Error: Detached HEAD; cannot infer PR from branch. Check out a branch with an open PR.")
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print_stderr("Error: git command timed out")
        sys.exit(1)

    # Try to find PR for current branch
    # First try default repo (origin), then upstream if available
    repos_to_try: list[str | None] = [None]  # None = default (origin)
    upstream_repo = _get_upstream_repo()
    if upstream_repo:
        repos_to_try.append(upstream_repo)

    pr_number: str | None = None
    matched_repo: str | None = None

    for target_repo in repos_to_try:
        cmd = ["gh", "pr", "view", current_branch, "--json", "number", "--jq", ".number"]
        if target_repo:
            cmd.extend(["-R", target_repo])

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode == 0 and result.stdout.strip():
                pr_number = result.stdout.strip()
                matched_repo = target_repo
                if target_repo:
                    print_stderr(f"Found PR #{pr_number} on upstream ({target_repo})")
                break
        except subprocess.TimeoutExpired:
            continue

    if pr_number is None:
        tried = "origin"
        if upstream_repo:
            tried += f" and upstream ({upstream_repo})"
        print_stderr(f"Error: No PR found for branch '{current_branch}' on {tried}")
        sys.exit(1)

    # Get repository info
    if matched_repo:
        # We already know the repo from the -R flag
        parts = matched_repo.split("/")
        if len(parts) == 2:
            return parts[0], parts[1], pr_number
        print_stderr(f"Error: Unexpected repo format from upstream: '{matched_repo}'")
        sys.exit(1)

    # Fall back to gh repo view for the default repo
    try:
        result = subprocess.run(
            ["gh", "repo", "view", "--json", "owner,name", "-q", '.owner.login + "/" + .name'],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            print_stderr("Error: Could not get repository information")
            sys.exit(1)
        repo_full_name = result.stdout.strip()
    except subprocess.TimeoutExpired:
        print_stderr("Error: gh repo view timed out")
        sys.exit(1)

    owner_repo = repo_full_name.split("/")
    if len(owner_repo) != 2:
        print_stderr(f"Error: Could not parse owner/repo from: '{repo_full_name}'")
        sys.exit(1)

    owner, repo = owner_repo
    return owner, repo, pr_number


def detect_source(author: str | None) -> str:
    """Detect source from author login. Returns 'qodo', 'coderabbit', or 'human'."""
    if author is None:
        return "human"

    if author in QODO_USERS:
        return "qodo"

    if author in CODERABBIT_USERS:
        return "coderabbit"

    return "human"


def classify_priority(body: str | None) -> str:
    """Classify priority from comment body. Returns 'HIGH', 'MEDIUM', or 'LOW'."""
    if body is None:
        return "MEDIUM"

    # HIGH: security, bugs, critical issues
    if HIGH_PRIORITY_KEYWORDS.search(body):
        return "HIGH"

    # LOW: style, formatting, minor
    if LOW_PRIORITY_KEYWORDS.search(body):
        return "LOW"

    # MEDIUM: improvements, suggestions (or default)
    return "MEDIUM"


def run_gh_graphql(query: str, variables: dict[str, Any]) -> dict[str, Any] | None:
    """Run a GraphQL query via gh api graphql. Returns parsed JSON or None on error."""
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
        print_stderr("Error: GraphQL query timed out after 120 seconds")
        return None

    if result.returncode != 0:
        if result.stderr:
            print_stderr(f"Warning: GraphQL query failed: {result.stderr.strip()}")
        return None

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    return data


def run_gh_api(endpoint: str, *, paginate: bool = False) -> Any | None:
    """Run a REST API call via gh api. Returns parsed JSON or None on error."""
    cmd = ["gh", "api"]
    if paginate:
        cmd.extend(["--paginate", "--slurp"])
    cmd.append(endpoint)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print_stderr(f"Error: API call to {endpoint} timed out after 120 seconds")
        return None

    if result.returncode != 0:
        if result.stderr:
            print_stderr(f"Warning: API call to {endpoint} failed: {result.stderr.strip()}")
        return None

    try:
        data = json.loads(result.stdout)
        # With --slurp, paginated results are wrapped in an outer array
        # Flatten nested arrays for consistency
        if paginate and isinstance(data, list):
            merged = []
            for item in data:
                if isinstance(item, list):
                    merged.extend(item)
                else:
                    merged.append(item)
            return merged
        return data
    except json.JSONDecodeError as e:
        print_stderr(f"Error parsing JSON from gh api: {e}")
        return None


def fetch_unresolved_threads(owner: str, repo: str, pr_number: str) -> list[dict[str, Any]]:
    """Fetch all unresolved review threads using paginated GraphQL."""
    all_threads: list[dict[str, Any]] = []
    cursor: str | None = None
    has_next_page = True
    page_count = 0

    query_first = """
        query($owner: String!, $repo: String!, $pr: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $pr) {
                    reviewThreads(first: 100) {
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                        nodes {
                            id
                            isResolved
                            comments(first: 100) {
                                nodes {
                                    id
                                    databaseId
                                    author { login }
                                    path
                                    line
                                    body
                                    createdAt
                                }
                            }
                        }
                    }
                }
            }
        }
    """

    query_with_cursor = """
        query($owner: String!, $repo: String!, $pr: Int!, $cursor: String!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $pr) {
                    reviewThreads(first: 100, after: $cursor) {
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                        nodes {
                            id
                            isResolved
                            comments(first: 100) {
                                nodes {
                                    id
                                    databaseId
                                    author { login }
                                    path
                                    line
                                    body
                                    createdAt
                                }
                            }
                        }
                    }
                }
            }
        }
    """

    while has_next_page:
        page_count += 1

        if cursor is None:
            variables = {"owner": owner, "repo": repo, "pr": int(pr_number)}
            raw_result = run_gh_graphql(query_first, variables)
        else:
            variables = {"owner": owner, "repo": repo, "pr": int(pr_number), "cursor": cursor}
            raw_result = run_gh_graphql(query_with_cursor, variables)

        if raw_result is None:
            print_stderr(f"Warning: Could not fetch unresolved threads (page {page_count})")
            break

        # Check for GraphQL errors
        if raw_result.get("errors"):
            error_msg = raw_result["errors"][0].get("message", "Unknown error")
            print_stderr(f"Warning: GraphQL errors while fetching review threads (page {page_count}): {error_msg}")
            break

        # Extract data
        try:
            review_threads = raw_result["data"]["repository"]["pullRequest"]["reviewThreads"]
            page_info = review_threads["pageInfo"]
            nodes = review_threads.get("nodes") or []
        except (KeyError, TypeError):
            print_stderr(f"Warning: Unexpected GraphQL response structure (page {page_count})")
            break

        has_next_page = page_info.get("hasNextPage", False)
        cursor = page_info.get("endCursor")

        all_threads.extend(nodes)

        if has_next_page:
            print_stderr(f"Fetching page {page_count + 1} of review threads...")

    if page_count > 1:
        print_stderr(f"Fetched {page_count} pages of review threads")

    # Filter unresolved threads and extract first comment details with replies
    result = []
    for thread in all_threads:
        if thread.get("isResolved", False):
            continue

        comments = thread.get("comments", {}).get("nodes") or []
        if not comments:
            continue

        first_comment = comments[0]
        rest_comments = comments[1:]

        thread_data = {
            "thread_id": thread.get("id"),
            "node_id": first_comment.get("id"),
            "comment_id": first_comment.get("databaseId"),
            "author": first_comment.get("author", {}).get("login") if first_comment.get("author") else None,
            "path": first_comment.get("path"),
            "line": first_comment.get("line"),
            "body": first_comment.get("body", ""),
            "replies": [
                {
                    "author": c.get("author", {}).get("login") if c.get("author") else None,
                    "body": c.get("body", ""),
                    "created_at": c.get("createdAt"),
                }
                for c in rest_comments
            ],
        }
        result.append(thread_data)

    return result


def fetch_specific_discussion(owner: str, repo: str, pr_number: str, discussion_id: str) -> list[dict[str, Any]]:
    """Fetch a specific review thread by discussion ID."""
    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/comments/{discussion_id}"
    result = run_gh_api(endpoint)

    if result is None:
        print_stderr(f"Warning: Could not fetch discussion {discussion_id}")
        return []

    return [
        {
            "thread_id": None,
            "node_id": result.get("node_id"),
            "comment_id": result.get("id"),
            "author": result.get("user", {}).get("login") if result.get("user") else None,
            "path": result.get("path"),
            "line": result.get("line"),
            "body": result.get("body"),
        }
    ]


def fetch_review_comments(owner: str, repo: str, pr_number: str, review_id: str) -> list[dict[str, Any]]:
    """Fetch inline comments from a specific PR review."""
    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews/{review_id}/comments"
    result = run_gh_api(endpoint, paginate=True)

    if result is None:
        print_stderr(f"Warning: Could not fetch review {review_id} comments")
        return []

    return [
        {
            "thread_id": None,
            "node_id": item.get("node_id"),
            "comment_id": item.get("id"),
            "author": item.get("user", {}).get("login") if item.get("user") else None,
            "path": item.get("path"),
            "line": item.get("line"),
            "body": item.get("body"),
        }
        for item in result
    ]


def _build_body_comment_threads(
    parsed: dict[str, list[dict[str, Any]]],
    review_id: int,
    node_id: str | None,
    author: str | None,
) -> list[dict[str, Any]]:
    """Convert parsed body comments into thread-like dicts."""
    threads: list[dict[str, Any]] = []
    for section_key, thread_type in (
        ("outside_diff", "outside_diff_comment"),
        ("nitpick", "nitpick_comment"),
        ("duplicate", "duplicate_comment"),
    ):
        for idx, comment in enumerate(parsed.get(section_key, [])):
            path = comment.get("path")
            line = comment.get("line")
            body = comment.get("body")
            if path is None or line is None or body is None:
                print_stderr(f"Warning: Skipping malformed {thread_type} entry (missing path/line/body)")
                continue

            try:
                line_int = int(line)
            except (TypeError, ValueError):
                continue

            end_line = comment.get("end_line")
            end_line_int: int | None = None
            if end_line is not None:
                try:
                    end_line_int = int(end_line)
                except (TypeError, ValueError):
                    pass

            threads.append({
                "thread_id": None,
                "node_id": node_id,
                "comment_id": review_id,
                "author": author,
                "path": path,
                "line": line_int,
                "end_line": end_line_int,
                "body": body,
                "category": comment.get("category", ""),
                "severity": comment.get("severity", ""),
                "replies": [],
                "type": thread_type,
                "review_id": review_id,
                "suggestion_index": idx,
            })
    return threads


def fetch_coderabbit_body_comments(owner: str, repo: str, pr_number: str) -> list[dict[str, Any]]:
    """Fetch CodeRabbit body-embedded comments from review bodies.

    CodeRabbit embeds some comments in the review body text (not as inline threads)
    when they reference code outside the PR diff range or are nitpick-level suggestions.
    This function fetches all CodeRabbit reviews and parses their bodies for these comments.

    Returns:
        List of thread-like dicts, one per parsed comment.
    """
    from myk_pi_tools.reviews.coderabbit_parser import parse_review_body_comments  # noqa: PLC0415

    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews?per_page=100"
    reviews = run_gh_api(endpoint, paginate=True)

    if reviews is None:
        print_stderr("Warning: Could not fetch PR reviews")
        return []

    if not isinstance(reviews, list):
        print_stderr("Warning: Unexpected PR reviews response shape (expected list)")
        return []

    results: list[dict[str, Any]] = []
    for review in reviews:
        author = review.get("user", {}).get("login") if review.get("user") else None
        if author not in CODERABBIT_USERS:
            continue

        body = review.get("body", "")
        if not body:
            continue

        parsed = parse_review_body_comments(body)

        review_id = review.get("id")
        if review_id is None:
            continue

        try:
            review_id_int = int(review_id)
        except (TypeError, ValueError):
            continue

        node_id = review.get("node_id")

        results.extend(_build_body_comment_threads(parsed, review_id_int, node_id, author))

    return results


# Keep old name as alias for backward compatibility
fetch_coderabbit_outside_diff_comments = fetch_coderabbit_body_comments


def process_and_categorize(threads: list[dict[str, Any]], owner: str, repo: str) -> dict[str, list[dict[str, Any]]]:
    """Process threads: add source and priority, categorize, and auto-skip previously dismissed."""
    human: list[dict[str, Any]] = []
    qodo: list[dict[str, Any]] = []
    coderabbit: list[dict[str, Any]] = []

    # Lazily load ReviewDB and instantiate once outside the loop for performance
    ReviewDB, sim_fn = _load_review_db()
    similarity = sim_fn or _fallback_body_similarity  # Use imported or fallback
    db = None
    if ReviewDB:
        try:
            db = ReviewDB(db_path=None)  # Auto-detect path
        except Exception as e:
            print_stderr(f"Warning: Failed to initialize ReviewDB: {e}")

    # Preload and index dismissed comments once per run for performance
    dismissed_by_path: dict[str, list[dict[str, Any]]] = {}
    dismissed_by_comment_id: dict[int, list[dict[str, Any]]] = {}
    if db:
        try:
            for c in db.get_dismissed_comments(owner, repo):
                b = (c.get("body") or "").strip()
                if not b:
                    continue
                p = (c.get("path") or "").strip()
                if p:
                    dismissed_by_path.setdefault(p, []).append(c)
                cid = c.get("comment_id")
                if cid is not None:
                    try:
                        cid = int(cid)
                    except (TypeError, ValueError):
                        pass
                    else:
                        dismissed_by_comment_id.setdefault(cid, []).append(c)
        except Exception as e:
            print_stderr(f"Warning: Failed to preload dismissed comments: {e}")
            dismissed_by_path = {}
            dismissed_by_comment_id = {}

    for thread in threads:
        author = thread.get("author")
        body = thread.get("body")

        source = detect_source(author)
        priority = classify_priority(body)

        enriched = {
            **thread,
            "source": source,
            "priority": priority,
            "reply": thread.get("reply"),
            "status": thread.get("status", "pending"),
        }

        # Check for previously dismissed similar comment (only if status is pending)
        if (dismissed_by_path or dismissed_by_comment_id) and enriched.get("status") == "pending":
            path = (thread.get("path") or "").strip()
            thread_body = (thread.get("body") or "").strip()
            if thread_body:
                try:
                    # Build candidate list: try path first, then comment_id
                    candidates: list[dict[str, Any]] = []
                    if path:
                        candidates = dismissed_by_path.get(path, [])
                    if not candidates:
                        # For pathless items (outside_diff_comments),
                        # match by comment_id instead
                        cid = thread.get("comment_id")
                        if cid is None:
                            cid = thread.get("issue_comment_id")
                        if cid is not None:
                            try:
                                cid = int(cid)
                            except (TypeError, ValueError):
                                cid = None
                        if cid is not None:
                            candidates = dismissed_by_comment_id.get(cid, [])

                    # Find best matching dismissed comment
                    if candidates:
                        best = None
                        best_score = 0.0
                        for prev in candidates:
                            prev_body = (prev.get("body") or "").strip()
                            if not prev_body:
                                continue
                            score = similarity(thread_body, prev_body)
                            if score >= 0.6 and score > best_score:
                                best = prev
                                best_score = score
                                if best_score == 1.0:
                                    break

                        if best:
                            reason = (best.get("skip_reason") or best.get("reply") or "").strip()
                            if reason:
                                original_status = best.get("status", "skipped")
                                enriched["status"] = "skipped"
                                enriched["skip_reason"] = reason
                                enriched["original_status"] = original_status  # Display-only, not persisted to DB
                                enriched["reply"] = f"Auto-skipped ({original_status}): {reason}"
                                enriched["is_auto_skipped"] = True
                except Exception as e:
                    print_stderr(f"Warning: Failed to match dismissed comment: {e}")

        if source == "human":
            human.append(enriched)
        elif source == "qodo":
            qodo.append(enriched)
        else:
            coderabbit.append(enriched)

    return {"human": human, "qodo": qodo, "coderabbit": coderabbit}


def get_thread_key(thread: dict[str, Any]) -> str | None:
    """Generate a unique key for deduplication."""
    # Outside diff comments use review_id + location as composite key (stable across reordering)
    if thread.get("type") == "outside_diff_comment":
        review_id = thread.get("review_id")
        path = thread.get("path")
        line = thread.get("line")
        end_line = thread.get("end_line")
        if review_id is not None and path and line is not None:
            return f"odc:{review_id}:{path}:{line}:{end_line}"

    # Nitpick comments use review_id + location as composite key (stable across reordering)
    if thread.get("type") == "nitpick_comment":
        review_id = thread.get("review_id")
        path = thread.get("path")
        line = thread.get("line")
        end_line = thread.get("end_line")
        if review_id is not None and path and line is not None:
            return f"npc:{review_id}:{path}:{line}:{end_line}"

    # Duplicate comments use review_id + location as composite key
    if thread.get("type") == "duplicate_comment":
        review_id = thread.get("review_id")
        path = thread.get("path")
        line = thread.get("line")
        end_line = thread.get("end_line")
        if review_id is not None and path and line is not None:
            return f"dpc:{review_id}:{path}:{line}:{end_line}"

    thread_id = thread.get("thread_id")
    if thread_id:
        return f"t:{thread_id}"

    node_id = thread.get("node_id")
    if node_id:
        return f"n:{node_id}"

    comment_id = thread.get("comment_id")
    if comment_id is not None:
        return f"c:{comment_id}"

    return None


def merge_threads(all_threads: list[dict[str, Any]], specific_threads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge specific threads with all threads, deduplicating by prioritized keys."""
    if not specific_threads:
        return all_threads

    existing_keys = set()
    for thread in all_threads:
        key = get_thread_key(thread)
        if key:
            existing_keys.add(key)

    merged = list(all_threads)
    for thread in specific_threads:
        key = get_thread_key(thread)
        if key is None:
            print_stderr("Warning: Thread has no identifiers for deduplication")
            merged.append(thread)
        elif key not in existing_keys:
            merged.append(thread)
            existing_keys.add(key)

    return merged


def fetch_review_body(owner: str, repo: str, pr_number: str, review_id: str) -> dict[str, Any] | None:
    """Fetch a single review's metadata (including body) via REST API.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
        review_id: The review ID.

    Returns:
        The review dict from the API, or None on error.
    """
    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews/{review_id}"
    result = run_gh_api(endpoint)
    return result if isinstance(result, dict) else None


def run(review_url: str = "") -> int:
    """Main entry point.

    Args:
        review_url: Optional specific review URL for context.

    Returns:
        Exit code (0 for success, 1 for error).
    """
    try:
        check_dependencies()

        # Get PR info
        print_stderr("Getting PR information...")
        owner, repo, pr_number = get_pr_info(pr_url=review_url)

        print_stderr(f"Repository: {owner}/{repo}, PR: {pr_number}")

        # Ensure output directory exists
        tmp_base = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
        out_dir = tmp_base / "pi-work"
        out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            out_dir.chmod(0o700)
        except OSError as e:
            print_stderr(f"Warning: unable to set permissions on {out_dir}: {e}")

        json_path = out_dir / f"pr-{pr_number}-reviews.json"

        # Fetch all unresolved threads
        print_stderr("Fetching unresolved review threads...")
        all_threads = fetch_unresolved_threads(owner, repo, pr_number)
        print_stderr(f"Found {len(all_threads)} unresolved thread(s)")

        # Fetch CodeRabbit body-embedded comments from review bodies
        print_stderr("Fetching CodeRabbit body-embedded comments...")
        body_comment_threads = fetch_coderabbit_body_comments(owner, repo, pr_number)
        if body_comment_threads:
            print_stderr(f"Found {len(body_comment_threads)} body-embedded comment(s)")
            all_threads = merge_threads(all_threads, body_comment_threads)

        # If review URL provided, also fetch specific thread(s)
        specific_threads: list[dict[str, Any]] = []
        if review_url:
            # Match pullrequestreview-NNN
            match = re.search(r"pullrequestreview-(\d+)", review_url)
            if match:
                review_id = match.group(1)
                print_stderr(f"Fetching comments from PR review {review_id}...")
                specific_threads = fetch_review_comments(owner, repo, pr_number, review_id)
                print_stderr(f"Found {len(specific_threads)} inline comment(s) from review {review_id}")

                # Also fetch body-embedded comments for CodeRabbit reviews
                try:
                    review_meta = fetch_review_body(owner, repo, pr_number, review_id)
                except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
                    print_stderr(f"Warning: Failed to fetch review body for {review_id}: {exc}")
                    review_meta = None
                if review_meta:
                    review_author = review_meta.get("user", {}).get("login") if review_meta.get("user") else None
                    if review_author in CODERABBIT_USERS:
                        from myk_pi_tools.reviews.coderabbit_parser import (  # noqa: PLC0415
                            parse_review_body_comments,
                        )

                        review_body = review_meta.get("body", "")
                        if review_body:
                            parsed = parse_review_body_comments(review_body)
                            try:
                                review_id_int = int(review_id)
                            except (TypeError, ValueError):
                                review_id_int = None
                            if review_id_int is not None:
                                node_id = review_meta.get("node_id")
                                body_threads = _build_body_comment_threads(
                                    parsed,
                                    review_id_int,
                                    node_id,
                                    review_author,
                                )
                                if body_threads:
                                    msg = f"Found {len(body_threads)} body-embedded comment(s) from review {review_id}"
                                    print_stderr(msg)
                                    specific_threads = merge_threads(specific_threads, body_threads)

            # Match discussion_rNNN
            elif match := re.search(r"discussion_r(\d+)", review_url):
                discussion_id = match.group(1)
                print_stderr(f"Fetching discussion {discussion_id}...")
                specific_threads = fetch_specific_discussion(owner, repo, pr_number, discussion_id)
                print_stderr(f"Found {len(specific_threads)} comment(s) from discussion {discussion_id}")

            # Match raw numeric review ID
            elif review_url.isdigit():
                review_id = review_url
                print_stderr(f"Fetching comments from PR review {review_id} (raw ID)...")
                specific_threads = fetch_review_comments(owner, repo, pr_number, review_id)
                print_stderr(f"Found {len(specific_threads)} comment(s) from review {review_id}")

            else:
                print_stderr(f"Warning: Unrecognized URL fragment in: {review_url}")

        # Merge specific threads with all threads, deduplicating
        if specific_threads:
            all_threads = merge_threads(all_threads, specific_threads)

        # Process and categorize threads
        print_stderr("Categorizing threads by source...")
        categorized = process_and_categorize(all_threads, owner, repo)

        # Build final output
        final_output = {
            "metadata": {
                "owner": owner,
                "repo": repo,
                "pr_number": int(pr_number),
                "json_path": str(json_path),
            },
            "human": categorized["human"],
            "qodo": categorized["qodo"],
            "coderabbit": categorized["coderabbit"],
        }

        # Save to file atomically
        fd, tmp_json_path = tempfile.mkstemp(
            prefix=f"pr-{pr_number}-reviews.json.",
            dir=str(out_dir),
        )
        tmp_path = Path(tmp_json_path)
        TEMP_FILES.append(tmp_path)

        try:
            with os.fdopen(fd, "w") as f:
                json.dump(final_output, f, indent=2)
            os.replace(tmp_path, json_path)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

        print_stderr(f"Saved to: {json_path}")

        # Count by category
        human_count = len(final_output["human"])
        qodo_count = len(final_output["qodo"])
        coderabbit_count = len(final_output["coderabbit"])
        print_stderr(f"Categories: human={human_count}, qodo={qodo_count}, coderabbit={coderabbit_count}")

        # Count auto-skipped comments
        auto_skipped = sum(1 for cat in categorized.values() for c in cat if c.get("is_auto_skipped"))
        if auto_skipped:
            print_stderr(f"Auto-skipped {auto_skipped} previously dismissed comment(s)")

        # Output to stdout
        print(json.dumps(final_output, indent=2))

        return 0

    finally:
        cleanup()
