"""PR-related CLI commands."""

import click


@click.group()
def pr() -> None:
    """PR review and management commands."""


@pr.command("diff")
@click.argument("args", nargs=-1)
def pr_diff(args: tuple[str, ...]) -> None:
    """Fetch PR diff and metadata.

    Usage:
        pr diff <owner/repo> <pr_number>
        pr diff https://github.com/owner/repo/pull/123
        pr diff <pr_number>
    """
    from myk_pi_tools.pr.diff import run

    run(list(args))


@pr.command("claude-md")
@click.argument("args", nargs=-1)
def pr_claude_md(args: tuple[str, ...]) -> None:
    """Fetch CLAUDE.md and AGENTS.md content for a PR's repository.

    Checks both CLAUDE.md and AGENTS.md in root and config directories.
    Outputs all found content concatenated.

    Usage:
        pr claude-md <owner/repo> <pr_number>
        pr claude-md https://github.com/owner/repo/pull/123
        pr claude-md <pr_number>
    """
    from myk_pi_tools.pr.claude_md import run

    run(list(args))


@pr.command("post-comment")
@click.argument("owner_repo")
@click.argument("pr_number")
@click.argument("commit_sha")
@click.argument("json_file")
def pr_post_comment(owner_repo: str, pr_number: str, commit_sha: str, json_file: str) -> None:
    """Post inline comments to a PR.

    Arguments:
        OWNER_REPO: Repository in format "owner/repo"
        PR_NUMBER: Pull request number
        COMMIT_SHA: The SHA of the commit to comment on
        JSON_FILE: Path to JSON file with comments, or "-" for stdin

    JSON format:
        [{"path": "file.py", "line": 42, "body": "Comment text"}]
    """
    from myk_pi_tools.pr.post_comment import run

    run(owner_repo, pr_number, commit_sha, json_file)


@pr.command("store-pr-review")
@click.argument("json_file")
def pr_store_review(json_file: str) -> None:
    """Store posted PR review comments to pr-reviews.db.

    JSON format:
        {
            "metadata": {"owner": "...", "repo": "...", "pr_number": 123},
            "comments": [{"thread_id": "...", "comment_id": 123, "path": "file.py",
                          "line": 42, "body": "...", "severity": "WARNING", "posted_at": "..."}]
        }
    """
    import sys

    from myk_pi_tools.pr.pr_review_store import run_store

    exit_code = run_store(json_file)
    sys.exit(exit_code)


@pr.command("get-skipped-comments")
@click.argument("owner")
@click.argument("repo")
@click.argument("pr_number", type=int)
def pr_get_skipped(owner: str, repo: str, pr_number: int) -> None:
    """Get previously skipped review comments for a PR.

    Outputs JSON array of skipped comments with path, line, body,
    severity, skip_reason, and head_sha.
    """
    import json
    import sys

    from myk_pi_tools.pr.pr_review_store import get_skipped_comments

    results = get_skipped_comments(owner, repo, pr_number)
    print(json.dumps(results, indent=2))
    sys.exit(0)


@pr.command("info")
@click.argument("args", nargs=-1)
def pr_info(args: tuple[str, ...]) -> None:
    """Fetch PR information as structured JSON.

    Returns author, head SHA, base ref, title, state, labels, assignees.

    Usage:
        pr info <owner/repo> <pr_number>
        pr info https://github.com/owner/repo/pull/123
        pr info <pr_number>
    """
    from myk_pi_tools.pr.info import run

    run(list(args))
