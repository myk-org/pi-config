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
