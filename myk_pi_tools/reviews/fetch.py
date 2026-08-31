"""Fetch review threads from a PR.

This module fetches review threads from the current branch's PR
(supports resolved/unresolved filtering and user filtering).
and categorizes them by source (human, qodo, coderabbit).

Output: JSON with metadata and categorized comments saved to <output_dir>/pr-<number>-reviews.json
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

from myk_pi_tools.db.query import ReviewDB, _body_similarity
from myk_pi_tools.reviews.coderabbit_parser import parse_review_body_comments
from myk_pi_tools.reviews.qodo_parser import is_qodo_sticky_comment, parse_qodo_sticky_comment
from myk_pi_tools.utils import merge_paginated_json

# Map Qodo finding types to our type field
_QODO_TYPE_MAP = {
    "Bug": "qodo_bug",
    "Rule violation": "qodo_rule_violation",
    "Requirement gap": "qodo_requirement_gap",
    "UX issue": "qodo_ux_issue",
    "Cross-repo conflict": "qodo_cross_repo",
}

# Known AI reviewer usernames
QODO_USERS = ["qodo-code-review", "qodo-code-review[bot]"]

from myk_pi_tools.reviews.constants import QODO_STICKY_TYPES  # noqa: E402 — re-export for backwards compat

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
    return ReviewDB, _body_similarity


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
        cmd.append("--paginate")
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
        # --paginate returns concatenated JSON arrays, merge them
        if paginate:
            return merge_paginated_json(result.stdout)
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        print_stderr(f"Error parsing JSON from gh api: {e}")
        return None


def fetch_review_threads(
    owner: str,
    repo: str,
    pr_number: str,
    include_resolved: bool = False,
    user: str | None = None,
) -> list[dict[str, Any]]:
    """Fetch review threads using paginated GraphQL.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.
        include_resolved: If True, include resolved threads (with is_resolved field).
        user: If set, only return threads where the first comment author matches this username.
    """
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

    # Filter threads and extract first comment details with replies
    result = []
    for thread in all_threads:
        is_resolved = thread.get("isResolved", False)
        if is_resolved and not include_resolved:
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
        if include_resolved:
            thread_data["is_resolved"] = is_resolved
        # Filter by user if specified
        if user and (thread_data.get("author") or "").lower() != user.lower():
            continue

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
        ("major", "major_comment"),
        ("minor", "minor_comment"),
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


# Pattern: Qodo replies to our consolidated comments by quoting them in a blockquote
_QODO_REPLY_QUOTE_RE = re.compile(r"^>\s*(.+)$", re.MULTILINE)
# Match finding title in quoted text: > **Finding Title** or > ### `path:line` (type) — Title
_QUOTED_FINDING_TITLE_RE = re.compile(r"\*\*([^*]+)\*\*")
# Captures: group(1)=path:line, group(2)=title
_QUOTED_HEADING_FULL_RE = re.compile(r"###\s+`([^`]+)`\s*(?:\([^)]*\))?\s*(?:—|-)\s*(.+)")
# Marker that identifies our consolidated PR comments (posted by review-handler)
_CONSOLIDATED_COMMENT_MARKER = "The following review comments were reviewed"


def fetch_qodo_reply_comments(
    owner: str, repo: str, pr_number: str, *, comments: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """Fetch Qodo replies to our consolidated PR comments.

    Scans issue comments for Qodo bot replies that quote our consolidated
    review posts. Identifies replies by the presence of the consolidated comment
    marker ("The following review comments were reviewed") in the quoted text.

    Each reply is returned as a thread-like dict with type ``qodo_reply`` and
    linkage to the original finding via ``quoted_location`` (path:line) and
    ``quoted_title``. These are used both for enrichment (attaching
    ``qodo_response`` to existing findings) and as first-class threads in
    the categorized output.

    Args:
        comments: Pre-fetched issue comments. If None, fetches from API.

    Returns:
        List of thread-like dicts with keys: thread_id, node_id, comment_id,
        author, path, line, body, source, type, quoted_location, quoted_title,
        qodo_response.
    """
    if comments is None:
        endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
        comments = run_gh_api(endpoint, paginate=True)

    if comments is None or not isinstance(comments, list):
        return []

    results: list[dict[str, Any]] = []

    for comment in comments:
        author = comment.get("user", {}).get("login") if comment.get("user") else None
        if author not in ("qodo-code-review[bot]", "qodo-code-review"):
            continue

        body = comment.get("body", "")
        # Skip sticky comments — we only want reply comments
        if is_qodo_sticky_comment(body):
            continue

        quoted_lines = _QODO_REPLY_QUOTE_RE.findall(body)
        if not quoted_lines:
            continue

        # Reconstruct quoted text to extract the finding title
        quoted_text = "\n".join(quoted_lines)

        # Must quote our consolidated comment marker — this is the definitive
        # identifier, not the bot mention (GitHub strips @ from quoted mentions)
        if _CONSOLIDATED_COMMENT_MARKER not in quoted_text:
            continue

        # Extract path:line and title from quoted heading
        # Heading format: ### `path:line` (type) — title
        heading_match = _QUOTED_HEADING_FULL_RE.search(quoted_text)
        quoted_location = ""
        quoted_title = ""
        if heading_match:
            quoted_location = heading_match.group(1).strip()  # e.g. "fetch.py:803"
            quoted_title = heading_match.group(2).strip()
        else:
            # Fallback: try bold title
            title_match = _QUOTED_FINDING_TITLE_RE.search(quoted_text)
            quoted_title = title_match.group(1).strip() if title_match else ""

        # Extract Qodo's response: non-quoted lines (strip leading/trailing blank lines)
        response_lines = []
        for line in body.split("\n"):
            stripped = line.strip()
            if not stripped.startswith(">"):
                response_lines.append(line)
        qodo_response = "\n".join(response_lines).strip()

        if qodo_response:
            # Parse path and line from quoted_location (e.g., "fetch.py:803")
            reply_path = ""
            reply_line = None
            if quoted_location:
                parts = quoted_location.rsplit(":", 1)
                reply_path = parts[0]
                if len(parts) == 2:
                    try:
                        reply_line = int(parts[1])
                    except (ValueError, TypeError):
                        pass

            results.append({
                "thread_id": None,
                "node_id": None,
                "comment_id": comment.get("id"),
                "author": author,
                "path": reply_path,
                "line": reply_line,
                "body": qodo_response,
                "source": "qodo",
                "type": "qodo_reply",
                "priority": "LOW",
                "reply": None,
                "status": "pending",
                "quoted_location": quoted_location,
                "quoted_title": quoted_title,
                "qodo_response": qodo_response,
            })

    return results


def fetch_qodo_sticky_findings(
    owner: str, repo: str, pr_number: str, *, comments: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """Fetch unresolved findings from Qodo's sticky summary comment.

    Args:
        comments: Pre-fetched issue comments. If None, fetches from API.

    Returns thread-like dicts for each unresolved finding.
    """
    if comments is None:
        endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
        comments = run_gh_api(endpoint, paginate=True)

    if comments is None or not isinstance(comments, list):
        return []

    results: list[dict[str, Any]] = []

    for comment in comments:
        author = comment.get("user", {}).get("login") if comment.get("user") else None
        if author not in ("qodo-code-review[bot]", "qodo-code-review"):
            continue

        body = comment.get("body", "")
        if not is_qodo_sticky_comment(body):
            continue

        comment_id = comment.get("id")
        findings = parse_qodo_sticky_comment(body)

        for finding in findings:
            thread_data = {
                "thread_id": None,
                "node_id": None,
                "comment_id": comment_id,
                "author": author,
                "path": finding.get("path", ""),
                "line": finding.get("line"),
                "end_line": finding.get("end_line"),
                "body": f"**{finding.get('title', '')}**\n\n{finding.get('description', '')}",
                "quality_label": finding.get("category", ""),
                "type": _QODO_TYPE_MAP.get(finding.get("finding_type", ""), "qodo_finding"),
                "source": "qodo",
                "priority": "HIGH"
                if finding.get("finding_type") in ("Bug", "Rule violation", "Cross-repo conflict")
                else "MEDIUM",
                "reply": None,
                "status": "pending",
                "code_diff": finding.get("code_diff", ""),
                "evidence": finding.get("evidence", ""),
                "evidence_refs": finding.get("evidence_refs", []),
                "agent_prompt": finding.get("agent_prompt", ""),
            }
            results.append(thread_data)

    return results


def _enrich_findings_with_qodo_replies(findings: list[dict[str, Any]], replies: list[dict[str, Any]]) -> None:
    """Enrich qodo findings with qodo_response from matching reply comments.

    Matches replies to findings using path:line from the quoted heading
    (primary) or title comparison (fallback). Modifies findings in-place.
    Marks matched replies with _matched=True.

    """
    for finding in findings:
        if not finding.get("already_replied"):
            continue

        finding["_enrichment_checked"] = True

        finding_path = finding.get("path") or ""
        finding_line = finding.get("line")
        if finding_path and finding_line:
            finding_loc = f"{finding_path}:{finding_line}"
        elif finding_path:
            finding_loc = finding_path
        else:
            finding_loc = ""

        for reply in replies:
            matched = False
            reply_loc = reply.get("quoted_location") or ""

            # Primary: match by path:line from the quoted heading
            if reply_loc and finding_loc and reply_loc == finding_loc:
                matched = True
            elif not matched and reply.get("quoted_title"):
                # Fallback: title prefix match (titles may be truncated to 100 chars)
                finding_title = _extract_sticky_title(finding.get("body", ""))
                quoted_title = reply.get("quoted_title", "").strip().lower()
                if finding_title and quoted_title and len(quoted_title) > 10:
                    if len(quoted_title) == len(finding_title):
                        matched = quoted_title == finding_title
                    else:
                        shorter = min(quoted_title, finding_title, key=len)
                        longer = max(quoted_title, finding_title, key=len)
                        matched = longer.startswith(shorter)

            if matched:
                finding["qodo_response"] = reply["qodo_response"]
                break

    return None


def auto_skip_replied_findings(findings: list[dict[str, Any]]) -> int:
    """Auto-skip already-replied Qodo thread comments where Qodo didn't push back.

    Prevents re-posting duplicate consolidated comments for thread findings we already
    replied to and Qodo silently accepted (no qodo_response). Runs in all modes
    (not just autoqodo) — already-replied findings without pushback should never
    be re-processed regardless of invocation mode.

    Sticky findings (qodo_bug, qodo_finding, etc.) are NEVER auto-skipped — they
    persist in Qodo's summary comment until explicitly dismissed via ask-qodo.
    Auto-skipping stickies causes infinite poll loops.

    Only skips findings that passed through enrichment (_enrichment_checked=True),
    ensuring the enrichment step had a chance to set qodo_response if a reply existed.
    Findings WITH qodo_response remain actionable — Qodo pushed back and needs a re-fix.

    Returns the count of findings that were auto-skipped.
    """
    count = 0
    for finding in findings:
        # Never auto-skip sticky findings — they persist until dismissed via ask-qodo
        is_sticky = not finding.get("thread_id") and finding.get("type") in QODO_STICKY_TYPES
        if (
            not is_sticky
            and finding.get("already_replied")
            and finding.get("_enrichment_checked")
            and not finding.get("qodo_response")
            and not finding.get("is_auto_skipped")
            and finding.get("status") == "pending"
        ):
            finding["is_auto_skipped"] = True
            finding["status"] = "skipped"
            finding["skip_reason"] = "Already replied, Qodo did not push back"
            count += 1
    if count:
        print_stderr(f"Auto-skipped {count} previously replied finding(s) (Qodo silent acceptance)")
    return count


def process_and_categorize(
    threads: list[dict[str, Any]], owner: str, repo: str, pr_number: int | None = None
) -> dict[str, list[dict[str, Any]]]:
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
    dismissed_by_key: dict[str, dict[str, Any]] = {}
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
                # Index sticky findings by thread key for exact matching
                key = get_thread_key(c)
                if key:
                    dismissed_by_key[key] = c
        except Exception as e:
            print_stderr(f"Warning: Failed to preload dismissed comments: {e}")
            dismissed_by_path = {}
            dismissed_by_comment_id = {}
            dismissed_by_key = {}

    # Preload already-replied Qodo sticky findings for dedup (exact match only)
    # Maps (comment_id, body, code_diff) -> DB record (includes reply text)
    replied_sticky: dict[tuple[int, str, str], dict[str, Any]] = {}
    if db and pr_number:
        try:
            for c in db.get_replied_sticky_findings(owner, repo, pr_number):
                cid = c.get("comment_id")
                body = c.get("body") or ""
                code_diff = c.get("code_diff") or ""
                if cid is not None:
                    rs_key = (int(cid), body, code_diff)
                    existing = replied_sticky.get(rs_key)
                    if existing is None:
                        replied_sticky[rs_key] = c
                    else:
                        # Prefer records with meaningful replies
                        existing_reply = existing.get("reply") or ""
                        new_reply = c.get("reply") or ""
                        if "Already replied" in existing_reply and "Already replied" not in new_reply and new_reply:
                            replied_sticky[rs_key] = c
        except Exception as e:
            print_stderr(f"Warning: Failed to preload replied sticky findings: {e}")

    for thread in threads:
        author = thread.get("author")
        body = thread.get("body")

        source = thread.get("source") or detect_source(author)

        # Preserve pre-computed priority (e.g., from Qodo sticky findings)
        existing_priority = thread.get("priority")
        if existing_priority in ("HIGH", "MEDIUM", "LOW"):
            priority = existing_priority
        else:
            priority = classify_priority(body)

        enriched = {
            **thread,
            "source": source,
            "priority": priority,
            "reply": thread.get("reply"),
            "status": thread.get("status", "pending"),
            "quality_label": thread.get("quality_label"),
        }

        # Check if this Qodo sticky finding was already replied to (exact match)
        if source == "qodo" and thread.get("thread_id") is None and replied_sticky:
            cid = thread.get("comment_id")
            thread_body = thread.get("body") or ""
            thread_code_diff = thread.get("code_diff") or ""
            if cid is not None:
                sticky_key = (int(cid), thread_body, thread_code_diff)
                if sticky_key in replied_sticky:
                    enriched["already_replied"] = True
                    db_record = replied_sticky[sticky_key]
                    enriched["previous_reply"] = db_record.get("reply") or ""

        # qodo_reply items are Qodo's responses to our consolidated comments.
        # They're informational context, not findings to fix — auto-skip them.
        if source == "qodo" and enriched.get("type") == "qodo_reply":
            enriched["is_auto_skipped"] = True
            enriched["status"] = "skipped"
            enriched["reply"] = "Qodo reply — informational context, not a finding to fix"

        # Check for previously dismissed similar comment (only if status is pending)
        # Qodo sticky findings are not auto-skipped by the dismissed-comment check below —
        # dedup for already-replied sticky findings is handled separately by
        # auto_skip_replied_findings() post-enrichment.
        if (
            source != "qodo"
            and (dismissed_by_path or dismissed_by_comment_id or dismissed_by_key)
            and enriched.get("status") == "pending"
        ):
            # Fast path: exact match by thread key (works for sticky findings)
            thread_key = get_thread_key(enriched)
            if thread_key and thread_key in dismissed_by_key:
                prev = dismissed_by_key[thread_key]
                reason = (prev.get("reply") or prev.get("skip_reason") or "").strip()
                if reason:
                    original_status = prev.get("status", "skipped")
                    enriched["status"] = "skipped"
                    enriched["skip_reason"] = reason
                    enriched["original_status"] = original_status
                    enriched["reply"] = f"Auto-skipped ({original_status}): {reason}"
                    enriched["is_auto_skipped"] = True

            if not enriched.get("is_auto_skipped"):
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


def _extract_sticky_title(body: str) -> str:
    """Extract the **title** from a Qodo sticky finding body for stable hashing."""
    # Match **Title text** at the start (after optional HTML/numbering)
    m = re.search(r"\*\*([^*]+)\*\*", body[:200])
    if m:
        return m.group(1).strip().lower()
    # Fallback: first non-empty line, stripped of HTML/markdown
    # Strip HTML once, then scan lines
    plain = BeautifulSoup(body, "html.parser").get_text()
    for line in plain.split("\n"):
        clean = line.strip()
        clean = clean.replace("**", "").replace("*", "").replace("`", "").strip()
        if clean and len(clean) > 5:
            return clean[:60].lower()
    return body[:60].lower()


def get_thread_key(thread: dict[str, Any]) -> str | None:
    """Generate a unique key for deduplication."""
    # Qodo sticky findings use type + path + normalized title as composite key
    # Line number excluded — shifts after rebases, causing false mismatches
    # Type included — prevents cross-type collisions on same file+title
    qodo_type = thread.get("type")
    if qodo_type in QODO_STICKY_TYPES:
        path = thread.get("path")
        title = _extract_sticky_title(thread.get("body", ""))
        if path and title:
            material = f"{qodo_type}:{title}"
            stable = hashlib.sha256(material.encode()).hexdigest()[:12]
            return f"qs:{path}:{stable}"

    # Outside diff comments use review_id + location as composite key (stable across reordering)
    if thread.get("type") == "outside_diff_comment":
        review_id = thread.get("review_id")
        path = thread.get("path")
        line = thread.get("line")
        end_line = thread.get("end_line")
        if review_id is not None and path and line is not None:
            return f"odc:{review_id}:{path}:{line}:{end_line}"

    # Major comments use review_id + location as composite key (stable across reordering)
    if thread.get("type") == "major_comment":
        review_id = thread.get("review_id")
        path = thread.get("path")
        line = thread.get("line")
        end_line = thread.get("end_line")
        if review_id is not None and path and line is not None:
            return f"mjc:{review_id}:{path}:{line}:{end_line}"

    # Minor comments use review_id + location as composite key (stable across reordering)
    if thread.get("type") == "minor_comment":
        review_id = thread.get("review_id")
        path = thread.get("path")
        line = thread.get("line")
        end_line = thread.get("end_line")
        if review_id is not None and path and line is not None:
            return f"mnc:{review_id}:{path}:{line}:{end_line}"

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


def is_qodo_approved(owner: str, repo: str, pr_number: str, comments: list | None = None) -> dict | None:
    """Check if Qodo has approved the PR.

    Returns a summary dict if approved, None if not approved.

    Approved when:
    1. Sticky comment has 0 unresolved findings (literal 0 from Qodo)
    2. Sticky has at least one resolved/dismissed finding (not empty)
    3. Sticky updated_at is AFTER PR head commit date (Qodo finished reviewing latest)

    Returns dict with keys:
    - approved: True
    - reason: str ("all_resolved")
    - total_findings: int (total in sticky, resolved + unresolved)
    - resolved_count: int (resolved/dismissed by Qodo)
    - unresolved_count: int (0 when approved)
    """
    from myk_pi_tools.reviews.qodo_parser import is_qodo_sticky_comment, parse_qodo_sticky_comment

    # Get PR head SHA
    pr_endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}"
    pr_data = run_gh_api(pr_endpoint)
    if not isinstance(pr_data, dict):
        return None
    head_sha = pr_data.get("head", {}).get("sha", "")
    if not head_sha:
        return None

    # Get commit date for PR HEAD
    commit_endpoint = f"/repos/{owner}/{repo}/commits/{head_sha}"
    commit_data = run_gh_api(commit_endpoint)
    if not isinstance(commit_data, dict):
        return None
    commit_date = commit_data.get("commit", {}).get("committer", {}).get("date", "")
    if not commit_date:
        return None

    # Find the Qodo sticky comment
    if comments is None:
        endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
        comments = run_gh_api(endpoint, paginate=True)
    if not comments or not isinstance(comments, list):
        return None

    _QODO_USERS = {"qodo-code-review[bot]", "qodo-code-review"}

    for comment in comments:
        author = comment.get("user", {}).get("login") if comment.get("user") else None
        if author not in _QODO_USERS:
            continue

        body = comment.get("body", "")
        if not is_qodo_sticky_comment(body):
            continue

        # Check sticky was updated AFTER the commit
        sticky_updated = comment.get("updated_at", "")
        if not sticky_updated or sticky_updated < commit_date:
            print_stderr(f"[poll] Sticky updated {sticky_updated} but commit at {commit_date} — not yet reviewed.")
            return None

        # Parse for unresolved findings
        unresolved = parse_qodo_sticky_comment(body)

        # Count resolved findings from the sticky body
        import re as _re

        _prev_re = _re.compile(r"^\s*<!-- FOLDED_SECTION_START -->\s*$", _re.MULTILINE)
        _prev_match = _prev_re.search(body)
        current_body = body[: _prev_match.start()] if _prev_match else body
        resolved_count = current_body.count("Resolved</code>") + current_body.count("Dismissed</code>")
        total_findings = resolved_count + len(unresolved)

        if len(unresolved) > 0:
            print_stderr(f"[poll] Sticky has {len(unresolved)} unresolved finding(s).")
            return None

        # Check at least one resolved/dismissed finding exists
        has_resolved = (
            "✓ Resolved" in current_body
            or "Resolved</code>" in current_body
            or "✗ Dismissed" in current_body
            or "Dismissed</code>" in current_body
        )
        if not has_resolved and total_findings == 0:
            # Verify the sticky explicitly shows zero findings (not a parse failure)
            # Look for Qodo's finding count indicators like "Bugs (0)"
            _has_zero_counts = bool(re.search(r"\(\s*0\s*\)", current_body))
            if _has_zero_counts:
                # Qodo finished reviewing and found nothing — approved (no findings)
                return {
                    "approved": True,
                    "reason": "no_findings",
                    "total_findings": 0,
                    "resolved_count": 0,
                    "unresolved_count": 0,
                }
            else:
                msg = "[poll] Sticky has no resolved findings and no zero-count indicators"
                print_stderr(f"{msg} — cannot determine approval.")
                return None

        # All checks passed — fully approved by Qodo
        return {
            "approved": True,
            "reason": "all_resolved",
            "total_findings": total_findings,
            "resolved_count": resolved_count,
            "unresolved_count": 0,
        }

    # No sticky comment found
    return None


def print_approval_summary(approval: dict) -> None:
    """Print a summary of the Qodo approval status."""
    reason = approval.get("reason", "unknown")
    total = approval.get("total_findings", 0)
    resolved = approval.get("resolved_count", 0)
    unresolved = approval.get("unresolved_count", 0)
    print_stderr("")
    print_stderr("[poll] === Qodo Approval Summary ===")
    print_stderr(f"  Total findings: {total} ({resolved} resolved by Qodo, {unresolved} still in sticky)")

    if reason == "no_findings":
        print_stderr("  Status: Qodo found no issues ✅")
    elif reason == "all_resolved":
        print_stderr("  Status: All findings resolved/dismissed by Qodo ✅")

    print_stderr("")


def run(
    review_url: str = "",
    include_resolved: bool = False,
    user: str | None = None,
    *,
    output_dir: str,
) -> dict[str, Any] | int:
    """Main entry point.

    Args:
        review_url: Optional specific review URL for context.
        include_resolved: If True, include resolved threads with is_resolved field.
        user: If set, only return threads where the first comment author matches.
        output_dir: Directory for output JSON file.

    Returns:
        dict with keys (metadata, human, qodo, coderabbit) on success,
        or int exit code (1) on error.
    """
    try:
        check_dependencies()

        # Get PR info
        print_stderr("Getting PR information...")
        owner, repo, pr_number = get_pr_info(pr_url=review_url)

        print_stderr(f"Repository: {owner}/{repo}, PR: {pr_number}")

        # Fetch PR author
        pr_author: str | None = None
        author_data = run_gh_api(f"/repos/{owner}/{repo}/pulls/{pr_number}")
        if isinstance(author_data, dict):
            pr_author = author_data.get("user", {}).get("login") if author_data.get("user") else None
        else:
            print_stderr(f"Warning: Could not fetch PR author (API returned {type(author_data).__name__})")

        # Ensure output directory exists
        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

        json_path = out_dir / f"pr-{pr_number}-reviews.json"

        # Fetch all unresolved threads
        label = "review" if include_resolved else "unresolved review"
        print_stderr(f"Fetching {label} threads...")
        all_threads = fetch_review_threads(owner, repo, pr_number, include_resolved=include_resolved, user=user)
        print_stderr(f"Found {len(all_threads)} {label} thread(s)")

        # Skip bot comment fetching when filtering by specific user
        qodo_replies: list[dict[str, Any]] | None = None
        issue_comments: list[dict[str, Any]] | None = None
        if not user:
            # Fetch CodeRabbit body-embedded comments from review bodies
            print_stderr("Fetching CodeRabbit body-embedded comments...")
            body_comment_threads = fetch_coderabbit_body_comments(owner, repo, pr_number)
            if body_comment_threads:
                print_stderr(f"Found {len(body_comment_threads)} body-embedded comment(s)")
                all_threads = merge_threads(all_threads, body_comment_threads)

            # Fetch issue comments once for both sticky and reply parsing
            issue_comments = run_gh_api(
                f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100", paginate=True
            )

            # Fetch Qodo sticky comment findings
            print_stderr("Fetching Qodo sticky comment findings...")
            qodo_sticky_findings = fetch_qodo_sticky_findings(owner, repo, pr_number, comments=issue_comments)
            if qodo_sticky_findings:
                print_stderr(f"Found {len(qodo_sticky_findings)} unresolved Qodo sticky finding(s)")

                all_threads = merge_threads(all_threads, qodo_sticky_findings)

            # Fetch Qodo replies to our consolidated comments (independent of sticky findings)
            print_stderr("Fetching Qodo reply comments...")
            qodo_replies = fetch_qodo_reply_comments(owner, repo, pr_number, comments=issue_comments)
            if qodo_replies:
                print_stderr(f"Found {len(qodo_replies)} Qodo reply comment(s)")
                all_threads = merge_threads(all_threads, qodo_replies)

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

            elif parse_pr_url(review_url) is None or "#" in review_url:
                print_stderr(f"Warning: Unrecognized URL fragment in: {review_url}")

        # Merge specific threads with all threads, deduplicating
        if specific_threads:
            all_threads = merge_threads(all_threads, specific_threads)

        # Process and categorize threads
        print_stderr("Categorizing threads by source...")
        categorized = process_and_categorize(all_threads, owner, repo, pr_number=int(pr_number))

        # Enrich qodo findings with Qodo replies AFTER process_and_categorize sets already_replied
        # Only run enrichment when reply fetch was actually attempted (not user-specific mode).
        # When qodo_replies is None (fetch skipped), enrichment doesn't run and
        # _enrichment_checked isn't set, preventing incorrect auto-skip.
        if qodo_replies is not None:
            _enrich_findings_with_qodo_replies(categorized.get("qodo", []), qodo_replies)

        # Post-enrichment: auto-skip already-replied sticky findings where Qodo didn't push back
        auto_skip_replied_findings(categorized.get("qodo", []))

        # Check Qodo approval status
        _approval = is_qodo_approved(owner, repo, str(pr_number), comments=issue_comments)
        _is_approved = bool(_approval and _approval.get("approved"))

        # Build final output
        final_output = {
            "metadata": {
                "owner": owner,
                "repo": repo,
                "pr_number": int(pr_number),
                "author": pr_author,
                "json_path": str(json_path),
            },
            "human": categorized["human"],
            "qodo": categorized["qodo"],
            "coderabbit": categorized["coderabbit"],
            "approved": _is_approved,
            "qodo_cleanup_response": "",
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
        human_count = len(categorized["human"])
        qodo_count = len(categorized["qodo"])
        coderabbit_count = len(categorized["coderabbit"])
        print_stderr(f"Categories: human={human_count}, qodo={qodo_count}, coderabbit={coderabbit_count}")

        # Count auto-skipped comments
        auto_skipped = sum(1 for cat in categorized.values() for c in cat if c.get("is_auto_skipped"))
        if auto_skipped:
            print_stderr(f"Auto-skipped {auto_skipped} previously dismissed comment(s)")

        return final_output

    finally:
        cleanup()
