"""Shared utilities for myk_pi_tools."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from myk_pi_tools.logger import create_logger

log = create_logger(__name__)

_PR_URL_WITH_SCHEME_RE = re.compile(
    r"^https?://github\.com/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/pull/(\d+)(?:[/?#].*)?$"
)
_PR_URL_OPTIONAL_SCHEME_RE = re.compile(
    r"^(?:https?://)?github\.com/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/pull/(\d+)(?:[/?#].*)?$"
)


def find_git_root() -> Path:
    """Detect the main git repo root (resolving through git worktrees).

    Uses ``--git-common-dir`` so worktrees resolve to the shared main repo root,
    falling back to ``--show-toplevel`` and walking up to find ``.pi/``.

    Raises:
        RuntimeError: If git fails, times out, or is not installed.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).parent

        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).resolve().parent

        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
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


def run_gh(
    args: list[str],
    *,
    input: str | None = None,
    timeout: int = 60,
) -> tuple[int, str, str]:
    """Run a ``gh`` CLI command and return ``(returncode, stdout, stderr)``."""
    try:
        result = subprocess.run(
            ["gh", *args],
            input=input,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return 1, "", "gh CLI not found. Install from https://cli.github.com/"
    except subprocess.TimeoutExpired:
        return 1, "", f"Command timed out after {timeout}s"
    except subprocess.CalledProcessError as exc:
        return exc.returncode, exc.stdout or "", exc.stderr or ""


def post_issue_comment(
    owner: str,
    repo: str,
    pr_number: str | int,
    body: str,
    *,
    timeout: int = 30,
) -> tuple[bool, str, str]:
    """Post an issue/PR comment via ``gh api``.

    Returns ``(ok, stdout, error_message)``.
    """
    code, stdout, stderr = run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "-X",
            "POST",
            "-f",
            f"body={body}",
        ],
        timeout=timeout,
    )
    if code == 0:
        return True, stdout if isinstance(stdout, str) else "", ""
    err_text = stderr.strip() if isinstance(stderr, str) else ""
    if not err_text:
        err_text = f"rc={code}"
    log.warning("Failed to post issue comment on %s/%s#%s: %s", owner, repo, pr_number, err_text)
    return False, "", err_text


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
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def parse_pr_url(url: str, *, require_scheme: bool = True) -> tuple[str, str, str] | None:
    """Parse a GitHub PR URL into ``(owner, repo, pr_number)`` or ``None``."""
    pattern = _PR_URL_WITH_SCHEME_RE if require_scheme else _PR_URL_OPTIONAL_SCHEME_RE
    match = pattern.match(url.strip())
    if match:
        return match.group(1), match.group(2), match.group(3)
    return None


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


def merge_paginated_json(text: str) -> list[Any]:
    """Merge concatenated JSON arrays from gh api --paginate output.

    gh --paginate returns concatenated JSON arrays like ``[...][...]``.
    We use ``json.JSONDecoder.raw_decode`` to parse each array boundary
    correctly without corrupting bracket sequences inside string values.
    """
    merged: list[Any] = []
    decoder = json.JSONDecoder()
    idx = 0
    text = text.strip()
    while idx < len(text):
        obj, end = decoder.raw_decode(text, idx)
        if isinstance(obj, list):
            merged.extend(obj)
        else:
            merged.append(obj)
        # Skip whitespace between arrays
        idx = end
        while idx < len(text) and text[idx] in " \t\n\r":
            idx += 1
    return merged
