"""CodeRabbit CLI commands."""

import sys

import click


@click.group()
def coderabbit() -> None:
    """CodeRabbit commands."""


@coderabbit.command("check")
@click.argument("owner_repo")
@click.argument("pr_number", type=int)
def check(owner_repo: str, pr_number: int) -> None:
    """Check if CodeRabbit is rate limited on a PR.

    Outputs JSON with rate limit status and wait time.

    OWNER_REPO: Repository in owner/repo format
    PR_NUMBER: Pull request number
    """
    from myk_pi_tools.coderabbit.rate_limit import run_check

    sys.exit(run_check(owner_repo, pr_number))


@coderabbit.command("validate")
def validate() -> None:
    """Check that cr CLI is installed and authenticated.

    Exits 0 if ready, 1 if not (with clear error message).
    """
    from myk_pi_tools.coderabbit.validate import run_validate

    sys.exit(run_validate())


@coderabbit.command("review", context_settings={"ignore_unknown_options": True, "allow_extra_args": True})
@click.argument("args", nargs=-1, type=click.UNPROCESSED)
def review(args: tuple[str, ...]) -> None:
    """Run cr review --agent, handle rate limits, return findings or approved.

    Wraps `cr review --agent` with automatic rate limit handling.
    Any extra ARGS are passed through to `cr review` (e.g. --base main, -t uncommitted).
    Outputs NDJSON lines: finding events, then a final complete or error event.

    ARGS: Extra flags passed to `cr review` (e.g. --base main --dir /path)
    """
    from myk_pi_tools.coderabbit.review import run_review

    sys.exit(run_review(list(args)))


@coderabbit.command("trigger")
@click.argument("owner_repo")
@click.argument("pr_number", type=int)
@click.option("--wait", "wait_seconds", type=int, default=0, help="Seconds to wait before posting review trigger")
def trigger(owner_repo: str, pr_number: int, wait_seconds: int) -> None:
    """Wait and trigger a CodeRabbit review on a PR.

    Optionally waits, then posts @coderabbitai review and polls
    until the review starts (max 10 minutes).

    OWNER_REPO: Repository in owner/repo format
    PR_NUMBER: Pull request number
    """
    from myk_pi_tools.coderabbit.rate_limit import run_trigger

    sys.exit(run_trigger(owner_repo, pr_number, wait_seconds))


@coderabbit.command("store")
@click.argument("json_path")
def store(json_path: str) -> None:
    """Store a local CodeRabbit review cycle to database.

    JSON_PATH: Path to JSON file with cycle data.
    """
    from myk_pi_tools.coderabbit.store import run_store

    sys.exit(run_store(json_path))


@coderabbit.command("history")
@click.option("--branch", default=None, help="Filter by branch name")
@click.option("--limit", default=20, show_default=True, help="Max sessions to show")
def history(branch: str | None, limit: int) -> None:
    """Show history of local CodeRabbit review sessions."""
    from myk_pi_tools.coderabbit.store import run_history

    sys.exit(run_history(branch=branch, limit=limit))
