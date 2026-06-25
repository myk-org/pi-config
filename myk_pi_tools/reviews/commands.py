"""Review handler CLI commands."""

import sys

import click


@click.group()
def reviews() -> None:
    """Review handling commands."""


@reviews.command("fetch")
@click.argument("review_url", required=False, default="")
@click.option(
    "--include-resolved", is_flag=True, default=False, help="Include resolved threads (with is_resolved field)"
)
@click.option("--user", default=None, help="Filter threads by author username")
@click.option("--output-dir", required=True, help="Directory for output JSON file")
def reviews_fetch(review_url: str, include_resolved: bool, user: str | None, output_dir: str) -> None:
    """Fetch review threads from current PR.

    Fetches review threads from the current branch's PR
    and categorizes them by source (human, qodo, coderabbit).

    Saves output to <output-dir>/pr-<number>-reviews.json

    REVIEW_URL: Optional specific review URL for context
    (e.g., #pullrequestreview-XXX or #discussion_rXXX)
    """
    import json

    from myk_pi_tools.reviews.fetch import run

    result = run(review_url, include_resolved=include_resolved, user=user, output_dir=output_dir)
    if isinstance(result, dict):
        print(json.dumps(result, indent=2))
        sys.exit(0)
    else:
        sys.exit(result)


@reviews.command("poll")
@click.argument("review_url", required=False, default="")
@click.option(
    "--source",
    type=click.Choice(["coderabbit", "qodo"]),
    default="coderabbit",
    help="Which reviewer to poll for (default: coderabbit)",
)
@click.option("--output-dir", required=True, help="Directory for output JSON file")
def reviews_poll(review_url: str, source: str, output_dir: str) -> None:
    """Poll for reviews until new actionable comments appear.

    Loops internally until something actionable happens, then returns
    the fetch JSON. Behavior depends on --source:

    - coderabbit: Checks approval, handles rate limits, triggers re-review
    - qodo: Fetches and checks for new Qodo comments (no rate limit handling)

    REVIEW_URL: Optional specific review URL for context
    (e.g., #pullrequestreview-XXX or #discussion_rXXX)
    """
    from myk_pi_tools.reviews.poll import run

    exit_code = run(review_url, source=source, output_dir=output_dir)
    sys.exit(exit_code)


@reviews.command("post")
@click.argument("json_path")
def reviews_post(json_path: str) -> None:
    """Post replies and resolve review threads.

    Reads a JSON file created by 'reviews fetch' and processed by an AI handler,
    then posts replies and resolves threads based on status.

    Updates the JSON file with posted_at timestamps.

    JSON_PATH: Path to JSON file with review data
    """
    from myk_pi_tools.reviews.post import run

    run(json_path)


@reviews.command("pending-fetch")
@click.argument("pr_url")
@click.option("--output-dir", required=True, help="Directory for output JSON file")
def reviews_pending_fetch(pr_url: str, output_dir: str) -> None:
    """Fetch pending review comments from a PR.

    Fetches the authenticated user's PENDING review and its comments
    from a GitHub PR. Saves output to <output-dir>/pr-<number>-pending-review.json

    PR_URL: GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)
    """
    from myk_pi_tools.reviews.pending_fetch import run

    exit_code = run(pr_url, output_dir=output_dir)
    sys.exit(exit_code)


@reviews.command("pending-update")
@click.argument("json_path")
@click.option("--submit", is_flag=True, help="Submit the review after updating comments")
def reviews_pending_update(json_path: str, submit: bool) -> None:  # noqa: FBT001
    """Update pending review comments and optionally submit.

    Reads a JSON file created by 'reviews pending-fetch' and refined by an AI,
    then updates accepted comment bodies and optionally submits the review.

    JSON_PATH: Path to JSON file with pending review data
    """
    from myk_pi_tools.reviews.pending_update import run

    exit_code = run(json_path, submit=submit)
    sys.exit(exit_code)


@reviews.command("status")
@click.option("--pr", type=int, default=None, help="PR number (default: auto-detect from current branch)")
@click.option("--output-dir", required=True, help="Directory for output HTML report")
def reviews_status(pr: int | None, output_dir: str) -> None:
    """Show review status for current PR.

    Queries the reviews database and displays all comments across all
    review cycles. Outputs a TUI table and generates an HTML report.
    """
    from myk_pi_tools.reviews.status import run

    run(pr_number=pr, output_dir=output_dir)


@reviews.command("store")
@click.argument("json_path")
def reviews_store(json_path: str) -> None:
    """Store completed review to database.

    Stores the completed review JSON to SQLite database for analytics.
    The database is stored at: <project-root>/.pi/data/reviews.db

    This command should run AFTER the review flow completes.
    The JSON file is deleted after successful storage.

    JSON_PATH: Path to the completed review JSON file
    """
    from myk_pi_tools.reviews.store import run

    run(json_path)
