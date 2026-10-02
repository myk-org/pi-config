"""#881: stored reviews must record the WORKTREE's HEAD, not the main worktree's.

Both `reviews store` and `pr store-pr-review` shared the database location
(`.pi/data/*.db` under the main repo root, resolved via --git-common-dir) but
also reused that same main root as the cwd for `git rev-parse HEAD`, so every
row was keyed to main's HEAD regardless of the branch under review.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

import pytest

from myk_pi_tools.pr.pr_review_store import store_pr_review
from myk_pi_tools.reviews.store import store_reviews


def _git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _commit(repo: Path, message: str) -> str:
    (repo / "file.txt").write_text(f"{message}\n", encoding="utf-8")
    _git("add", "--", "file.txt", cwd=repo)
    _git(
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "-m",
        message,
        cwd=repo,
    )
    return _git("rev-parse", "HEAD", cwd=repo)


@pytest.fixture()
def repo_with_worktree(tmp_path: Path) -> tuple[Path, Path, str, str]:
    """Build a main repo plus a second worktree, each with a distinct HEAD.

    Returns (main_root, worktree_root, main_sha, worktree_sha). No remote needed.
    """
    main = tmp_path / "main"
    main.mkdir()
    _git("init", "-b", "main", cwd=main)
    main_sha = _commit(main, "main head")

    wt = tmp_path / "feature"
    _git("worktree", "add", "-b", "feature", str(wt), cwd=main)
    wt_sha = _commit(wt, "feature head")

    assert main_sha != wt_sha
    return main, wt, main_sha, wt_sha


def test_store_reviews_records_worktree_head(
    repo_with_worktree: tuple[Path, Path, str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """reviews store keys the review to the worktree it was invoked from."""
    main, wt, main_sha, wt_sha = repo_with_worktree

    json_path = wt / "pr-42-reviews.json"
    json_path.write_text(
        json.dumps({
            "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
            "human": [{"thread_id": "t1", "body": "fix"}],
        }),
        encoding="utf-8",
    )

    monkeypatch.chdir(wt)
    store_reviews(json_path)

    # DB still lives in the main worktree (shared across worktrees)
    db = main / ".pi" / "data" / "reviews.db"
    conn = sqlite3.connect(str(db))
    try:
        stored = conn.execute("SELECT commit_sha FROM reviews WHERE pr_number = 42").fetchone()
    finally:
        conn.close()

    assert stored is not None
    assert stored[0] == wt_sha
    assert stored[0] != main_sha


def test_store_pr_review_records_worktree_head(
    repo_with_worktree: tuple[Path, Path, str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """pr store-pr-review without an explicit head_sha falls back to worktree HEAD."""
    main, wt, main_sha, wt_sha = repo_with_worktree

    monkeypatch.chdir(wt)
    store_pr_review("org", "repo", 42, [{"path": "a.py", "line": 1, "body": "fix"}])

    db = main / ".pi" / "data" / "pr-reviews.db"
    conn = sqlite3.connect(str(db))
    try:
        stored = conn.execute("SELECT head_sha FROM pr_reviews WHERE pr_number = 42").fetchone()
    finally:
        conn.close()

    assert stored is not None
    assert stored[0] == wt_sha
    assert stored[0] != main_sha
