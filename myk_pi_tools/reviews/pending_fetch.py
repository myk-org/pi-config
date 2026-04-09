"""Fetch the authenticated user's pending review and its comments from a GitHub PR.

This module fetches the current user's PENDING review on a PR, retrieves all
comments within that review, and outputs them as JSON for refinement.

Output: JSON with metadata and comments saved to /tmp/pi-work/pr-<number>-pending-review.json
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from myk_pi_tools.reviews.fetch import (
    check_dependencies,
    parse_pr_url,
    print_stderr,
    run_gh_api,
)

# Maximum diff length to include in output (characters)
MAX_DIFF_LENGTH = 50000


def get_authenticated_user() -> str | None:
    """Get the login of the authenticated GitHub user.

    Returns:
        Username string or None on failure.
    """
    try:
        result = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        print_stderr("Error: gh api user timed out")
        return None

    if result.returncode != 0:
        stderr = result.stderr or ""
        print_stderr(f"Error: Could not get authenticated user: {stderr.strip()}")
        return None

    login = result.stdout.strip()
    return login if login else None


def fetch_pr_diff(owner: str, repo: str, pr_number: str) -> str | None:
    """Fetch the PR diff for context.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.

    Returns:
        Diff text (truncated if over MAX_DIFF_LENGTH) or None on failure.
    """
    try:
        result = subprocess.run(
            ["gh", "pr", "diff", pr_number, "-R", f"{owner}/{repo}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        print_stderr("Error: gh pr diff timed out after 120 seconds")
        return None

    if result.returncode != 0:
        stderr = result.stderr or ""
        print_stderr(f"Warning: Could not fetch PR diff: {stderr.strip()}")
        return None

    diff_text = result.stdout
    if len(diff_text) > MAX_DIFF_LENGTH:
        diff_text = diff_text[:MAX_DIFF_LENGTH] + "\n...[truncated]"
    return diff_text


def find_pending_review(
    owner: str,
    repo: str,
    pr_number: str,
    username: str,
) -> tuple[dict[str, Any] | None, str | None]:
    """Find the user's pending review on the PR.

    Fetches all reviews (paginated) and filters for the user's PENDING review.
    If multiple pending reviews exist, returns the one with the highest ID (most recent).

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
        username: Authenticated user's login.

    Returns:
        A tuple of (review_dict, error_message).
        - (review_dict, None) if a pending review is found.
        - (None, None) if no pending review exists.
        - (None, error_message) if the API call failed.
    """
    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews"
    reviews = run_gh_api(endpoint, paginate=True)

    if reviews is None:
        return None, "Could not fetch PR reviews"

    if not isinstance(reviews, list):
        return None, "Unexpected reviews response shape (expected list)"

    # Filter for user's PENDING reviews
    pending_reviews = [r for r in reviews if r.get("state") == "PENDING" and r.get("user", {}).get("login") == username]

    if not pending_reviews:
        return None, None

    # Use highest ID (most recent) if multiple
    pending_reviews.sort(key=lambda r: r.get("id", 0), reverse=True)
    return pending_reviews[0], None


def fetch_pending_review_comments(
    owner: str,
    repo: str,
    pr_number: str,
    review_id: int,
) -> list[dict[str, Any]]:
    """Fetch comments for a specific review.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
        review_id: Review ID to fetch comments for.

    Returns:
        List of comment dicts formatted for output.
    """
    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews/{review_id}/comments"
    raw_comments = run_gh_api(endpoint, paginate=True)

    if raw_comments is None:
        print_stderr(f"Warning: Could not fetch comments for review {review_id}")
        return []

    if not isinstance(raw_comments, list):
        print_stderr("Warning: Unexpected comments response shape (expected list)")
        return []

    comments: list[dict[str, Any]] = []
    for c in raw_comments:
        comment: dict[str, Any] = {
            "id": c.get("id"),
            "path": c.get("path"),
            "line": c.get("line"),
            "side": c.get("side", "RIGHT"),
            "body": c.get("body", ""),
            "diff_hunk": c.get("diff_hunk", ""),
            "refined_body": None,
            "status": "pending",
        }
        comments.append(comment)

    return comments


def run(pr_url: str) -> int:
    """Main entry point.

    Fetches the authenticated user's pending review and its comments from a PR.

    Args:
        pr_url: GitHub PR URL (e.g., https://github.com/owner/repo/pull/123).

    Returns:
        Exit code (0 for success, 1 for error).
    """
    # Uses check_dependencies from fetch.py which calls sys.exit(1) on failure.
    # This is consistent with the fetch.py pattern.
    check_dependencies()

    # Parse PR URL
    parsed = parse_pr_url(pr_url)
    if parsed is None:
        print_stderr(f"Error: Could not parse PR URL: {pr_url}")
        return 1

    owner, repo, pr_number = parsed

    try:
        pr_number_int = int(pr_number)
    except (TypeError, ValueError):
        print_stderr(f"Error: Invalid PR number: {pr_number!r}")
        return 1

    print_stderr(f"Repository: {owner}/{repo}, PR: {pr_number}")

    # Get authenticated user
    print_stderr("Getting authenticated user...")
    username = get_authenticated_user()
    if username is None:
        print_stderr("Error: Could not determine authenticated user")
        return 1
    print_stderr(f"Authenticated as: {username}")

    # Find pending review
    print_stderr("Fetching PR reviews...")
    pending_review, error = find_pending_review(owner, repo, pr_number, username)
    if error:
        print_stderr(f"Error: {error}")
        return 1
    if pending_review is None:
        print_stderr(f"Error: No pending review found for user '{username}' on PR #{pr_number}")
        print_stderr("Start a review on GitHub first by adding comments without submitting.")
        return 1

    review_id = pending_review.get("id")
    if review_id is None:
        print_stderr("Error: Pending review has no ID")
        return 1

    try:
        review_id = int(review_id)
    except (TypeError, ValueError):
        print_stderr(f"Error: Invalid review ID: {review_id!r}")
        return 1
    print_stderr(f"Found pending review: {review_id}")

    # Fetch comments for the pending review
    print_stderr("Fetching review comments...")
    comments = fetch_pending_review_comments(owner, repo, pr_number, review_id)
    print_stderr(f"Found {len(comments)} comment(s)")

    # Fetch PR diff for context
    print_stderr("Fetching PR diff...")
    diff = fetch_pr_diff(owner, repo, pr_number)
    if diff is None:
        diff = ""
        print_stderr("Warning: Could not fetch diff, continuing without it")

    # Temp files in /tmp/pi-work/ follow the standard pattern used by all review commands.
    # The directory has 0o700 permissions to restrict access on shared machines.
    tmp_base = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
    out_dir = tmp_base / "pi-work"
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        out_dir.chmod(0o700)
    except OSError as e:
        print_stderr(f"Warning: unable to set permissions on {out_dir}: {e}")

    safe_repo = f"{owner}-{repo}".replace("/", "-")
    json_path = out_dir / f"pr-{safe_repo}-{pr_number}-pending-review.json"

    # Build final output
    final_output: dict[str, Any] = {
        "metadata": {
            "owner": owner,
            "repo": repo,
            "pr_number": pr_number_int,
            "review_id": review_id,
            "username": username,
            "json_path": str(json_path),
        },
        "comments": comments,
        "diff": diff,
    }

    # Save to file atomically
    fd, tmp_json_path = tempfile.mkstemp(
        prefix=f"pr-{safe_repo}-{pr_number}-pending-review.json.",
        dir=str(out_dir),
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(final_output, f, indent=2)
        os.replace(tmp_json_path, json_path)
    except Exception as e:
        Path(tmp_json_path).unlink(missing_ok=True)
        print_stderr(f"Error: Failed to write JSON file: {e}")
        return 1

    print_stderr(f"Saved to: {json_path}")

    # Output file path to stdout (full data is already saved to file)
    print(str(json_path))

    return 0
