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

import json
import sqlite3
import sys
from pathlib import Path

from myk_pi_tools.db.query import _get_git_root


def log(message: str) -> None:
    print(message, file=sys.stderr)


def _entry_hash(text: str) -> str:
    """FNV-1a hash matching the TypeScript implementation in memory-scoring.ts."""
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


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
        pinned_line = f"- [{category}] {summary} *(pinned)*"
        learned_line = f"- [{category}] {summary}"

        lines = content.splitlines(keepends=True)
        removed_line: str | None = None
        for candidate in (pinned_line, learned_line):
            if any(line.rstrip("\n") == candidate for line in lines):
                removed_line = candidate
                break

        if removed_line is None:
            return False

        # Remove the line from the topic file
        new_lines = [line for line in lines if line.rstrip("\n") != removed_line]
        topic_path.write_text("".join(new_lines))

        # Clean up memory-scores.json
        scores_path = self.file_path.parent / "memory-scores.json"
        if scores_path.exists():
            try:
                scores = json.loads(scores_path.read_text())
                h = _entry_hash(removed_line)
                if h in scores.get("entries", {}):
                    del scores["entries"][h]
                    scores_path.write_text(json.dumps(scores))
            except (json.JSONDecodeError, OSError) as e:
                log(f"Failed to clean memory-scores.json: {e}")

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
