"""Fetch the authenticated user's pending review and its comments from a GitHub PR.

This module fetches the current user's PENDING review on a PR, retrieves all
comments within that review, and outputs them as JSON for refinement.

Output: JSON with metadata and comments saved to <output_dir>/pr-<number>-pending-review.json
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from myk_pi_tools.github import check_dependencies, parse_pr_url, run_gh, run_gh_api
from myk_pi_tools.utils import atomic_write_json, print_stderr

# Maximum diff length to include in output (characters)
MAX_DIFF_LENGTH = 50000


def get_authenticated_user() -> str | None:
    """Get the login of the authenticated GitHub user.

    Returns:
        Username string or None on failure.
    """
    code, stdout, stderr = run_gh(["api", "user", "--jq", ".login"], timeout=30)
    if code != 0:
        if "timed out" in stderr.lower():
            print_stderr("Error: gh api user timed out")
        else:
            print_stderr(f"Error: Could not get authenticated user: {stderr.strip()}")
        return None

    login = stdout.strip()
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
    code, stdout, stderr = run_gh(
        ["pr", "diff", pr_number, "-R", f"{owner}/{repo}"],
        timeout=120,
    )
    if code != 0:
        if "timed out" in stderr.lower():
            print_stderr("Error: gh pr diff timed out after 120 seconds")
        else:
            print_stderr(f"Warning: Could not fetch PR diff: {stderr.strip()}")
        return None

    diff_text = stdout
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
            "node_id": c.get("node_id"),
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


def run(pr_url: str, *, output_dir: str) -> int:
    """Main entry point.

    Fetches the authenticated user's pending review and its comments from a PR.

    Args:
        pr_url: GitHub PR URL (e.g., https://github.com/owner/repo/pull/123).
        output_dir: Directory for output JSON file.

    Returns:
        Exit code (0 for success, 1 for error).
    """
    # Uses check_dependencies from github.py which calls sys.exit(1) on failure.
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

    # Fetch comments for the pending review and PR diff concurrently
    print_stderr("Fetching review comments...")
    print_stderr("Fetching PR diff...")
    with ThreadPoolExecutor(max_workers=2) as executor:
        comments_future = executor.submit(fetch_pending_review_comments, owner, repo, pr_number, review_id)
        diff_future = executor.submit(fetch_pr_diff, owner, repo, pr_number)
        comments = comments_future.result()
        diff = diff_future.result()

    print_stderr(f"Found {len(comments)} comment(s)")
    if diff is None:
        diff = ""
        print_stderr("Warning: Could not fetch diff, continuing without it")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

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
    try:
        atomic_write_json(
            json_path,
            final_output,
            indent=2,
            prefix=f"pr-{safe_repo}-{pr_number}-pending-review.json.",
        )
    except Exception as e:
        print_stderr(f"Error: Failed to write JSON file: {e}")
        return 1

    print_stderr(f"Saved to: {json_path}")

    # Output file path to stdout (full data is already saved to file)
    print(str(json_path))

    return 0
