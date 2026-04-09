"""Update pending review comment bodies and optionally submit the review.

This module reads a JSON file produced by pending_fetch (and refined by an AI),
updates each accepted comment's body via the GitHub API, and optionally submits
the review with a specified action (COMMENT, APPROVE, REQUEST_CHANGES).

Expected JSON structure:
  {
    "metadata": {
      "owner": "...",
      "repo": "...",
      "pr_number": 123,
      "review_id": 456,
      "submit_action": "COMMENT",        # optional
      "submit_summary": "Summary text"    # optional
    },
    "comments": [
      {
        "id": 789,
        "path": "src/main.py",
        "line": 42,
        "body": "original comment",
        "refined_body": "refined version",
        "status": "accepted"
      }
    ]
  }

Status handling:
  - accepted: Update comment body with refined_body
  - Other statuses: Skip (no update)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from myk_pi_tools.reviews.fetch import print_stderr

# Valid submit actions for a review
VALID_SUBMIT_ACTIONS = {"COMMENT", "APPROVE", "REQUEST_CHANGES"}


def check_dependencies() -> None:
    """Check required dependencies are available."""
    import shutil  # noqa: PLC0415

    if shutil.which("gh") is None:
        print_stderr("Error: 'gh' is required but not installed.")
        sys.exit(1)


def update_comment_body(
    owner: str,
    repo: str,
    comment_id: int,
    refined_body: str,
) -> str:
    """Update a pull request review comment body via the GitHub API.

    Uses stdin (--input -) to pass the body safely, handling multiline content,
    apostrophes, code blocks, and other special characters.

    Args:
        owner: Repository owner.
        repo: Repository name.
        comment_id: The comment ID to update.
        refined_body: The new body text.

    Returns:
        "success" on success, "not_found" on 404, or "error" on other failures.
    """
    endpoint = f"/repos/{owner}/{repo}/pulls/comments/{comment_id}"
    payload = json.dumps({"body": refined_body})

    try:
        result = subprocess.run(
            ["gh", "api", "--method", "PATCH", endpoint, "--input", "-"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=120,
            encoding="utf-8",
        )
    except subprocess.TimeoutExpired:
        print_stderr(f"Error: Update comment {comment_id} timed out after 120 seconds")
        return "error"

    if result.returncode != 0:
        stderr = result.stderr or ""
        print_stderr(f"Error updating comment {comment_id}: {stderr.strip()}")
        if "404" in stderr or "Not Found" in stderr:
            return "not_found"
        return "error"

    return "success"


def submit_review(
    owner: str,
    repo: str,
    pr_number: int,
    review_id: int,
    action: str,
    summary: str,
) -> bool:
    """Submit a pending review with the specified action.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
        review_id: Review ID to submit.
        action: Submit action (COMMENT, APPROVE, REQUEST_CHANGES).
        summary: Summary body for the review submission.

    Returns:
        True on success, False on failure.
    """
    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews/{review_id}/events"
    payload = json.dumps({"event": action, "body": summary})

    try:
        result = subprocess.run(
            ["gh", "api", "--method", "POST", endpoint, "--input", "-"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=120,
            encoding="utf-8",
        )
    except subprocess.TimeoutExpired:
        print_stderr(f"Error: Submit review {review_id} timed out after 120 seconds")
        return False

    if result.returncode != 0:
        stderr = result.stderr or ""
        print_stderr(f"Error submitting review {review_id}: {stderr.strip()}")
        return False

    return True


def run(json_path: str, *, submit: bool = False) -> int:
    """Main entry point.

    Reads the JSON file, updates accepted comments, and optionally submits the review.

    Args:
        json_path: Path to JSON file with pending review data.
        submit: If True and submit_action is set in metadata, submit the review.
            Both the JSON submit_action and this flag must be present for submission.

    Returns:
        Exit code (0 for success, 1 if any failures).
    """
    check_dependencies()

    json_path_obj = Path(json_path).resolve()

    # Validate JSON file exists
    if not json_path_obj.is_file():
        print_stderr(f"Error: JSON file not found: {json_path}")
        return 1

    # Validate JSON is readable and well-formed
    try:
        with open(json_path_obj, encoding="utf-8") as f:
            data: dict[str, Any] = json.load(f)
    except (json.JSONDecodeError, OSError):
        print_stderr(f"Error: Invalid JSON file: {json_path}")
        return 1

    # Extract metadata
    metadata = data.get("metadata", {})
    owner = metadata.get("owner", "")
    repo = metadata.get("repo", "")
    pr_number = metadata.get("pr_number")
    review_id = metadata.get("review_id")

    if not owner or not repo or pr_number is None or review_id is None:
        print_stderr("Error: Missing metadata in JSON file (owner, repo, pr_number, or review_id)")
        return 1

    try:
        pr_number = int(pr_number)
        review_id = int(review_id)
    except (TypeError, ValueError):
        print_stderr("Error: pr_number and review_id must be integers")
        return 1

    print_stderr(f"Processing pending review {review_id} for {owner}/{repo}#{pr_number}")

    # Process comments
    comments = data.get("comments", [])
    if not comments:
        print_stderr("No comments to process")
        return 0

    success_count = 0
    skip_count = 0
    fail_count = 0

    for i, comment in enumerate(comments):
        comment_id = comment.get("id")
        refined_body = comment.get("refined_body")
        status = comment.get("status", "pending")
        path = comment.get("path", "unknown")

        # Only update comments that are accepted and have a refined body
        if not refined_body or status != "accepted":
            skip_count += 1
            has_body = "set" if refined_body else "null"
            print_stderr(f"Skipping comment [{i}] ({path}): status={status}, refined_body={has_body}")
            continue

        original_body = comment.get("body", "")
        if refined_body.strip() == str(original_body).strip():
            skip_count += 1
            print_stderr(f"Skipping comment [{i}] ({path}): refined_body unchanged")
            continue

        if comment_id is None:
            fail_count += 1
            print_stderr(f"Error: Comment [{i}] ({path}) has no ID")
            continue

        try:
            comment_id = int(comment_id)
        except (TypeError, ValueError):
            print_stderr(f"Warning: Skipping comment [{i}] ({path}): invalid comment ID: {comment_id!r}")
            fail_count += 1
            continue
        print_stderr(f"Updating comment [{i}] ({path}, id={comment_id})...")

        result = update_comment_body(owner, repo, comment_id, refined_body)
        if result == "success":
            success_count += 1
            print_stderr("  Updated successfully")
        elif result == "not_found":
            print_stderr(
                "  Error: Comment not found (404). Pending review may have been submitted or deleted externally."
            )
            print_stderr("Aborting remaining updates.")
            return 1
        else:
            fail_count += 1
            print_stderr("  Failed to update")

    # Optionally submit the review (requires both JSON submit_action AND --submit flag)
    submit_action = metadata.get("submit_action")
    if submit_action and submit:
        if submit_action not in VALID_SUBMIT_ACTIONS:
            print_stderr(
                f"Error: Invalid submit_action '{submit_action}'. "
                f"Must be one of: {', '.join(sorted(VALID_SUBMIT_ACTIONS))}"
            )
            return 1

        if fail_count > 0:
            print_stderr(f"Skipping review submission due to {fail_count} failed update(s)")
        else:
            submit_summary = metadata.get("submit_summary", "")
            print_stderr(f"Submitting review with action: {submit_action}...")

            if submit_review(owner, repo, pr_number, review_id, submit_action, submit_summary):
                print_stderr("Review submitted successfully")
            else:
                print_stderr("Failed to submit review")
                fail_count += 1
    elif submit_action and not submit:
        print_stderr(f"Note: submit_action='{submit_action}' set but --submit flag not passed. Skipping submission.")

    # Print summary
    print_stderr("")
    print_stderr("=== Summary ===")
    print_stderr(f"Updated: {success_count} comment(s)")
    print_stderr(f"Skipped: {skip_count} comment(s)")
    if fail_count > 0:
        print_stderr(f"Failed: {fail_count} comment(s)")

    return 1 if fail_count > 0 else 0
