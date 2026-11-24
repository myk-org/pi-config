"""Shared utilities for myk_pi_tools."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from myk_pi_tools.github import (
    merge_paginated_json,
    parse_pr_url,
    post_issue_comment,
    run_gh,
)
from myk_pi_tools.logger import create_logger

log = create_logger(__name__)

__all__ = [
    "atomic_write_json",
    "find_git_root",
    "merge_paginated_json",
    "parse_pr_url",
    "post_issue_comment",
    "print_stderr",
    "run_gh",
    "strip_blockquote_prefix",
]


def print_stderr(msg: str) -> None:
    """Print message to stderr."""
    print(msg, file=sys.stderr)


def find_git_root(cwd: Path | None = None) -> Path:
    """Detect the main git repo root (resolving through git worktrees).

    Uses ``--git-common-dir`` so worktrees resolve to the shared main repo root,
    falling back to ``--show-toplevel`` and walking up to find ``.pi/``.

    Args:
        cwd: Optional working directory to resolve from (defaults to current directory).

    Raises:
        RuntimeError: If git fails, times out, or is not installed.
    """
    work_dir = str(cwd) if cwd is not None else None
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).parent
        if result.returncode == 128 and "not a git repository" in result.stderr.lower():
            raise RuntimeError(f"git rev-parse failed: {result.stderr.strip()}")

        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            git_dir = Path(result.stdout.strip())
            if not git_dir.is_absolute():
                base = cwd if cwd is not None else Path.cwd()
                git_dir = (base / git_dir).resolve()
            return git_dir.parent

        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git rev-parse failed: {result.stderr.strip()}")
        root = Path(result.stdout.strip())
        candidate = root
        for _ in range(5):
            if (candidate / ".pi").is_dir():
                return candidate
            if candidate.parent == candidate:
                break
            candidate = candidate.parent
        return root
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("git command timed out") from exc
    except FileNotFoundError as exc:
        raise RuntimeError("git command not found") from exc
    except OSError as exc:
        raise RuntimeError(f"git command failed: {exc}") from exc


def atomic_write_json(
    path: Path,
    data: Any,
    *,
    indent: int | None = 2,
    prefix: str | None = None,
    suffix: str = "",
) -> None:
    """Write ``data`` as JSON to ``path`` atomically via a same-directory temp file."""
    fd, tmp_name = tempfile.mkstemp(
        prefix=prefix if prefix is not None else f"{path.name}.",
        suffix=suffix,
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=indent)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def strip_blockquote_prefix(text: str, *, strip_all: bool = False) -> str:
    """Strip leading markdown blockquote ``>`` prefixes from each line.

    When ``strip_all`` is True, leading whitespace before ``>`` and all
    whitespace after ``>`` are stripped (CodeRabbit format). Otherwise only a
    leading ``>`` and at most one following space are removed (preserving
    indentation in Qodo diffs/code blocks).
    """
    lines: list[str] = []
    for line in text.splitlines():
        if strip_all:
            stripped = line.lstrip()
            if stripped.startswith(">"):
                lines.append(stripped[1:].lstrip())
            else:
                lines.append(line)
        else:
            if line.startswith(">"):
                line = line[1:]
                if line.startswith(" "):
                    line = line[1:]
            lines.append(line)
    return "\n".join(lines)
