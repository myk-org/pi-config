"""Update pending review comment bodies and optionally submit the review.

This module reads a JSON file produced by pending_fetch (and refined by an AI),
updates each accepted comment's body via the GitHub GraphQL API, and optionally
submits the review with a specified action (COMMENT, APPROVE, REQUEST_CHANGES).

Comment updates use the GraphQL ``updatePullRequestReviewComment`` mutation with
the comment's ``node_id``.  This works for pending (unsubmitted) review comments,
which return 404 when accessed through the REST API.

Expected JSON structure::

  {
    "metadata": {
      "owner": "...",
      "repo": "...",
      "pr_number": 123,
      "review_id": 456,
      "submit_action": "REQUEST_CHANGES",        # optional
      "submit_summary": "Summary text"    # optional
    },
    "comments": [
      {
        "id": 789,
        "node_id": "PRRC_kwDOABC123",
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
import shutil
import subprocess
import sys
import threading
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.fetch import print_stderr, run_gh_api

log = create_logger(__name__)

# Valid submit actions for a review
VALID_SUBMIT_ACTIONS = {"COMMENT", "APPROVE", "REQUEST_CHANGES"}


def backfill_node_ids(
    owner: str,
    repo: str,
    pr_number: int,
    review_id: int,
    comments: list[dict[str, Any]],
) -> None:
    """Backfill missing node_id values for accepted comments from the GitHub API.

    Checks if any accepted comment with a refined_body is missing its node_id.
    If so, fetches review comments from the REST API and fills in the gaps.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: Pull request number.
        review_id: Review ID.
        comments: List of comment dicts (mutated in place).
    """
    needs_backfill = [
        c for c in comments if c.get("status") == "accepted" and c.get("refined_body") and not c.get("node_id")
    ]
    if not needs_backfill:
        return

    print_stderr(f"Backfilling node_id for {len(needs_backfill)} comment(s) from GitHub API...")

    endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews/{review_id}/comments"
    api_comments = run_gh_api(endpoint, paginate=True)
    if api_comments is None:
        print_stderr("Warning: Could not fetch review comments for node_id backfill")
        return

    if not isinstance(api_comments, list):
        print_stderr("Warning: Unexpected API response format for node_id backfill")
        return

    id_to_node: dict[int, str] = {
        int(c["id"]): c["node_id"] for c in api_comments if c.get("id") is not None and c.get("node_id") is not None
    }

    filled = 0
    for comment in needs_backfill:
        comment_id = comment.get("id")
        if comment_id is None:
            continue
        try:
            cid = int(comment_id)
        except (TypeError, ValueError):
            continue
        if cid in id_to_node:
            comment["node_id"] = id_to_node[cid]
            path = comment.get("path", "unknown")
            log.debug("Backfilled node_id for comment %s (%s)", comment_id, path)
            filled += 1

    if filled == 0:
        print_stderr("Warning: Could not match any comments by ID — node_ids remain empty")
    print_stderr(f"Backfilled {filled}/{len(needs_backfill)} comment(s)")


def check_dependencies() -> None:
    """Check required dependencies are available."""
    if shutil.which("gh") is None:
        print_stderr("Error: 'gh' is required but not installed.")
        sys.exit(1)


# GraphQL mutation template for updating a pending review comment body.
_UPDATE_COMMENT_MUTATION = """
mutation($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: {
    pullRequestReviewCommentId: $id,
    body: $body
  }) {
    pullRequestReviewComment { id body databaseId }
  }
}
""".strip()


def update_comment_body(node_id: str | None, refined_body: str) -> str:
    """Update a pull request review comment body via the GitHub GraphQL API.

    Uses the ``updatePullRequestReviewComment`` mutation with the comment's
    ``node_id``.  The JSON payload is passed via stdin (``--input -``) so that
    special characters in the body (quotes, newlines, code blocks) are handled
    safely by ``json.dumps``.

    Args:
        node_id: The GraphQL node ID of the comment (e.g. ``PRRC_kwDOABC123``).
        refined_body: The new body text.

    Returns:
        "success" on success, "not_found" if the comment no longer exists,
        or "error" on other failures.
    """
    if not node_id:
        print_stderr("Error: node_id is required")
        return "error"

    from myk_pi_tools.comment_signature import append_signature

    payload = json.dumps({
        "query": _UPDATE_COMMENT_MUTATION,
        "variables": {"id": node_id, "body": append_signature(refined_body)},
    })

    try:
        result = subprocess.run(
            ["gh", "api", "graphql", "--input", "-"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=120,
            encoding="utf-8",
        )
    except subprocess.TimeoutExpired:
        print_stderr(f"Error: Update comment {node_id} timed out after 120 seconds")
        return "error"

    if result.returncode != 0:
        stderr = result.stderr or ""
        print_stderr(f"Error updating comment {node_id}: {stderr.strip()}")
        if "NOT_FOUND" in stderr or "Could not resolve" in stderr:
            return "not_found"
        return "error"

    # GraphQL can return 200 with errors in the response body.
    try:
        response = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        print_stderr(f"Warning: Could not parse GraphQL response for {node_id}")
        return "error"

    if "errors" in response:
        error_msgs = [e.get("message", "") for e in response["errors"]]
        combined = "; ".join(error_msgs)
        print_stderr(f"GraphQL error updating comment {node_id}: {combined}")
        if any("NOT_FOUND" in m or "Could not resolve" in m for m in error_msgs):
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

    log.debug("Processing pending review %d for %s/%s#%d", review_id, owner, repo, pr_number)

    # Backfill missing node_ids before processing
    comments = data.get("comments", [])
    backfill_node_ids(owner, repo, pr_number, review_id, comments)

    # Process comments
    if not comments:
        print_stderr("No comments to process")
        return 0

    success_count = 0
    skip_count = 0
    fail_count = 0
    update_tasks: list[tuple[int, str, str, str]] = []

    for i, comment in enumerate(comments):
        node_id = comment.get("node_id")
        refined_body = comment.get("refined_body")
        status = comment.get("status", "pending")
        path = comment.get("path", "unknown")

        # Only update comments that are accepted and have a refined body
        if not refined_body or status != "accepted":
            skip_count += 1
            has_body = "set" if refined_body else "null"
            log.debug("Skipping comment [%d] (%s): status=%s, refined_body=%s", i, path, status, has_body)
            continue

        original_body = comment.get("body", "")
        if refined_body.strip() == str(original_body).strip():
            skip_count += 1
            log.debug("Skipping comment [%d] (%s): refined_body unchanged", i, path)
            continue

        if not node_id:
            fail_count += 1
            print_stderr(f"Error: Comment [{i}] ({path}) has no node_id. Re-run 'reviews pending-fetch' to refresh.")
            continue

        update_tasks.append((i, path, str(node_id), str(refined_body)))

    if len(update_tasks) == 1:
        i, path, node_id, refined_body = update_tasks[0]
        log.debug("Updating comment [%d] (%s, node_id=%s)...", i, path, node_id)
        result = update_comment_body(node_id, refined_body)
        if result == "success":
            success_count += 1
            log.debug("Updated comment [%d] successfully", i)
        elif result == "not_found":
            print_stderr(
                "  Error: Comment not found (404). Pending review may have been submitted or deleted externally."
            )
            print_stderr("Aborting remaining updates.")
            return 1
        else:
            fail_count += 1
            print_stderr(f"  Failed to update comment [{i}] ({path})")
    elif len(update_tasks) > 1:
        abort_event = threading.Event()

        def _worker(task: tuple[int, str, str, str]) -> tuple[int, str, str]:
            idx, item_path, item_node_id, item_body = task
            if abort_event.is_set():
                return idx, item_path, "aborted"
            log.debug("Updating comment [%d] (%s, node_id=%s)...", idx, item_path, item_node_id)
            return idx, item_path, update_comment_body(item_node_id, item_body)

        aborted = False
        updated_paths: list[str] = []
        with ThreadPoolExecutor(max_workers=min(4, len(update_tasks))) as executor:
            futures = [executor.submit(_worker, task) for task in update_tasks]
            for fut in as_completed(futures):
                try:
                    idx, item_path, result = fut.result()
                except CancelledError:
                    continue
                if result == "not_found":
                    if not aborted:
                        aborted = True
                        abort_event.set()
                        for pending_fut in futures:
                            pending_fut.cancel()
                        print_stderr(
                            "  Error: Comment not found (404). "
                            "Pending review may have been submitted or deleted externally."
                        )
                        print_stderr("Aborting remaining updates.")
                elif result == "success":
                    success_count += 1
                    updated_paths.append(f"[{idx}] ({item_path})")
                    log.debug("Updated comment [%d] successfully", idx)
                elif result != "aborted":
                    fail_count += 1
                    print_stderr(f"  Failed to update comment [{idx}] ({item_path})")

        if aborted:
            if updated_paths:
                print_stderr(f"Updated {success_count} comment(s) before abort: {', '.join(updated_paths)}")
            return 1

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
