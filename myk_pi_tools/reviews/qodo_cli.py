"""Qodo CLI read source for the reviews subsystem (issue #958).

Reads Qodo PR-review findings through the `qodo` CLI's structured
`pr-review-session` tool instead of scraping GitHub sticky comments —
but READ ONLY. Writes (replies) stay GitHub comments via
`reviews address`; this module never calls mark-implemented/dismiss.

Source selection (per poll process):
- `qodo_cli_available()` probes `qodo --version` + `qodo read whoami`.
  Both succeed -> the CLI branch is used.
- Anything missing (no bin, not logged in, old version, probe failure)
  -> callers fall back to the existing GitHub scrape, unchanged.

The CLI appends a trailing ``  trace <hex>`` line after the JSON —
`_strip_trace_line` removes it before parsing.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from typing import Any

log = logging.getLogger(__name__)

# pr-review-session toolset with the dismiss/mark-implemented write pair
# shipped well before this; 1.0.0 is a safe floor (verified live on 1.6.0).
QODO_CLI_MIN_VERSION = (1, 0, 0)

# attribution_status values that still need attention (per the CLI catalog).
# Everything else is CLOSED: full_implementation, dismissed,
# detected_after_merge, outdated.
OPEN_ATTRIBUTION_STATUSES = frozenset({"pending", "partial_implementation", "not_implemented", "focus_areas_edited"})

# action_level is severity, not open-vs-closed.
ACTION_LEVEL_PRIORITY = {
    "action_required": "HIGH",
    "remediation_recommended": "MEDIUM",
    "informational": "LOW",
}

# CLI category -> our sticky finding type (mirrors QODO_TYPE_MAP semantics).
CATEGORY_TYPE_MAP = {
    "Correctness": "qodo_bug",
    "Security": "qodo_bug",
    "Performance": "qodo_finding",
    "Observability": "qodo_finding",
    "Maintainability": "qodo_finding",
    "Documentation": "qodo_finding",
}

_TRACE_LINE_RE = re.compile(r"\n\s{2}trace [0-9a-f]+\s*$")

_availability_cache: bool | None = None


def _parse_version(output: str) -> tuple[int, ...] | None:
    """Parse `qodo --version` output like ``1.6.0`` or ``0.1.0-next.37``."""
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", output)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def qodo_cli_available(*, force_recheck: bool = False) -> bool:
    """True when the qodo CLI is installed, new enough, and authenticated.

    Result is cached per process (the probe costs two subprocess runs).
    Failures log at debug and return False — callers treat that as "use the
    GitHub scrape", which is not an error condition.
    """
    global _availability_cache
    if _availability_cache is not None and not force_recheck:
        return _availability_cache

    binary = shutil.which("qodo")
    if not binary:
        log.debug("qodo CLI not found on PATH — using GitHub scrape")
        _availability_cache = False
        return False

    try:
        version_out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=15)
    except (subprocess.SubprocessError, OSError) as exc:
        log.debug("qodo --version probe failed: %s", exc)
        _availability_cache = False
        return False
    if version_out.returncode != 0:
        log.debug("qodo --version exited %d", version_out.returncode)
        _availability_cache = False
        return False

    version = _parse_version(version_out.stdout)
    if version is None or version < QODO_CLI_MIN_VERSION:
        log.debug(
            "qodo CLI version %s below minimum %s — using GitHub scrape",
            version_out.stdout.strip(),
            ".".join(str(p) for p in QODO_CLI_MIN_VERSION),
        )
        _availability_cache = False
        return False

    try:
        whoami = subprocess.run([binary, "read", "whoami", "--json"], capture_output=True, text=True, timeout=30)
    except (subprocess.SubprocessError, OSError) as exc:
        log.debug("qodo read whoami probe failed: %s", exc)
        _availability_cache = False
        return False
    if whoami.returncode != 0:
        log.debug("qodo read whoami exited %d — not authenticated", whoami.returncode)
        _availability_cache = False
        return False

    _availability_cache = True
    log.info("qodo CLI available and authenticated — using CLI read source")
    return True


def _strip_trace_line(output: str) -> str:
    """Remove the CLI's trailing ``  trace <hex>`` diagnostics line."""
    return _TRACE_LINE_RE.sub("", output)


def fetch_qodo_cli_findings(pr_url: str, *, extended: bool = False, timeout: int = 90) -> dict | None:
    """Run the CLI review-session read; return parsed JSON or None on failure.

    Failure (missing PR session, rate limit, malformed output) returns None so
    callers fail open to the GitHub scrape for that cycle.
    """
    binary = shutil.which("qodo")
    if not binary:
        return None

    cmd = [binary, "read", "pr-review-session", "findings", "--pr-url", pr_url, "--json"]
    if extended:
        cmd.append("--extended")

    log.debug("qodo CLI read: %s", " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.SubprocessError, OSError) as exc:
        log.warning("qodo CLI read failed (%s) — falling back to GitHub scrape", exc)
        return None

    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or "").strip()[:300]
        log.warning("qodo CLI read exited %d: %s — falling back to GitHub scrape", result.returncode, stderr)
        return None

    try:
        return json.loads(_strip_trace_line(result.stdout))
    except json.JSONDecodeError as exc:
        log.warning("qodo CLI read returned malformed JSON (%s) — falling back to GitHub scrape", exc)
        return None


def _thread_id_from_inline(inline_comment_id: str | None) -> str | None:
    """Extract the GitHub thread id from a CLI inline_comment_id.

    Format: ``gh1:PRRT_kwxxx:4348152160`` — the middle segment is the
    review thread id (same node space the GitHub scrape reports).
    """
    if not inline_comment_id:
        return None
    parts = inline_comment_id.split(":")
    if len(parts) >= 2 and parts[1]:
        return parts[1]
    return None


def _finding_is_open(finding: dict[str, Any]) -> bool:
    return finding.get("attribution_status") in OPEN_ATTRIBUTION_STATUSES


def map_cli_findings_to_threads(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Map CLI findings into the thread shape `fetch_qodo_sticky_findings` produces.

    OPEN findings become actionable pending threads; CLOSED findings become
    auto-skipped threads (counted in the "previously dismissed" summary, never
    actionable). Every thread carries ``qodo_cli: True`` so poll/analysis code
    can distinguish the transport.
    """
    threads: list[dict[str, Any]] = []
    findings = data.get("findings") or []
    session = data.get("review_session") or {}

    for finding in findings:
        attribution = finding.get("attribution_status") or "pending"
        is_open = _finding_is_open(finding)
        category = finding.get("category") or ""
        title = finding.get("title") or ""
        description = finding.get("description") or ""
        evidence = finding.get("evidence") or {}
        citations = evidence.get("citations") or [] if isinstance(evidence, dict) else []

        thread: dict[str, Any] = {
            "thread_id": _thread_id_from_inline(finding.get("inline_comment_id")),
            "node_id": None,
            "comment_id": finding.get("comment_id"),
            "author": "qodo-code-review",
            "path": finding.get("file_path") or "",
            "line": finding.get("start_line"),
            "end_line": finding.get("end_line"),
            "body": f"**{title}**\n\n{description}" if title else description,
            "title": title,
            "quality_label": category,
            "type": CATEGORY_TYPE_MAP.get(category, "qodo_finding"),
            "source": "qodo",
            "priority": ACTION_LEVEL_PRIORITY.get(finding.get("action_level") or "", "MEDIUM"),
            "reply": None,
            "status": "pending" if is_open else "skipped",
            "code_diff": finding.get("code_snippet") or "",
            "evidence": evidence.get("explanation", "") if isinstance(evidence, dict) else "",
            "evidence_refs": [c.get("source_reference", "") for c in citations if isinstance(c, dict)],
            "agent_prompt": "",
            "qodo_cli": True,
            "attribution_status": attribution,
            "finding_uuid": finding.get("id"),
            "review_run_id": finding.get("review_run_id"),
            "git_sha": finding.get("git_sha"),
        }

        if not is_open:
            # CLOSED findings behave like previously-dismissed comments:
            # present for the summary count, never actionable, never re-processed.
            thread["already_replied"] = True
            thread["is_auto_skipped"] = True
            thread["reply"] = f"Qodo CLI: finding closed ({attribution})"

        threads.append(thread)

    log.debug(
        "qodo CLI mapped %d finding(s) (%d open, %d closed) from run %s",
        len(threads),
        sum(1 for t in threads if t["status"] == "pending"),
        sum(1 for t in threads if t["status"] == "skipped"),
        session.get("run_id"),
    )
    return threads


def cli_review_state(data: dict[str, Any], head_sha: str | None) -> dict[str, Any]:
    """Derive reviewing/approval state from a CLI read (issue #958).

    Mirrors the GitHub heuristics with authoritative data:
    - reviewing: session not completed, or its commit_sha is behind the PR head
    - approved: session completed at head AND zero OPEN findings

    Returned dict doubles as an `is_qodo_approved`-compatible approval summary
    (approved/reason/total_findings/resolved_count/unresolved_count) plus the
    CLI-specific transport fields.
    """
    session = data.get("review_session") or {}
    findings = data.get("findings") or []
    status = session.get("status")
    commit_sha = session.get("commit_sha") or ""
    open_count = sum(1 for f in findings if _finding_is_open(f))
    closed_count = len(findings) - open_count

    at_head = bool(head_sha) and bool(commit_sha) and commit_sha == head_sha
    completed = status == "completed"
    reviewing = not completed or not at_head

    approved = completed and at_head and open_count == 0
    if not findings:
        reason = "no_findings"
    else:
        reason = "all_resolved"

    state = {
        "source": "qodo-cli",
        "status": status,
        "commit_sha": commit_sha,
        "head_sha": head_sha,
        "reviewing": reviewing,
        "approved": approved,
        "reason": reason,
        "total_findings": len(findings),
        "resolved_count": closed_count,
        "unresolved_count": open_count,
    }
    log.debug(
        "qodo CLI review state: status=%s at_head=%s open=%d approved=%s",
        status,
        at_head,
        open_count,
        approved,
    )
    return state


def fetch_qodo_cli_threads(
    pr_url: str, head_sha: str | None
) -> tuple[list[dict[str, Any]] | None, dict[str, Any] | None]:
    """High-level CLI read for the poll's qodo cycle.

    Returns (threads, review_state) — both None when the CLI branch cannot
    run (unavailable or the read failed), signaling the caller to use the
    GitHub scrape for this cycle. Compact read first for state; extended
    read only when OPEN findings exist (spans needed for reply mapping).
    """
    if not qodo_cli_available():
        return None, None

    data = fetch_qodo_cli_findings(pr_url, extended=False)
    if data is None:
        return None, None

    session = data.get("review_session")
    if session is None:
        # No recorded review yet — not an error, but nothing to map. The
        # GitHub scrape may still see transient comments; fall back to it.
        log.debug("qodo CLI reports no review session for %s", pr_url)
        return None, None

    has_open = any(_finding_is_open(f) for f in data.get("findings") or [])
    if has_open:
        extended_data = fetch_qodo_cli_findings(pr_url, extended=True)
        if extended_data is not None and extended_data.get("review_session") is not None:
            data = extended_data
        # Extended read failure is non-fatal: the compact data still maps,
        # just without spans — log and continue with what we have.
        else:
            log.warning("qodo CLI extended read failed — mapping compact findings without spans")

    return map_cli_findings_to_threads(data), cli_review_state(data, head_sha)
