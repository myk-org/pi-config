"""Apply reply/status updates to a fetched reviews JSON, then post and store.

Replaces the bespoke parse-heredocs that autoqodo loops used to hand-write
every cycle: loads a pr-<N>-reviews.json, deduplicates thread + sticky
findings for the same (path, line, body-prefix), applies replies from a
simple mapping file, then runs the same post + store pair the review loop
uses and prints a compact digest (one line per finding, no raw JSON dump).

Mapping file format (one rule per line; blank lines and '#' comments ignored):

    <path>:<line>|<reply text>   # matches findings at (path, line)
    *|<reply text>               # matches every pending finding
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.status import extract_summary

log = create_logger(__name__)

SOURCES = ("human", "qodo", "coderabbit")
# Same output dir convention the review loop uses (PROJECT_TMP_DIR = <cwd>/.pi/tmp)
DEFAULT_TMP_DIR = Path(".pi") / "tmp"
REVIEWS_GLOB = "pr-*-reviews.json"


class RepliesFileError(ValueError):
    """Raised when the replies mapping file cannot be parsed."""


def eprint(msg: str) -> None:
    """Print an operational message to stderr."""
    print(msg, file=sys.stderr)


def find_default_json(base_dir: Path | None = None) -> Path | None:
    """Return the newest pr-*-reviews.json in the output dir, or None."""
    directory = Path(base_dir) if base_dir else DEFAULT_TMP_DIR
    candidates = [p for p in directory.glob(REVIEWS_GLOB) if p.is_file()]
    if not candidates:
        log.info("No %s found in %s", REVIEWS_GLOB, directory)
        return None
    newest = max(candidates, key=lambda p: p.stat().st_mtime)
    log.info("Default reviews JSON: %s", newest)
    return newest


def parse_replies_file(path: Path) -> list[dict[str, Any]]:
    """Parse a replies mapping file into rules.

    Each rule is ``{"path": str | None, "line": int | None, "reply": str}``;
    a wildcard rule (``path`` is None) matches every pending finding.

    Raises:
        RepliesFileError: on a malformed line or an empty file.
    """
    rules: list[dict[str, Any]] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        target, sep, reply = line.partition("|")
        target, reply = target.strip(), reply.strip()
        if not sep or not reply:
            raise RepliesFileError(f"{path}:{lineno}: expected '<path>:<line>|<reply>' or '*|<reply>', got: {line!r}")
        if target == "*":
            rules.append({"path": None, "line": None, "reply": reply})
            continue
        file_part, colon, line_part = target.rpartition(":")
        if not colon or not file_part:
            raise RepliesFileError(f"{path}:{lineno}: expected '<path>:<line>|<reply>', got: {line!r}")
        try:
            rule_line = int(line_part)
        except ValueError:
            raise RepliesFileError(f"{path}:{lineno}: line number must be an integer, got: {line_part!r}") from None
        rules.append({"path": file_part, "line": rule_line, "reply": reply})
    if not rules:
        raise RepliesFileError(f"{path}: no reply rules found")
    log.info("Parsed %d reply rule(s) from %s", len(rules), path)
    return rules


def _dedupe_key(source: str, entry: dict[str, Any]) -> tuple[str, str, str, str]:
    """Dedupe key (source, path, line, body-prefix) for thread + sticky findings.

    Body normalization mirrors status.deduplicate_comments (summary line,
    lowercased, whitespace collapsed); the line number is kept so distinct
    findings in the same file stay separate.
    """
    summary = extract_summary(str(entry.get("body") or ""), 60).lower().strip()
    summary = re.sub(r"\s+", " ", summary)[:80]
    return (source, str(entry.get("path") or ""), str(entry.get("line") or ""), summary)


def _is_applicable(entry: dict[str, Any]) -> bool:
    """Only pending, non-auto-skipped entries can be addressed."""
    return entry.get("status", "pending") == "pending" and not entry.get("is_auto_skipped")


def _rule_matches(rule: dict[str, Any], entry: dict[str, Any]) -> bool:
    if rule["path"] is None:
        return True
    return entry.get("path") == rule["path"] and entry.get("line") == rule["line"]


def apply_replies(
    data: dict[str, Any],
    rules: list[dict[str, Any]] | None,
    set_status: str,
) -> list[list[dict[str, Any]]]:
    """Apply mapping rules to pending findings, updating whole dedupe groups.

    A group is every entry sharing a (source, path, line, body-prefix) key —
    the thread + sticky pair fetch produces for one Qodo finding. When any
    member matches a rule, every applicable member gets the reply and the
    target status so the pair stays in sync. With ``rules=None``, pending
    entries that already carry a reply only get their status flipped.

    Returns the updated groups (one per finding).
    """
    groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for source in SOURCES:
        for entry in data.get(source, []):
            groups.setdefault(_dedupe_key(source, entry), []).append(entry)

    updated_groups: list[list[dict[str, Any]]] = []
    for entries in groups.values():
        applicable = [e for e in entries if _is_applicable(e)]
        if not applicable:
            continue
        if rules is None:
            if not any(e.get("reply") for e in applicable):
                continue
            rule: dict[str, Any] | None = None
        else:
            matched = [r for r in rules if any(_rule_matches(r, e) for e in applicable)]
            if not matched:
                continue
            # Most specific rule wins; wildcard is the fallback
            specific = [r for r in matched if r["path"] is not None]
            rule = (specific or matched)[-1]
        for entry in applicable:
            if rule is not None:
                entry["reply"] = rule["reply"]
            entry["status"] = set_status
        updated_groups.append(applicable)

    log.info("Applied status '%s' to %d finding group(s)", set_status, len(updated_groups))
    return updated_groups


def format_digest_line(entry: dict[str, Any]) -> str:
    """One-line digest: path:line [status] severity/type — reply (80 chars max)."""
    path = entry.get("path") or "unknown"
    line = entry.get("line")
    line_str = str(line) if line is not None else ""
    status = entry.get("status") or "pending"
    label = "/".join(str(x) for x in (entry.get("priority"), entry.get("type")) if x) or "unknown"
    reply = re.sub(r"\s+", " ", str(entry.get("reply") or "")).strip()
    if len(reply) > 80:
        reply = reply[:77] + "..."
    return f"{path}:{line_str} [{status}] {label} — {reply}"


def _save_json(path: Path, data: dict[str, Any]) -> None:
    """Save the updated reviews JSON atomically (same pattern as fetch)."""
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_name, path)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    log.info("Saved updated reviews JSON to %s", path)


def _run_step(func: Callable[[str], Any], json_path: str) -> int:
    """Run post.run/store.run (both exit via sys.exit) and return their exit code."""
    try:
        func(json_path)
    except SystemExit as e:
        if e.code is None:
            return 0
        return e.code if isinstance(e.code, int) else 1
    return 0


def run(json_path: str | None = None, replies_file: str | None = None, set_status: str = "addressed") -> int:
    """Apply replies/statuses to a reviews JSON, then post and store it.

    Args:
        json_path: Reviews JSON path. Default: newest pr-*-reviews.json in .pi/tmp.
        replies_file: Mapping file ('<path>:<line>|<reply>' lines, '*' matches all
            pending). Without it, pending entries that already have a reply only
            get their status flipped.
        set_status: Target status for matched findings.

    Returns:
        Exit code (0 = success, non-zero on any failure).
    """
    from myk_pi_tools.reviews import post, store

    if json_path:
        path = Path(json_path).resolve()
    else:
        default = find_default_json()
        if default is None:
            eprint(f"Error: reviews JSON not found: {DEFAULT_TMP_DIR / REVIEWS_GLOB}")
            return 1
        path = default.resolve()
    if not path.is_file():
        eprint(f"Error: reviews JSON not found: {path}")
        return 1

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        eprint(f"Error: cannot read {path}: {e}")
        return 1

    rules: list[dict[str, Any]] | None = None
    if replies_file:
        try:
            rules = parse_replies_file(Path(replies_file))
        except (RepliesFileError, OSError) as e:
            eprint(f"Error: {e}")
            return 1

    groups = apply_replies(data, rules, set_status)

    if not groups:
        # Retry/resume path: entries already marked but not yet posted+stored
        resumable = [
            e
            for src in SOURCES
            for e in data.get(src, [])
            if e.get("status") not in (None, "pending") and not e.get("is_auto_skipped")
        ]
        if not resumable:
            eprint("Error: no pending findings matched; nothing to address")
            return 1
        digest_entries = resumable
    else:
        digest_entries = [g[0] for g in groups]

    _save_json(path, data)
    digest = [format_digest_line(e) for e in digest_entries]

    log.info("Running reviews post + store on %s", path)
    code = _run_step(post.run, str(path))
    if code != 0:
        eprint(f"reviews post failed (exit {code}) — re-run to retry unposted entries")
        return code
    code = _run_step(store.run, str(path))
    if code != 0:
        eprint(f"reviews store failed (exit {code})")
        return code

    print(f"Addressed {len(digest)} finding(s):")
    for line in digest:
        print(line)
    return 0
