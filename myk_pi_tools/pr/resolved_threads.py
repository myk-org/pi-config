"""Decide whether resolved third-party review threads are still suppressed (issue #1085).

Phase 1c of `/pr-review` has to answer one question per resolved third-party thread:
did anything change at the thread's `path` after the thread was resolved? The answer
runs here, in Python, so no fetched value (path, timestamps, ids) ever reaches a shell
command line — a contributor can name a file `x; rm -rf ~` and it stays a literal
pathspec argument to `git log`.

Every rule fails OPEN (never suppress) unless the check can prove the code is unchanged:

- unsafe path — missing, absolute, containing `..`, containing control characters
  (including newlines and NUL), or starting with `:` (Git pathspec magic);
- no usable timestamp — e.g. Qodo-CLI findings carry neither thread nor reply dates;
- shallow clone — Phase 1a clones with `--depth 50`, so a window that starts before the
  shallow boundary commit cannot be inspected and an empty `git log` proves nothing;
- path absent from HEAD — deleted or renamed files leave nothing to reason about, and an
  empty `git log` for an unknown path is not evidence of an unchanged file.

Timestamps: GitHub's review-thread API exposes no "resolved at" field, so this prefers an
explicit `resolved_at` when the caller supplies one and otherwise falls back to the last
reply's `created_at`, then to the thread's own `created_at`. Both fallbacks are at or
before the real resolution time, so the inspected window is a superset of the true one:
a derived timestamp can only make us keep a finding, never wrongly suppress one.

Two rules keep a crafted filename from answering a different question than the one asked:

- `is_safe_relative_path` rejects any path whose first segment starts with `:`, because
  Git reads a leading `:` as pathspec magic (`:(glob)`, `:(exclude)`, `:(attr:…)`, …);
- the path reaches `git log` as the single argv element `:(literal)<path>`, so wildcards
  (`*`, `?`, `[`) and any remaining magic in a real filename stay literal.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Control characters (newline, tab, NUL, …) — never valid in a GitHub review path.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_ABSOLUTE_PATH = re.compile(r"^(/|\\|[A-Za-z]:)")


def is_safe_relative_path(path: str) -> bool:
    """True when `path` is a plain repo-relative path naming exactly one file in the clone."""
    if not path or _CONTROL_CHARS.search(path):
        return False
    if _ABSOLUTE_PATH.match(path):
        return False
    segments = path.replace("\\", "/").split("/")
    # A leading ":" is pathspec magic, so Git would query a different path than the one
    # checked in HEAD — a crafted name could then look unchanged.
    if segments[0].startswith(":"):
        return False
    return ".." not in segments


def resolution_timestamp(thread: dict[str, Any]) -> tuple[str | None, str]:
    """Return the timestamp to search from, plus which source produced it.

    `resolved_at` wins when present. Otherwise the newest reply `created_at` or, for a
    thread without replies, the thread's own `created_at` — both are <= the real
    resolution time, so the window is conservative. Source is "none" when the thread
    carries no timestamp at all, and the caller must fail open on it.
    """
    if thread.get("resolved_at"):
        return str(thread["resolved_at"]), "resolved_at"
    replies = [r["created_at"] for r in thread.get("replies") or [] if r.get("created_at")]
    if replies:
        return str(max(replies)), "last_reply"
    if thread.get("created_at"):
        return str(thread["created_at"]), "created_at"
    return None, "none"


def _git(repo: Path, *args: str) -> str | None:
    """Run git in `repo` with an argument list (never a shell); None on failure."""
    try:
        result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=False, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def _parse_ts(value: str | None) -> datetime | None:
    """Parse an ISO 8601 timestamp into an aware datetime; None when unusable."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _shallow_boundary(repo: Path) -> tuple[bool, datetime | None]:
    """Return ``(is_shallow, oldest_commit_dt)`` for ``repo``.

    If ``is_shallow`` is True and the boundary cannot be determined,
    ``oldest_commit_dt`` is ``None`` (caller must fail open).
    """
    if (_git(repo, "rev-parse", "--is-shallow-repository") or "") != "true":
        return False, None
    # In a shallow clone the grafted commits are history roots — their date is the
    # oldest moment the clone covers. Unknown boundary means unknown coverage.
    boundary = (_git(repo, "rev-list", "--max-parents=0", "HEAD") or "").split()
    if not boundary:
        return True, None
    dates = [d for d in (_git(repo, "log", "--no-walk", "--format=%cI", *boundary) or "").split() if d]
    parsed = [p for p in (_parse_ts(d) for d in dates) if p is not None]
    if not parsed:
        return True, None
    return True, min(parsed)


def _predates_shallow_boundary(
    repo: Path, since: datetime, shallow_info: tuple[bool, datetime | None] | None = None
) -> bool:
    """True when `since` is older than the oldest commit this clone can see."""
    is_shallow, boundary_dt = _shallow_boundary(repo) if shallow_info is None else shallow_info
    if not is_shallow:
        return False
    if boundary_dt is None:
        return True
    return since < boundary_dt


def check_thread(
    repo: Path,
    thread: dict[str, Any],
    *,
    _cache: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the suppression verdict for one resolved third-party thread."""
    thread_id = thread.get("thread_id")
    path = str(thread.get("path") or "")
    since, source = resolution_timestamp(thread)
    since_dt = _parse_ts(since)
    verdict: dict[str, Any] = {
        "thread_id": thread_id,
        "suppressed": False,
        "resolved_at": since,
        "resolved_at_source": source,
    }

    if not is_safe_relative_path(path):
        return {**verdict, "reason": f"unsafe or missing path {path!r} — not suppressed"}
    if since_dt is None:
        return {**verdict, "reason": "no usable resolution timestamp — not suppressed"}
    shallow_info = _cache.get("shallow") if _cache is not None else None
    if _predates_shallow_boundary(repo, since_dt, shallow_info):
        return {**verdict, "reason": f"window since {since} predates the shallow clone boundary — not suppressed"}

    in_head_cache: dict[str, bool] | None = _cache.get("in_head") if _cache is not None else None
    in_head = in_head_cache.get(path) if in_head_cache is not None else None
    if in_head is None:
        in_head = _git(repo, "cat-file", "-e", f"HEAD:{path}") is not None
        if in_head_cache is not None:
            in_head_cache[path] = in_head
    if not in_head:
        return {**verdict, "reason": f"{path} is not in HEAD (deleted or renamed) — not suppressed"}

    # `:(literal)` as its own argv element — Git cannot expand wildcards or magic here.
    assert since is not None
    commits_cache: dict[tuple[str, str], list[str]] | None = _cache.get("commits") if _cache is not None else None
    cache_key = (path, since)
    commits = commits_cache.get(cache_key) if commits_cache is not None else None
    if commits is None:
        commits = (_git(repo, "log", f"--since={since}", "--format=%H", "--", f":(literal){path}") or "").split()
        if commits_cache is not None:
            commits_cache[cache_key] = commits
    if commits:
        return {**verdict, "reason": f"{len(commits)} commit(s) touched {path} since {since} — not suppressed"}
    return {**verdict, "suppressed": True, "reason": f"no commit touched {path} since {since}"}


def run(repo_dir: str, json_path: str) -> int:
    """Check every thread in a JSON file against `repo_dir`; print verdicts as JSON.

    Input: {"threads": [{"thread_id", "path", "created_at", "resolved_at", "replies"}]}
    or a bare list of threads. Output: a JSON list with one verdict per thread.
    """
    try:
        data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"Error reading {json_path}: {e}", file=sys.stderr)
        return 1

    threads = data.get("threads", []) if isinstance(data, dict) else data
    if not isinstance(threads, list):
        print('Error: expected a JSON list or {"threads": [...]}', file=sys.stderr)
        return 1

    repo = Path(repo_dir)
    if _git(repo, "rev-parse", "--git-dir") is None:
        print(f"Error: not a git repository: {repo_dir}", file=sys.stderr)
        return 1

    cache: dict[str, Any] = {
        "shallow": _shallow_boundary(repo),
        "in_head": {},
        "commits": {},
    }
    verdicts = [check_thread(repo, t, _cache=cache) for t in threads if isinstance(t, dict)]
    print(json.dumps(verdicts, separators=(",", ":")))
    return 0
