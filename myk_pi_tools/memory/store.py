"""Memory store — plain markdown file per-repo memory.

File location: <git-root>/.pi/memory/memory.md

The file has two sections:
- Pinned: user-requested memories (never auto-removed by dreaming)
- Learned: auto-extracted memories (dream may reorganize/remove)
"""

import sqlite3
import sys
from pathlib import Path

from myk_pi_tools.db.query import _get_git_root


def log(message: str) -> None:
    print(message, file=sys.stderr)


_TEMPLATE = """# Memories

## Pinned (user requested — never auto-remove)

## Learned (auto-extracted — dream may reorganize/remove)
"""


class MemoryFile:
    """Per-repo memory file.

    Manages a plain markdown file with two sections:
    - Pinned: user-requested memories, protected from dreaming
    - Learned: auto-extracted memories, dream can modify
    """

    def __init__(self, file_path: Path | None = None) -> None:
        if file_path is None:
            git_root = _get_git_root()
            self.file_path = git_root / ".pi" / "memory" / "memory.md"
        else:
            self.file_path = file_path

    def _ensure_file(self) -> None:
        """Create memory file with template if it doesn't exist."""
        if not self.file_path.exists():
            self.file_path.parent.mkdir(parents=True, exist_ok=True)
            self.file_path.write_text(_TEMPLATE)

    def read(self) -> str:
        """Read the memory file contents."""
        self._ensure_file()
        return self.file_path.read_text()

    def write(self, content: str) -> None:
        """Write content to the memory file."""
        self._ensure_file()
        self.file_path.write_text(content)

    def add_pinned(self, category: str, summary: str) -> None:
        """Add a memory to the Pinned section."""
        content = self.read()
        entry = f"- [{category}] {summary}"

        # Find the Pinned section and append after its header
        pinned_header = "## Pinned (user requested — never auto-remove)"
        if pinned_header in content:
            # Insert after the pinned header line
            lines = content.split("\n")
            insert_pos = None
            for i, line in enumerate(lines):
                if line.strip() == pinned_header:
                    # Find the insertion point — after header and any existing entries
                    insert_at = i + 1
                    while insert_at < len(lines) and (
                        lines[insert_at].startswith("- ") or lines[insert_at].strip() == ""
                    ):
                        if lines[insert_at].startswith("## "):
                            break
                        insert_at += 1
                    # Insert before the blank line or next section
                    if insert_at > i + 1 and lines[insert_at - 1].strip() == "":
                        insert_pos = insert_at - 1
                    else:
                        insert_pos = insert_at
                    break
            if insert_pos is not None:
                lines.insert(insert_pos, entry)
            self.write("\n".join(lines))
        else:
            # Fallback: just append
            content = content.rstrip() + "\n" + entry + "\n"
            self.write(content)

    def add_learned(self, category: str, summary: str) -> None:
        """Add a memory to the Learned section."""
        content = self.read()
        entry = f"- [{category}] {summary}"

        # Find the Learned section and append
        learned_header = "## Learned (auto-extracted — dream may reorganize/remove)"
        if learned_header in content:
            lines = content.split("\n")
            insert_pos = None
            for i, line in enumerate(lines):
                if line.strip() == learned_header:
                    insert_at = i + 1
                    while insert_at < len(lines) and (
                        lines[insert_at].startswith("- ") or lines[insert_at].strip() == ""
                    ):
                        if lines[insert_at].startswith("## "):
                            break
                        insert_at += 1
                    if insert_at > i + 1 and lines[insert_at - 1].strip() == "":
                        insert_pos = insert_at - 1
                    else:
                        insert_pos = insert_at
                    break
            if insert_pos is not None:
                lines.insert(insert_pos, entry)
            self.write("\n".join(lines))
        else:
            content = content.rstrip() + "\n" + entry + "\n"
            self.write(content)

    def migrate_from_db(self) -> int:
        """One-time migration: read memories.db, write to memory.md, delete db files.

        Returns number of memories migrated.
        """
        db_path = self.file_path.parent / "memories.db"
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

        # Ensure memory.md exists
        self._ensure_file()

        # Add all DB memories to Learned section
        for row in rows:
            self.add_learned(row["category"], row["summary"])

        # Clean up DB files
        self._cleanup_db_files()

        return len(rows)

    def _cleanup_db_files(self) -> None:
        """Remove SQLite DB and related files."""
        db_dir = self.file_path.parent
        for filename in ["memories.db", "dreams.md", "dreams.lock"]:
            path = db_dir / filename
            if path.exists():
                try:
                    path.unlink()
                except OSError as e:
                    log(f"Failed to delete {path}: {e}")
