"""Apply reply/status updates to a fetched reviews JSON, then post and store.

Replaces the bespoke parse-heredocs that autoqodo loops used to hand-write
every cycle: loads a pr-<N>-reviews.json, deduplicates thread + sticky
findings for the same finding (path, finding type, full normalized title,
clustered by overlapping line spans), applies
replies from a simple mapping file, then runs the same post + store pair
the review loop uses and prints a compact digest (one line per finding,
no raw JSON dump).

Mapping file format (one rule per line; blank lines and '#' comments ignored):

    <path>:<line>|<reply text>   # matches findings whose line span contains <line>
    *|<reply text>               # matches every pending finding

Entries whose posting failed in a previous run (no ``posted_at`` yet) stay
correctable: a matching rule re-applies its reply and status. Successfully
posted entries (``posted_at`` set by post.run) are never touched again.
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
from myk_pi_tools.reviews.constants import QODO_STICKY_TYPES, QODO_TYPE_MAP
from myk_pi_tools.reviews.status import extract_summary

log = create_logger(__name__)

SOURCES = ("human", "qodo", "coderabbit")
# Same output dir convention the review loop uses (PROJECT_TMP_DIR = <cwd>/.pi/tmp)
DEFAULT_TMP_DIR = Path(".pi") / "tmp"
REVIEWS_GLOB = "pr-*-reviews.json"


class RepliesFileError(ValueError):
    """Raised when the replies mapping file cannot be parsed."""


class AddressError(ValueError):
    """Raised when replies/statuses cannot be applied safely.

    Ambiguous rules (one rule matching several distinct findings) and
    statuses post.run would reject for Qodo sticky findings are detected
    before anything is persisted, so the JSON is left unchanged.
    """


def eprint(msg: str) -> None:
    """Print an operational message to stderr."""
    log.debug("stderr: %s", msg)
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


# Thread and sticky records for one finding share no explicit linkage field,
# so the finding identity is derived: inline thread bodies carry
# '<n>. Title <emoji> Type <emoji> Quality', sticky bodies '**Title**' with the
# mapped type in entry['type']. The type phrase after the first emoji maps to
# the same sticky type, so the pair shares a key while findings of different
# types stay separate. Line numbers are a clustering attribute, not identity:
# they shift between records (a sticky's [line, end_line] span covers its
# thread's line) and between commits, but distinct same-titled findings sit at
# disjoint locations.
_EMOJI_BADGES_RE = re.compile(r"[\U0001f000-\U0001faff\u2190-\u2bff]")
_TYPE_PHRASE_RE = re.compile(r"\s*([a-z][a-z\-\s]*)")
_TRAILING_TYPE_MARKER_RE = re.compile(
    r"\s*\b("
    r"bug|rule violation|requirement gap|ux issue|cross-repo conflict|"
    r"correctness|reliability|maintainability|performance|observability|"
    r"security|quality|skill insight"
    r")\b\s*$"
)
_QODO_TYPE_BY_PHRASE = {phrase.lower(): qtype for phrase, qtype in QODO_TYPE_MAP.items()}


def _clean_title(text: str) -> str:
    """Strip badge emojis from a raw title and collapse whitespace."""
    return re.sub(r"\s+", " ", _EMOJI_BADGES_RE.sub("", text).strip())


def _finding_identity(source: str, entry: dict[str, Any]) -> tuple[str, str]:
    """Return (finding type, full normalized title) identifying one finding.

    Sticky records carry the mapped type in ``entry['type']``; inline qodo
    thread bodies end with '<emoji> Type <emoji> Quality' markers, so the
    phrase after the first emoji derives the same type and the title is the
    text before it. The full (untruncated) title keeps distinct long findings
    apart — truncation is fine for display, not for identity.
    """
    raw = extract_summary(str(entry.get("body") or ""), 500).lower().strip()
    entry_type = entry.get("type")
    if source != "qodo" and entry_type not in QODO_STICKY_TYPES:
        return str(entry_type or ""), _clean_title(raw)

    def typed(finding_type: str, title: str) -> tuple[str, str]:
        # An explicit sticky type (fetch stamps it) beats marker derivation
        return (str(entry_type), title) if entry_type in QODO_STICKY_TYPES else (finding_type, title)

    marker = _EMOJI_BADGES_RE.search(raw)
    if marker:
        title = _clean_title(raw[: marker.start()])
        phrase_match = _TYPE_PHRASE_RE.match(raw, marker.end())
        phrase = phrase_match.group(1).strip() if phrase_match else ""
        return typed(_QODO_TYPE_BY_PHRASE.get(phrase, "qodo_finding"), title)
    # Legacy bodies without emoji markers: strip trailing type/quality words
    title, phrase = raw, ""
    prev: str | None = None
    while prev != title:
        prev = title
        word = _TRAILING_TYPE_MARKER_RE.search(title)
        title = _TRAILING_TYPE_MARKER_RE.sub("", title).strip()
        if word:
            phrase = word.group(1)
    return typed(_QODO_TYPE_BY_PHRASE.get(phrase, "qodo_finding"), _clean_title(title))


def _dedupe_key(source: str, entry: dict[str, Any]) -> tuple[str, str, str, str]:
    """Dedupe key (source, path, finding type, full title) for one finding.

    The line number is excluded from identity (it differs between the thread
    and sticky records of one finding and shifts between commits); members of
    a group are then split into location clusters so distinct same-titled
    findings at different lines stay separate.
    """
    finding_type, title = _finding_identity(source, entry)
    key = (source, str(entry.get("path") or ""), finding_type, title)
    log.debug("dedupe key: %s:%s type=%s", key[0], key[1], key[2])
    return key


def _line_interval(entry: dict[str, Any]) -> tuple[int, int] | None:
    """Line span of an entry: [line, end_line] (a sticky's span covers its thread)."""
    line = entry.get("line")
    if line is None:
        return None
    end = entry.get("end_line")
    lo, hi = (line, end if end is not None else line)
    return (min(lo, hi), max(lo, hi))


def _is_sticky_record(entry: dict[str, Any]) -> bool:
    """Sticky record: no thread of its own, stamped with a sticky type (fetch's rule)."""
    return not entry.get("thread_id") and entry.get("type") in QODO_STICKY_TYPES


def _spans_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def _line_clusters(entries: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split a dedupe group into location clusters.

    A cluster is one thread record (an entry with its own thread) plus the
    sticky record(s) whose line span overlaps it — a sticky's [line,
    end_line] span covers its thread's line. Sticky records never merge
    with each other through span overlap: chained spans like [10,20],
    [20,30], [30,40] are three separate findings, so a rule for line 35
    cannot reach the line-10 finding (it would instead be ambiguous).
    """
    stickies = [e for e in entries if _is_sticky_record(e)]
    clusters: list[list[dict[str, Any]]] = []
    paired: set[int] = set()  # ids of stickies already in a cluster
    for thread in entries:
        if _is_sticky_record(thread):
            continue
        cluster = [thread]
        span = _line_interval(thread)
        if span is not None:
            for sticky in stickies:
                sticky_span = _line_interval(sticky)
                if sticky_span is not None and _spans_overlap(span, sticky_span):
                    cluster.append(sticky)
                    paired.add(id(sticky))
        clusters.append(cluster)
    # Stickies containing no thread line stay their own findings
    clusters.extend([sticky] for sticky in stickies if id(sticky) not in paired)
    return clusters


def _is_addressable(entry: dict[str, Any]) -> bool:
    """Entry can be (re)addressed: never auto-skipped, never posted.

    Status is deliberately not checked: entries whose status/reply was
    saved by a run that failed to post must stay correctable with a new
    mapping. Successfully posted entries are protected by ``posted_at``,
    which post.run stamps on every successful post.
    """
    addressable = not entry.get("is_auto_skipped") and not entry.get("posted_at")
    log.debug(
        "addressable=%s for %s:%s (status=%s, posted=%s, auto_skipped=%s)",
        addressable,
        entry.get("path"),
        entry.get("line"),
        entry.get("status"),
        bool(entry.get("posted_at")),
        bool(entry.get("is_auto_skipped")),
    )
    return addressable


def _needs_resolve_retry(source: str, entry: dict[str, Any]) -> bool:
    """Entry whose reply was posted but whose thread resolve failed.

    post.run stamps ``posted_at`` and exits 1 when the resolve fails so the
    next run retries the resolve only; without this check a re-run of address
    would bail out with "no findings matched" before post ever runs.
    Mirrors post.run: only real threads are resolved, pending entries are
    skipped, and human threads resolve only when addressed.
    """
    if not entry.get("posted_at") or entry.get("resolved_at"):
        return False
    # post.run derives the thread from node_id when thread_id is missing,
    # so either is a usable resolution handle ("null" placeholders are not).
    handle = entry.get("thread_id") or entry.get("node_id")
    if not handle or handle == "null" or entry.get("is_auto_skipped"):
        return False
    if entry.get("status", "pending") == "pending":
        return False
    return source != "human" or entry.get("status") == "addressed"


def _rule_matches(rule: dict[str, Any], entry: dict[str, Any]) -> bool:
    """A wildcard rule matches everything; a specific rule matches the entry's line span."""
    if rule["path"] is None:
        matches = True
    else:
        span = _line_interval(entry)
        matches = entry.get("path") == rule["path"] and span is not None and span[0] <= rule["line"] <= span[1]
    log.debug("rule match=%s for %s:%s", matches, entry.get("path"), entry.get("line"))
    return matches


def _sticky_status_error(entry: dict[str, Any], status: str, reply: str) -> str | None:
    """Mirror post.run's Qodo sticky status rules before anything is persisted.

    Returns an error message when ``status`` would make post.run reject the
    entry, else None.
    """
    if entry.get("type") not in QODO_STICKY_TYPES or status == "addressed":
        return None
    from myk_pi_tools.reviews.post import is_linked_issue_spec_resolution

    if status == "skipped" and is_linked_issue_spec_resolution(str(reply or "")):
        return None
    location = f"{entry.get('path', 'unknown')}:{entry.get('line', '')}"
    log.debug("sticky status '%s' rejected for %s (%s)", status, location, entry.get("type"))
    return (
        f"{location}: cannot set status '{status}' on Qodo sticky finding ({entry.get('type')}) — "
        "post only allows 'addressed', or 'skipped' with a reply that documents "
        "an issue-spec update referencing an internal or GitHub issue"
    )


def apply_replies(
    data: dict[str, Any],
    rules: list[dict[str, Any]] | None,
    set_status: str,
) -> list[list[dict[str, Any]]]:
    """Apply mapping rules to findings, updating whole location clusters.

    A group is every entry sharing a (source, path, finding type, full title)
    key; each group is split into location clusters (members whose line spans
    share a line — the thread + sticky pair fetch produces for one Qodo
    finding). When any member of a cluster matches a rule, every addressable
    member gets the reply and the target status so the pair stays in sync,
    while same-titled findings at other lines stay untouched. With
    ``rules=None`` (status-only mode), pending entries in a cluster where any
    addressable member already carries a reply get that reply copied and
    their status flipped.

    Addressable entries are not auto-skipped and not yet posted, so a run
    whose post failed can be corrected by re-running with a new mapping.

    Returns the updated clusters (one list per finding location).

    Raises:
        AddressError: when a specific rule matches more than one distinct
            finding location, or the target status is invalid for a matched
            Qodo sticky finding. Nothing is modified in that case.
    """
    groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for source in SOURCES:
        for entry in data.get(source, []):
            groups.setdefault(_dedupe_key(source, entry), []).append(entry)

    # Plan every update first; mutate only after all checks pass so a
    # validation failure leaves the JSON completely unchanged.
    plan: list[tuple[list[dict[str, Any]], str]] = []  # (entries, effective reply)
    errors: list[str] = []
    rule_cluster_count: dict[int, tuple[dict[str, Any], int]] = {}  # rule index -> (rule, matched clusters)

    for entries in groups.values():
        for cluster in _line_clusters(entries):
            if rules is None:
                applicable = [e for e in cluster if e.get("status", "pending") == "pending" and _is_addressable(e)]
                if not applicable:
                    continue
                # The reply may live on a non-pending unposted sibling (a
                # previous run saved it but failed to post): source it from
                # every addressable member, not just the pending ones.
                group_reply = next((str(e["reply"]) for e in cluster if _is_addressable(e) and e.get("reply")), "")
                if not group_reply:
                    continue
                plan.append((applicable, group_reply))
                continue

            applicable = [e for e in cluster if _is_addressable(e)]
            if not applicable:
                continue
            # Match against every cluster member (the pair is one finding)
            # even when some members are already posted.
            matched = [(i, r) for i, r in enumerate(rules) if any(_rule_matches(r, e) for e in cluster)]
            if not matched:
                continue
            # Most specific rule wins; wildcard is the fallback
            specific = [(i, r) for i, r in matched if r["path"] is not None]
            rule_idx, rule = (specific or matched)[-1]
            if rule["path"] is not None:
                count = rule_cluster_count.get(rule_idx, (rule, 0))[1]
                rule_cluster_count[rule_idx] = (rule, count + 1)
            plan.append((applicable, rule["reply"]))

    for rule, count in rule_cluster_count.values():
        if count > 1:
            log.debug("ambiguous rule %s:%s matches %d findings", rule["path"], rule["line"], count)
            errors.append(
                f"{rule['path']}:{rule['line']}: rule matches {count} distinct findings at this location — "
                "it must target exactly one; extend the mapping with a body discriminator to tell them apart"
            )
    for applicable, reply in plan:
        for entry in applicable:
            err = _sticky_status_error(entry, set_status, reply)
            if err:
                errors.append(err)
    if errors:
        log.warning("address validation failed with %d error(s)", len(errors))
        raise AddressError("\n  " + "\n  ".join(errors))

    for applicable, reply in plan:
        for entry in applicable:
            entry["reply"] = reply
            entry["status"] = set_status

    log.info("Applied status '%s' to %d finding cluster(s)", set_status, len(plan))
    return [applicable for applicable, _ in plan]


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
    digest = f"{path}:{line_str} [{status}] {label} — {reply}"
    log.debug("digest line: %s", digest)
    return digest


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
    step = getattr(func, "__module__", "").rsplit(".", 1)[-1] or getattr(func, "__name__", "step")
    try:
        func(json_path)
    except SystemExit as e:
        code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
        log.info("reviews %s on %s exited %d", step, json_path, code)
        return code
    log.info("reviews %s on %s completed", step, json_path)
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
        Exit code (0 = success, non-zero on any failure). On failure the
        JSON is kept on disk so a corrected re-run can retry.
    """
    from myk_pi_tools.reviews import post, store

    log.info("reviews address: json=%s replies=%s set=%s", json_path, replies_file, set_status)

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

    try:
        groups = apply_replies(data, rules, set_status)
    except AddressError as e:
        eprint(f"Error: cannot apply replies:{e}")
        return 1

    if not groups:
        # Posted-but-unresolved entries: post.run stamped posted_at and exited
        # 1 when the resolve failed, so a re-run must retry the resolve (post)
        # and store instead of bailing out with "no findings matched".
        resume = [(src, e) for src in SOURCES for e in data.get(src, []) if _needs_resolve_retry(src, e)]
        if not resume:
            # Never fall back to posting unrelated non-pending entries: store
            # deletes the JSON after a successful insert, which would consume
            # data this run did not address. Unposted entries that match the
            # supplied rules are already re-applied above.
            log.warning("no findings matched; nothing to address")
            eprint("Error: no findings matched; nothing to address")
            return 1
        log.info("Resuming %d posted-but-unresolved finding(s)", len(resume))
        eprint(f"Resuming {len(resume)} posted-but-unresolved finding(s) (retrying resolve)")
        code = _run_step(post.run, str(path))
        if code != 0:
            eprint(f"reviews post failed (exit {code}) — re-run to retry the resolve")
            return code
        code = _run_step(store.run, str(path))
        if code != 0:
            eprint(f"reviews store failed (exit {code})")
            return code
        for _, entry in resume:
            print(format_digest_line(entry))
        return 0

    index_of = {id(e): (src, i) for src in SOURCES for i, e in enumerate(data.get(src, []))}
    _save_json(path, data)
    digest = [format_digest_line(g[0]) for g in groups]

    log.info("Running reviews post + store on %s", path)
    code = _run_step(post.run, str(path))
    if code != 0:
        eprint(f"reviews post failed (exit {code}) — re-run with the same mapping to retry unposted entries")
        return code

    # post.run exits 0 even when it skips an entry it cannot post (e.g. an
    # inline finding without a resolvable thread id). Verify every addressed
    # entry was actually posted (posted_at stamped) before store deletes
    # the JSON.
    posted_data = json.loads(path.read_text(encoding="utf-8"))
    unposted: list[str] = []
    for group in groups:
        for entry in group:
            src, idx = index_of[id(entry)]
            entries = posted_data.get(src) or []
            if idx >= len(entries) or not entries[idx].get("posted_at"):
                unposted.append(f"{entry.get('path', 'unknown')}:{entry.get('line', '')}")
    if unposted:
        log.error("%d addressed entries were not posted", len(unposted))
        eprint(
            f"Error: {len(unposted)} addressed finding(s) were not posted (no resolvable thread) — JSON kept: {path}"
        )
        return 1

    code = _run_step(store.run, str(path))
    if code != 0:
        eprint(f"reviews store failed (exit {code})")
        return code

    print(f"Addressed {len(digest)} finding(s):")
    for line in digest:
        print(line)
    return 0
