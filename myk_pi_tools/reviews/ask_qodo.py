"""Ask Qodo a question and wait for reply.

Posts a comment mentioning @qodo-code-review with the question,
then waits up to 10 minutes for Qodo's reply.

Usage:
    myk-pi-tools reviews ask-qodo <question>
    myk-pi-tools reviews ask-qodo --pr <owner/repo> <pr_number> <question>
"""

from __future__ import annotations

import subprocess
import sys
import time
from datetime import UTC, datetime

from myk_pi_tools.reviews.fetch import get_pr_info, print_stderr, run_gh_api


def post_and_wait_for_qodo_reply(
    owner: str,
    repo: str,
    pr_number: str,
    message: str,
    match_lines: list[str],
    timeout: int = 600,
    poll_interval: int = 30,
    label: str = "ask-qodo",
) -> str:
    """Post a comment mentioning @qodo-code-review and wait for reply.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.
        message: Full message body to post (should include @qodo-code-review).
        match_lines: Lines to match in Qodo's reply (it quotes our message).
        timeout: Max wait time in seconds (default 600 = 10 min).
        poll_interval: Seconds between checks (default 30).
        label: Label for log messages.

    Returns:
        Qodo's reply body text, or empty string on timeout/failure.
    """
    post_time = datetime.now(UTC).isoformat()

    try:
        subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{owner}/{repo}/issues/{pr_number}/comments",
                "-X",
                "POST",
                "-f",
                f"body={message}",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        print_stderr(f"[{label}] Posted comment to @qodo-code-review.")
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else ""
        print_stderr(f"[{label}] Failed to post comment (rc={e.returncode}): {stderr}")
        return ""
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print_stderr(f"[{label}] Failed to post comment: {e}")
        return ""

    print_stderr(f"[{label}] Waiting for Qodo reply (up to {timeout // 60} min)...")
    start = time.time()
    while time.time() - start < timeout:
        time.sleep(poll_interval)
        try:
            endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
            comments = run_gh_api(endpoint, paginate=True)
            if not comments or not isinstance(comments, list):
                continue

            for comment in comments:
                author = comment.get("user", {}).get("login") if comment.get("user") else None
                if author != "qodo-code-review[bot]":
                    continue
                created = comment.get("created_at", "")
                if created <= post_time:
                    continue
                body = comment.get("body", "")
                if all(line in body for line in match_lines):
                    print_stderr(f"[{label}] Received Qodo reply.")
                    return body
        except Exception as e:
            print_stderr(f"[{label}] Error checking for reply: {e}")

    print_stderr(f"[{label}] Timeout waiting for Qodo reply ({timeout // 60} min).")
    return ""


def ask_qodo(owner: str, repo: str, pr_number: str, question: str) -> str:
    """Post a question to Qodo and wait for reply."""
    message = f"@qodo-code-review\n\n{question}"
    match_lines = [line.strip() for line in question.strip().splitlines() if line.strip()]
    return post_and_wait_for_qodo_reply(
        owner,
        repo,
        pr_number,
        message,
        match_lines,
        label="ask-qodo",
    )


def run(args: list[str]) -> None:
    """Run the ask-qodo command.

    Args:
        args: Command line arguments. Last arg is the question.
              Optional: --pr owner/repo pr_number before the question.
    """
    if not args or args[0] in ("-h", "--help"):
        print(__doc__ or "", file=sys.stderr)
        sys.exit(0)

    # Parse args
    if "--pr" in args:
        pr_idx = args.index("--pr")
        if pr_idx + 2 >= len(args):
            print("Error: --pr requires <owner/repo> <pr_number>", file=sys.stderr)
            sys.exit(1)
        owner_repo = args[pr_idx + 1]
        pr_number = args[pr_idx + 2]
        owner, repo = owner_repo.split("/", 1)
        # Question is everything except --pr and its args
        question_parts = args[:pr_idx] + args[pr_idx + 3 :]
        question = " ".join(question_parts)
    else:
        # Auto-detect PR from current branch
        owner, repo, pr_number = get_pr_info("")
        question = " ".join(args)

    if not question.strip():
        print("Error: question is required", file=sys.stderr)
        sys.exit(1)

    reply = ask_qodo(owner, repo, pr_number, question)
    print(reply)
    sys.exit(0 if reply else 1)
