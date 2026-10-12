"""Memory store — topic-based markdown files per-repo memory.

File location: <git-root>/.pi/memory/topics/

Each category maps to a topic file:
  - preference → preferences.md
  - lesson → lessons.md
  - pattern → patterns.md
  - decision → decisions.md
  - done → completions.md
  - mistake → mistakes.md

Each topic file has format:
    # TopicName

    - [category] entry text *(pinned)*
    - [category] entry text
"""

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from myk_pi_tools.db.query import _get_git_root


def log(message: str) -> None:
    print(message, file=sys.stderr)


def _entry_hash(text: str) -> str:
    """SHA-256 entry key matching the TypeScript implementation in memory-scoring.ts.

    Issue #915: replaced FNV-1a (32-bit, collision-prone) with SHA-256 so the
    Python CLI and the extension agree on score keys.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _legacy_fnv_hash(text: str) -> str:
    """Pre-#915 FNV-1a score key, matching legacyFnvHash in memory-scoring.ts.

    Needed by the score cleanup so removing a topic line also deletes a score
    entry that was never migrated to its SHA-256 key (Qodo round 2, PR #916).
    """
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


@contextmanager
def _jsonl_score_lock(jsonl_path: Path) -> Iterator[None]:
    """Cross-process lock over memory-scores.jsonl, mirroring the TypeScript
    store's protocol (state-jsonl.ts): a `<file>.wlock` sidecar created with
    O_EXCL, holding the pid; a dead holder's lock is stolen. Keeps the Python
    cleanup from appending a stale snapshot over a concurrent TS mutation
    (Qodo #1, PR #916).
    """
    lock_path = Path(str(jsonl_path) + ".wlock")
    deadline = time.monotonic() + 5.0
    acquired = False
    while time.monotonic() < deadline:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            acquired = True
            break
        except FileExistsError:
            try:
                holder = int(lock_path.read_text().strip())
            except (OSError, ValueError):
                holder = 0
            if holder and holder != os.getpid():
                try:
                    os.kill(holder, 0)  # liveness probe
                except OSError:
                    try:
                        lock_path.unlink()  # dead holder — steal
                    except OSError:
                        pass
            time.sleep(0.025)
    if not acquired:
        raise OSError(f"could not acquire score lock {lock_path} within 5s")
    try:
        yield
    finally:
        try:
            lock_path.unlink()
        except OSError:
            pass


CATEGORY_TO_TOPIC: dict[str, str] = {
    "preference": "preferences",
    "lesson": "lessons",
    "pattern": "patterns",
    "decision": "decisions",
    "done": "completions",
    "mistake": "mistakes",
}


def _topic_template(topic_name: str) -> str:
    """Return the template for a new topic file."""
    title = topic_name.replace("-", " ").title()
    return f"# {title}\n"


class MemoryFile:
    """Per-repo memory using topic files.

    Manages markdown files under a topics directory, one per category.
    Entries can be pinned (protected from dreaming) or learned (auto-extracted).
    """

    def __init__(self, file_path: Path | None = None) -> None:
        if file_path is None:
            git_root = _get_git_root()
            self.file_path = git_root / ".pi" / "memory" / "topics"
        else:
            self.file_path = file_path

    def _topic_path(self, category: str) -> Path:
        """Get the file path for a category's topic file."""
        topic = CATEGORY_TO_TOPIC.get(category, category)
        return self.file_path / f"{topic}.md"

    def _ensure_dir(self) -> None:
        """Create topics directory if it doesn't exist."""
        self.file_path.mkdir(parents=True, exist_ok=True)

    def _ensure_topic(self, category: str) -> Path:
        """Ensure a topic file exists, creating it with template if needed."""
        self._ensure_dir()
        path = self._topic_path(category)
        if not path.exists():
            topic = CATEGORY_TO_TOPIC.get(category, category)
            path.write_text(_topic_template(topic))
        return path

    def read(self) -> str:
        """Read and merge all topic files into a single string."""
        self._ensure_dir()
        parts: list[str] = []
        topic_files = sorted(self.file_path.glob("*.md"))
        if not topic_files:
            return ""
        for topic_file in topic_files:
            content = topic_file.read_text().strip()
            if content:
                parts.append(content)
        return "\n\n".join(parts) + "\n" if parts else ""

    def _write_to_topic(self, category: str, entry: str) -> None:
        """Append an entry to the appropriate topic file."""
        path = self._ensure_topic(category)
        content = path.read_text()
        content = content.rstrip() + "\n" + entry + "\n"
        path.write_text(content)

    def write(self, content: str) -> None:
        """Write content directly — used for raw overwrites of a single topic."""
        self._ensure_dir()
        # For backward compat: write as-is to a general file
        # Callers should prefer _write_to_topic or add_pinned/add_learned
        general = self.file_path / "general.md"
        general.write_text(content)

    def add_pinned(self, category: str, summary: str) -> None:
        """Add a pinned memory to the appropriate topic file."""
        entry = f"- [{category}] {summary} *(pinned)*"
        self._write_to_topic(category, entry)

    def add_learned(self, category: str, summary: str) -> None:
        """Add a learned memory to the appropriate topic file."""
        entry = f"- [{category}] {summary}"
        self._write_to_topic(category, entry)

    def migrate_from_db(self) -> int:
        """One-time migration: read memories.db, write to topic files, delete db files.

        Returns number of memories migrated.
        """
        # DB lives in the parent of topics dir (.pi/memory/)
        memory_dir = self.file_path.parent
        db_path = memory_dir / "memories.db"
        if not db_path.exists():
            return 0

        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT category, summary FROM memories ORDER BY date ASC")
            rows = cursor.fetchall()
            conn.close()
        except (sqlite3.Error, Exception) as e:
            log(f"Migration error reading DB: {e}")
            return 0

        if not rows:
            # Empty DB — just clean up
            self._cleanup_db_files()
            return 0

        # Add all DB memories to topic files as learned entries
        for row in rows:
            self.add_learned(row["category"], row["summary"])

        # Clean up DB files
        self._cleanup_db_files()

        return len(rows)

    def forget(self, category: str, summary: str) -> bool:
        """Remove a memory entry from the topic file and optionally from memory-scores.json.

        Returns True if removed, False if not found.
        """
        topic_path = self._topic_path(category)
        if not topic_path.exists():
            return False

        content = topic_path.read_text()

        # Marker-agnostic match: pinned/enforced/id combinations (issue #915)
        pattern = re.compile(
            rf"^- \[{re.escape(category)}\] {re.escape(summary)}"
            r"( \*\(pinned\)\*)?( \*\(enforced\)\*)?( \{#[0-9a-f]+\})?$"
        )

        lines = content.splitlines(keepends=True)
        removed_index: int | None = None
        for i, line in enumerate(lines):
            if pattern.match(line.rstrip("\n")):
                removed_index = i
                break

        if removed_index is None:
            return False

        removed_line = lines[removed_index].rstrip("\n")

        # Remove the line from the topic file
        new_lines = [line for i, line in enumerate(lines) if i != removed_index]
        topic_path.write_text("".join(new_lines))

        # Canonical line (markers stripped) is the score key
        canonical = re.sub(
            r"( \*\(pinned\)\*)?( \*\(enforced\)\*)?( \{#[0-9a-f]+\})?$",
            "",
            removed_line,
        )
        h = _entry_hash(canonical)
        # Pre-#915 stores key entries by FNV-1a — remove BOTH keys so a
        # not-yet-migrated legacy entry cannot survive as an enforced orphan
        # that keeps blocking actions after the memory was removed
        # (Qodo round 2, PR #916).
        legacy_h = _legacy_fnv_hash(canonical)

        # Clean up the JSONL score store (current) — remove the key from the
        # latest state and append the updated state as a new line. The whole
        # read-modify-write runs under the same cross-process lock protocol
        # as the TypeScript store (`.wlock` + O_EXCL + pid liveness), so a
        # concurrent TS mutation cannot be erased by a stale Python snapshot
        # (Qodo #1, PR #916).
        jsonl_path = self.file_path.parent / "memory-scores.jsonl"
        if jsonl_path.exists():
            try:
                with _jsonl_score_lock(jsonl_path):
                    latest = None
                    for raw in jsonl_path.read_text().splitlines():
                        raw = raw.strip()
                        if not raw:
                            continue
                        try:
                            parsed = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(parsed, dict):
                            latest = parsed
                    if latest is not None and (h in latest.get("entries", {}) or legacy_h in latest.get("entries", {})):
                        latest.get("entries", {}).pop(h, None)
                        latest.get("entries", {}).pop(legacy_h, None)
                        with jsonl_path.open("a", encoding="utf-8") as f:
                            f.write(json.dumps(latest) + "\n")
            except OSError as e:
                log(f"Failed to clean up memory-scores.jsonl: {e}")

        # Clean up legacy memory-scores.json (pre-JSONL stores; keys there are
        # always legacy FNV — remove both spellings for safety)
        scores_path = self.file_path.parent / "memory-scores.json"
        if scores_path.exists():
            try:
                scores = json.loads(scores_path.read_text())
                if h in scores.get("entries", {}) or legacy_h in scores.get("entries", {}):
                    scores.get("entries", {}).pop(h, None)
                    scores.get("entries", {}).pop(legacy_h, None)
                    scores_path.write_text(json.dumps(scores))
            except (json.JSONDecodeError, OSError) as e:
                log(f"Failed to clean up memory-scores.json: {e}")

        return True

    def _cleanup_db_files(self) -> None:
        """Remove SQLite DB and related files."""
        memory_dir = self.file_path.parent
        for filename in ["memories.db", "dreams.md", "dreams.lock"]:
            path = memory_dir / filename
            if path.exists():
                try:
                    path.unlink()
                except OSError as e:
                    log(f"Failed to delete {path}: {e}")
