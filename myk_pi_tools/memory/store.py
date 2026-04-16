"""Memory store — SQLite-backed per-repo memory.

Database location: <git-root>/.pi/memory/memories.db
"""

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from myk_pi_tools.db.query import _get_git_root


def log(message: str) -> None:
    print(message, file=sys.stderr)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    sentiment TEXT DEFAULT 'neutral',
    summary TEXT NOT NULL,
    details TEXT,
    tags TEXT
);
"""


class MemoryDB:
    """Per-repo memory database.

    Stores lessons, decisions, mistakes, patterns, and completed work
    for a specific repository. Data persists across sessions.

    Attributes:
        db_path: Path to the SQLite database file.
    """

    def __init__(self, db_path: Path | None = None) -> None:
        if db_path is None:
            git_root = _get_git_root()
            self.db_path = git_root / ".pi" / "memory" / "memories.db"
        else:
            self.db_path = db_path

        self._ensure_db()

    def _ensure_db(self) -> None:
        """Create database and table if they don't exist."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path))
        try:
            conn.executescript(_SCHEMA)
        finally:
            conn.close()

    def _connect(self, readonly: bool = True) -> sqlite3.Connection:
        """Create a database connection."""
        if readonly:
            db_uri = f"file:{quote(self.db_path.resolve().as_posix(), safe='/:')}?mode=ro"
            conn = sqlite3.connect(db_uri, uri=True)
        else:
            conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def add(
        self,
        category: str,
        summary: str,
        details: str | None = None,
        sentiment: str = "neutral",
        tags: str | None = None,
    ) -> int:
        """Add a memory entry.

        Args:
            category: One of 'lesson', 'decision', 'mistake', 'pattern', 'done', 'preference'
            summary: Short description (one line)
            details: Optional longer description
            sentiment: One of 'positive', 'negative', 'neutral'
            tags: Optional comma-separated tags

        Returns:
            The ID of the inserted memory.
        """
        valid_categories = {"lesson", "decision", "mistake", "pattern", "done", "preference"}
        if category not in valid_categories:
            raise ValueError(f"Invalid category '{category}'. Must be one of: {', '.join(sorted(valid_categories))}")

        valid_sentiments = {"positive", "negative", "neutral"}
        if sentiment not in valid_sentiments:
            raise ValueError(f"Invalid sentiment '{sentiment}'. Must be one of: {', '.join(sorted(valid_sentiments))}")

        date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        conn = self._connect(readonly=False)
        try:
            cursor = conn.execute(
                "INSERT INTO memories (date, category, sentiment, summary, details, tags) VALUES (?, ?, ?, ?, ?, ?)",
                (date, category, sentiment, summary, details, tags),
            )
            conn.commit()
            row_id = cursor.lastrowid
            assert row_id is not None
            return row_id
        finally:
            conn.close()

    def search(self, query: str, category: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Search memories by text (summary + details + tags).

        Args:
            query: Search text (matched against summary, details, and tags)
            category: Optional filter by category
            limit: Maximum results to return

        Returns:
            List of matching memory dicts.
        """
        if not self.db_path.exists():
            return []

        conn = self._connect()
        try:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql = """
                SELECT id, date, category, sentiment, summary, details, tags
                FROM memories
                WHERE (summary LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
            """
            params: list[Any] = [f"%{escaped}%", f"%{escaped}%", f"%{escaped}%"]

            if category:
                sql += " AND category = ?"
                params.append(category)

            sql += " ORDER BY date DESC, id DESC LIMIT ?"
            params.append(limit)

            cursor = conn.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]
        except sqlite3.Error as e:
            log(f"Database error: {e}")
            return []
        finally:
            conn.close()

    def list_memories(
        self,
        category: str | None = None,
        last_days: int | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List memories with optional filters.

        Args:
            category: Optional filter by category
            last_days: Optional filter to last N days
            limit: Maximum results to return

        Returns:
            List of memory dicts.
        """
        if not self.db_path.exists():
            return []

        conn = self._connect()
        try:
            sql = "SELECT id, date, category, sentiment, summary, details, tags FROM memories WHERE 1=1"
            params: list[Any] = []

            if category:
                sql += " AND category = ?"
                params.append(category)

            if last_days is not None and last_days > 0:
                sql += " AND date >= datetime('now', ?)"
                params.append(f"-{last_days} days")

            sql += " ORDER BY date DESC, id DESC LIMIT ?"
            params.append(limit)

            cursor = conn.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]
        except sqlite3.Error as e:
            log(f"Database error: {e}")
            return []
        finally:
            conn.close()

    def delete(self, memory_id: int) -> bool:
        """Delete a memory by ID.

        Returns:
            True if deleted, False if not found.
        """
        conn = self._connect(readonly=False)
        try:
            cursor = conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()
