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
from myk_pi_tools.reviews.constants import BODY_EMBEDDED_COMMENT_TYPES, QODO_STICKY_TYPES, QODO_TYPE_MAP
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

    Each rule is ``{"path": str | None, "line": int | None, "reply": str,
    "disc": str | None, "file_wildcard": bool}``:

    - ``*|<reply>`` — global wildcard, matches every pending finding.
    - ``<path>:*|<reply>`` — per-file wildcard, same reply for every
      finding in that file (never flagged ambiguous — it is intentionally
      many-to-one).
    - ``<path>:<line>|<reply>`` — matches findings whose ``[line, end_line]``
      span contains ``<line>``.
    - ``<path>:<line>~<fragment>|<reply>`` — discriminator: additionally
      requires ``<fragment>`` (case-insensitive) in the finding's body, so
      co-located findings (nested or equal spans) can be targeted singly
      (issue #945).

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
        # Strip the discriminator BEFORE splitting path/line (Qodo 7e63c710):
        # fragments copied from titles often contain colons ("Prefix: detail"),
        # so an rpartition(":") over the whole target would mis-split them.
        disc: str | None = None
        base_target = target
        if "~" in base_target:
            base_target, _, disc = base_target.partition("~")
            disc = disc.strip()
            if not disc:
                raise RepliesFileError(
                    f"{path}:{lineno}: empty discriminator after '~' — expected "
                    f"'<path>:<line>~<title-fragment>|<reply>', got: {line!r}"
                )
        file_part, colon, line_part = base_target.rpartition(":")
        if not colon or not file_part:
            raise RepliesFileError(f"{path}:{lineno}: expected '<path>:<line>|<reply>', got: {line!r}")
        if line_part == "*":
            if disc is not None:
                raise RepliesFileError(
                    f"{path}:{lineno}: a file wildcard cannot carry a discriminator — "
                    "use '<path>:<line>~<fragment>' to target one finding"
                )
            rules.append({"path": file_part, "line": None, "file_wildcard": True, "reply": reply})
            continue
        try:
            rule_line = int(line_part)
        except ValueError:
            raise RepliesFileError(f"{path}:{lineno}: line number must be an integer, got: {line_part!r}") from None
        rules.append({"path": file_part, "line": rule_line, "disc": disc, "reply": reply})
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


def _mutual_nearest_pairs(stickies: list[dict[str, Any]], threads: list[dict[str, Any]]) -> dict[int, int]:
    """One-to-one mutual-nearest pairing of sticky indexes to thread indexes.

    Distance is ``|thread line - sticky line|`` over overlapping spans,
    ties broken by line then record order. A pair forms only when the sticky
    and the thread are each other's best available match; matched records
    leave the pool and the search repeats, so a sticky displaced from its
    nearest thread (a closer sticky won that thread) still pairs with its
    next-best thread instead of being double-booked onto the nearest one.
    """
    pairs: dict[int, int] = {}  # sticky index -> thread index
    remaining_s = list(range(len(stickies)))
    remaining_t = list(range(len(threads)))
    while remaining_s and remaining_t:
        best_thread: dict[int, tuple[int, int, int]] = {}  # si -> (dist, thread line, ti)
        for si in remaining_s:
            sticky = stickies[si]
            span, line = _line_interval(sticky), sticky.get("line")
            if span is None or line is None:
                continue
            for ti in remaining_t:
                thread = threads[ti]
                tspan, tline = _line_interval(thread), thread.get("line")
                if tspan is None or tline is None or not _spans_overlap(span, tspan):
                    continue
                key = (abs(tline - line), tline, ti)
                if si not in best_thread or key < best_thread[si]:
                    best_thread[si] = key
        best_sticky: dict[int, tuple[int, int, int]] = {}  # ti -> (dist, sticky line, si)
        for si, (dist, _tline, ti) in best_thread.items():
            key = (dist, stickies[si]["line"], si)
            if ti not in best_sticky or key < best_sticky[ti]:
                best_sticky[ti] = key
        mutual = {si: ti for si, (_, _, ti) in best_thread.items() if best_sticky.get(ti, (None, None, None))[2] == si}
        if not mutual:
            break
        pairs.update(mutual)
        remaining_s = [si for si in remaining_s if si not in mutual]
        remaining_t = [ti for ti in remaining_t if ti not in mutual.values()]
    return pairs


def _line_clusters(entries: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split a dedupe group into location clusters.

    A cluster is one thread record (an entry with its own thread) plus at
    most one sticky record, paired by mutual-nearest line distance (see
    ``_mutual_nearest_pairs``): each thread and each sticky pairs at most
    once, so two same-identity stickies can never collapse onto one thread
    while that thread's own sticky goes unpaired. Unpaired stickies and
    threads stay singleton findings — sticky records never merge with each
    other through span overlap: chained spans like [10,20], [20,30],
    [30,40] are three separate findings, so a rule for line 35 cannot reach
    the line-10 finding (it would instead be ambiguous).
    """
    stickies = [e for e in entries if _is_sticky_record(e)]
    threads = [e for e in entries if not _is_sticky_record(e)]
    pairs = _mutual_nearest_pairs(stickies, threads)
    paired: dict[int, dict[str, Any]] = {}  # thread index -> its one sticky
    for si, ti in pairs.items():
        paired[ti] = stickies[si]
    clusters = [[thread, paired[ti]] if ti in paired else [thread] for ti, thread in enumerate(threads)]
    clusters.extend([sticky] for si, sticky in enumerate(stickies) if si not in pairs)
    return clusters


def _contested_sticky_ids(entries: list[dict[str, Any]]) -> set[int]:
    """Ids of stickies whose span overlaps more than one thread record.

    A contested sticky still pairs with its mutual-nearest thread, but its
    wide span must not match rules aimed at the other overlapped thread:
    such a sticky only matches a rule placed at its own reported line, so a
    rule for the other thread addresses that thread alone while the sticky
    stays reachable at the location fetch reported for it.
    """
    threads = [e for e in entries if not _is_sticky_record(e)]
    contested: set[int] = set()
    for sticky in entries:
        if not _is_sticky_record(sticky):
            continue
        span = _line_interval(sticky)
        if span is None:
            continue
        overlaps = sum(1 for t in threads if (ts := _line_interval(t)) is not None and _spans_overlap(span, ts))
        if overlaps > 1:
            contested.add(id(sticky))
    return contested


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


def _pending_entries(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Entries across SOURCES without posted_at and not auto-skipped.

    Shared by the resume path and the main path's pre-store guard: as long
    as any remain, the JSON must survive so a later run can address them
    (the review handler runs one address call per status group).
    """
    pending = [
        e for src in SOURCES for e in data.get(src, []) if not e.get("posted_at") and not e.get("is_auto_skipped")
    ]
    log.debug("%d pending (unposted, not auto-skipped) finding(s)", len(pending))
    return pending


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
    # Body-embedded comments (post.py's consolidated-comment types) carry a
    # review node_id, not a resolvable thread: post.run skips them as already
    # posted, so treating them as retries would only consume the JSON.
    if entry.get("type") in BODY_EMBEDDED_COMMENT_TYPES:
        return False
    # post.run derives the thread from node_id when thread_id is missing,
    # so either is a usable resolution handle ("null" placeholders are not).
    handle = entry.get("thread_id") or entry.get("node_id")
    if not handle or handle == "null" or entry.get("is_auto_skipped"):
        return False
    if entry.get("status", "pending") == "pending":
        return False
    return source != "human" or entry.get("status") == "addressed"


def _rule_matches(rule: dict[str, Any], entry: dict[str, Any], own_line_only: bool = False) -> bool:
    """A global wildcard matches everything; a per-file wildcard matches
    every finding in its file; a specific rule matches the entry's line
    span — or only the entry's reported line for a contested sticky or a
    finding whose span contains another finding's span. A discriminator
    (``~fragment``) additionally requires the fragment in the entry's body,
    so co-located findings can be targeted singly (issue #945).
    """
    if rule["path"] is None:
        matches = True
    elif entry.get("path") != rule["path"]:
        matches = False
    elif rule.get("file_wildcard"):
        matches = True
    elif own_line_only:
        matches = entry.get("line") == rule["line"]
    else:
        span = _line_interval(entry)
        matches = span is not None and span[0] <= rule["line"] <= span[1]
    if matches and rule.get("disc") is not None:
        matches = rule["disc"].lower() in str(entry.get("body") or "").lower()
    log.debug("rule match=%s for %s:%s", matches, entry.get("path"), entry.get("line"))
    return matches


def _contained_cluster_entry_ids(clusters: list[list[dict[str, Any]]]) -> set[int]:
    """Ids of entries in clusters whose span contains another cluster's span.

    Nested findings (A's ``[line, end_line]`` ⊇ B's — different titles, so
    different dedupe groups) make every rule line in B's span also fall in
    A's span: no ``path:line`` can target B alone (issue #945). The
    containing finding matches rules only at its own reported line, so the
    inner finding stays reachable across its whole span. Equal spans mark
    BOTH findings (each reports its own line; a rule at one finding's
    reported line no longer swallows the other). Containment compares
    DIFFERENT clusters only — a sticky's span covers its own paired thread
    by design, and that pair is one finding reached through either member.
    """
    spans: list[tuple[int, int] | None] = []
    for cluster in clusters:
        lo: int | None = None
        hi: int | None = None
        for entry in cluster:
            span = _line_interval(entry)
            if span is None:
                continue
            lo = span[0] if lo is None else min(lo, span[0])
            hi = span[1] if hi is None else max(hi, span[1])
        spans.append((lo, hi) if lo is not None and hi is not None else None)
    marked: set[int] = set()
    for i, span_a in enumerate(spans):
        if span_a is None:
            continue
        path_a = clusters[i][0].get("path")
        for j, span_b in enumerate(spans):
            if i == j or span_b is None:
                continue
            if clusters[j][0].get("path") != path_a:
                continue  # containment is per file
            if span_a[0] <= span_b[0] and span_a[1] >= span_b[1]:
                marked.update(id(entry) for entry in clusters[i])
                break
    return marked


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
    key; each group is split into location clusters (a thread record plus its
    mutual-nearest sticky record — the pair fetch produces for one Qodo
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

    # Build every cluster up front: the nested-span pass needs all findings
    # of a file ACROSS identity groups (different titles), not just one
    # group (issue #945) — and stickies contested within their group are
    # collected alongside.
    all_clusters: list[list[dict[str, Any]]] = []
    own_line_ids: set[int] = set()
    for entries in groups.values():
        own_line_ids |= _contested_sticky_ids(entries)
        all_clusters.extend(_line_clusters(entries))
    own_line_ids |= _contained_cluster_entry_ids(all_clusters)

    # Plan every update first; mutate only after all checks pass so a
    # validation failure leaves the JSON completely unchanged.
    plan: list[tuple[list[dict[str, Any]], str]] = []  # (entries, effective reply)
    errors: list[str] = []
    rule_cluster_count: dict[int, tuple[dict[str, Any], int]] = {}  # rule index -> (rule, matched clusters)

    for cluster in all_clusters:
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
        # Match against the cluster's members (the pair is one finding)
        # even when some are already posted. A contested sticky or a
        # span-containing finding matches only at its own reported line, so
        # its wide span cannot swallow rules aimed at the other findings it
        # overlaps — while a rule at its reported location still reaches it.
        matched = [
            (i, r)
            for i, r in enumerate(rules)
            if any(_rule_matches(r, e, own_line_only=id(e) in own_line_ids) for e in cluster)
        ]
        if not matched:
            continue
        # Most specific rule wins (line+discriminator > exact line >
        # per-file wildcard > global wildcard); among equals, the last
        # matching rule in file order wins. A discriminator rule outranks
        # a plain line rule (Qodo 2529b6ce): two findings sharing a line
        # with one discriminator rule and one plain rule are both resolved
        # — the disc rule takes its finding, the plain rule the rest —
        # instead of the later plain rule overriding both and tripping
        # the ambiguity check.

        def _rank(r: dict[str, Any]) -> int:
            if r["path"] is None:
                return 0
            if r.get("line") is None:
                return 1
            return 3 if r.get("disc") else 2

        rule_idx, rule = max(matched, key=lambda m: (_rank(m[1]), m[0]))
        if rule.get("line") is not None:
            count = rule_cluster_count.get(rule_idx, (rule, 0))[1]
            rule_cluster_count[rule_idx] = (rule, count + 1)
        plan.append((applicable, rule["reply"]))

    for rule, count in rule_cluster_count.values():
        if count > 1:
            log.debug("ambiguous rule %s:%s matches %d findings", rule["path"], rule["line"], count)
            errors.append(
                f"{rule['path']}:{rule['line']}: rule matches {count} distinct findings — their "
                "[line, end_line] spans overlap at this line (a rule matches a finding's full span). "
                "Target exactly one with a discriminator: '<path>:<line>~<title-fragment>|<reply>'; "
                "give every matched finding the same reply with '<path>:*|<reply>' (this file) or "
                "'*|<reply>' (everything); or narrow the span by editing line/end_line in the "
                "reviews JSON (matching only — posting is unaffected)"
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
        # Defense in depth: never let store delete the JSON while findings
        # still await a reply (unposted, not auto-skipped) — the file must
        # survive for a future run to address them.
        posted_data = json.loads(path.read_text(encoding="utf-8"))
        pending = _pending_entries(posted_data)
        if pending:
            eprint(f"{len(pending)} finding(s) still pending — JSON kept: {path}")
            for _, entry in resume:
                print(format_digest_line(entry))
            return 0
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

    # The review handler runs one address call per status group against this
    # same JSON: while findings for later groups are still pending (unposted,
    # not auto-skipped), store must not run — it would delete the JSON and
    # those groups would fail with "reviews JSON not found".
    pending = _pending_entries(json.loads(path.read_text(encoding="utf-8")))
    if pending:
        log.info("Keeping %s: %d finding(s) still pending for later status groups", path, len(pending))
        print(f"Addressed {len(digest)} finding(s):")
        for line in digest:
            print(line)
        eprint(f"{len(pending)} finding(s) still pending — JSON kept: {path}")
        return 0

    code = _run_step(store.run, str(path))
    if code != 0:
        eprint(f"reviews store failed (exit {code})")
        return code

    print(f"Addressed {len(digest)} finding(s):")
    for line in digest:
        print(line)
    return 0
