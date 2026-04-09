"""Review handler CLI commands."""

import sys

import click


@click.group()
def reviews() -> None:
    """Review handling commands."""


@reviews.command("fetch")
@click.argument("review_url", required=False, default="")
def reviews_fetch(review_url: str) -> None:
    """Fetch unresolved review threads from current PR.

    Fetches ALL unresolved review threads from the current branch's PR
    and categorizes them by source (human, qodo, coderabbit).

    Saves output to /tmp/pi-work/pr-<number>-reviews.json

    REVIEW_URL: Optional specific review URL for context
    (e.g., #pullrequestreview-XXX or #discussion_rXXX)
    """
    from myk_pi_tools.reviews.fetch import run

    exit_code = run(review_url)
    sys.exit(exit_code)


@reviews.command("poll")
@click.argument("review_url", required=False, default="")
def reviews_poll(review_url: str) -> None:
    """Poll for reviews with automatic CodeRabbit rate limit handling.

    Atomically combines rate limit check, trigger, and fetch into a single
    command. If CodeRabbit is rate limited, waits and triggers re-review
    before fetching.

    Same output format as 'reviews fetch'.

    REVIEW_URL: Optional specific review URL for context
    (e.g., #pullrequestreview-XXX or #discussion_rXXX)
    """
    from myk_pi_tools.reviews.poll import run

    exit_code = run(review_url)
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
def reviews_pending_fetch(pr_url: str) -> None:
    """Fetch pending review comments from a PR.

    Fetches the authenticated user's PENDING review and its comments
    from a GitHub PR. Saves output to /tmp/pi-work/pr-<number>-pending-review.json

    PR_URL: GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)
    """
    from myk_pi_tools.reviews.pending_fetch import run

    exit_code = run(pr_url)
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
