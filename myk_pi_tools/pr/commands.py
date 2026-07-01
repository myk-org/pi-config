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

    try:
        results = get_skipped_comments(owner, repo, pr_number)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(results, indent=2))
    sys.exit(0)


@pr.command("update-resolution")
@click.argument("owner")
@click.argument("repo")
@click.argument("pr_number", type=int)
@click.option("--path", "file_path", required=True, help="File path of the comment")
@click.option("--line", type=int, default=None, help="Line number of the comment")
@click.option(
    "--status",
    "resolution_status",
    required=True,
    type=click.Choice(["resolved_fixed", "resolved_accepted", "resolved_bad_fix", "resolved_no_fix"]),
    help="Resolution status",
)
@click.option("--response", "author_response", default=None, help="PR author's reply text")
@click.option(
    "--response-file",
    "response_file",
    default=None,
    type=click.Path(exists=True, dir_okay=False, readable=True),
    help="Read author response from file (avoids shell quoting issues)",
)
def pr_update_resolution(
    owner: str,
    repo: str,
    pr_number: int,
    file_path: str,
    line: int | None,
    resolution_status: str,
    author_response: str | None,
    response_file: str | None,
) -> None:
    """Update resolution status for a previously posted review comment.

    Resolution decisions are made by our review LLM (Phase 1c evaluation),
    not by the PR author. Stores our verdict in the PR review database.
    """
    import sys

    from myk_pi_tools.pr.pr_review_store import update_resolution

    # --response-file takes precedence over --response
    if response_file:
        from pathlib import Path

        try:
            author_response = Path(response_file).read_text(encoding="utf-8").strip()
        except OSError as e:
            print(f"Error reading response file: {e}", file=sys.stderr)
            sys.exit(1)

    try:
        updated = update_resolution(owner, repo, pr_number, file_path, line, resolution_status, author_response)
        if updated:
            print(f"Updated: {file_path}:{line} \u2192 {resolution_status}", file=sys.stderr)
        else:
            print(f"No matching comment found for {file_path}:{line}", file=sys.stderr)
            sys.exit(1)
    except (RuntimeError, ValueError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)


@pr.command("get-review-history")
@click.argument("owner")
@click.argument("repo")
@click.argument("pr_number", type=int)
def pr_get_review_history(owner: str, repo: str, pr_number: int) -> None:
    """Get complete review history for a PR.

    Returns ALL past findings as JSON: posted, skipped (with reason),
    resolved (with our verdict and author response). This is the single
    source of truth for reviewers to avoid re-raising dismissed findings.
    """
    import json
    import sys

    from myk_pi_tools.pr.pr_review_store import get_review_history

    try:
        results = get_review_history(owner, repo, pr_number)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
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
