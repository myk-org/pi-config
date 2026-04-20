"""Memory store — SQLite-backed per-repo memory.

Database location: <git-root>/.pi/memory/memories.db

The scoring, pruning, and dreaming features are inspired by OpenClaw's
"Dreaming" memory consolidation system (v2026.4.5).
See: https://docs.openclaw.ai/concepts/dreaming
"""

import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from myk_pi_tools.db.query import _get_git_root


def log(message: str) -> None:
    print(message, file=sys.stderr)


def _parse_utc(date_str: str) -> datetime:
    """Parse a UTC datetime string from the database."""
    return datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    sentiment TEXT DEFAULT 'neutral',
    summary TEXT NOT NULL,
    details TEXT,
    tags TEXT,
    recall_count INTEGER DEFAULT 0,
    last_recalled TEXT
);
"""

# Scoring weights — inspired by OpenClaw's deep-phase ranking signals
# See: https://docs.openclaw.ai/concepts/dreaming
_WEIGHT_RECALL_FREQ = 0.30
_WEIGHT_RECALL_RECENCY = 0.25
_WEIGHT_AGE_VALUE = 0.20
_WEIGHT_CATEGORY = 0.15
_WEIGHT_FRESHNESS = 0.10
_RECALL_RECENCY_WINDOW_DAYS = 90
_FRESHNESS_WINDOW_DAYS = 60
_AGE_VALUE_WINDOW_DAYS = 30


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
            self._migrate_schema(conn)
        finally:
            conn.close()

    def _migrate_schema(self, conn: sqlite3.Connection) -> None:
        """Apply forward-compatible schema migrations.

        Uses PRAGMA table_info to check for missing columns before adding,
        consistent with the ReviewDB migration pattern in db/query.py.
        """
        cursor = conn.execute("PRAGMA table_info(memories)")
        columns = {row[1] for row in cursor.fetchall()}
        if "recall_count" not in columns:
            conn.execute("ALTER TABLE memories ADD COLUMN recall_count INTEGER DEFAULT 0")
        if "last_recalled" not in columns:
            conn.execute("ALTER TABLE memories ADD COLUMN last_recalled TEXT")
        conn.commit()

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
                SELECT id, date, category, sentiment, summary, details, tags, recall_count, last_recalled
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
            results = [dict(row) for row in cursor.fetchall()]
        except sqlite3.Error as e:
            log(f"Database error: {e}")
            return []
        finally:
            conn.close()

        # Track recall for returned results
        if results:
            now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            write_conn = self._connect(readonly=False)
            try:
                ids = [r["id"] for r in results]
                placeholders = ",".join("?" * len(ids))
                sql = (
                    "UPDATE memories SET recall_count = recall_count + 1,"
                    f" last_recalled = ? WHERE id IN ({placeholders})"
                )
                write_conn.execute(sql, [now, *ids])
                write_conn.commit()
            except sqlite3.Error:
                pass  # Best-effort tracking
            finally:
                write_conn.close()

        return results

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
            sql = (
                "SELECT id, date, category, sentiment, summary, details, tags,"
                " recall_count, last_recalled FROM memories WHERE 1=1"
            )
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

    def score_memories(self, limit: int = 50) -> list[dict[str, Any]]:
        """Score all memories by weighted signals.

        Scoring approach inspired by OpenClaw's deep-phase ranking signals.
        See: https://docs.openclaw.ai/concepts/dreaming

        Signals:
        - recall_frequency (0.30): recall_count normalized
        - recency (0.25): days since last recalled (inverse)
        - age_value (0.20): older memories that are still recalled are valuable
        - category_weight (0.15): lessons/mistakes > decisions > preferences > done/pattern
        - freshness (0.10): days since created (inverse)

        Returns:
            List of memory dicts with 'score' field, sorted by score descending.
        """
        if not self.db_path.exists():
            return []

        conn = self._connect()
        try:
            cursor = conn.execute(
                "SELECT id, date, category, sentiment, summary, details, tags,"
                " recall_count, last_recalled FROM memories"
            )
            memories = [dict(row) for row in cursor.fetchall()]
        except sqlite3.Error as e:
            log(f"Database error: {e}")
            return []
        finally:
            conn.close()

        if not memories:
            return []

        category_weights = {
            "lesson": 1.0,
            "mistake": 1.0,
            "decision": 0.8,
            "preference": 0.7,
            "pattern": 0.5,
            "done": 0.3,
        }

        now = datetime.now(timezone.utc)
        max_recall = max((m.get("recall_count") or 0) for m in memories) or 1

        for m in memories:
            recall_count = m.get("recall_count") or 0
            created = _parse_utc(m["date"])
            age_days = (now - created).days

            # Recall frequency (normalized)
            recall_freq = recall_count / max_recall

            # Recency of last recall
            if m.get("last_recalled"):
                last_recalled = _parse_utc(m["last_recalled"])
                recall_recency = max(0, 1 - (now - last_recalled).days / _RECALL_RECENCY_WINDOW_DAYS)
            else:
                recall_recency = 0.0

            # Age value: older + recalled = valuable
            age_value = min(age_days / _AGE_VALUE_WINDOW_DAYS, 1.0) * (1 if recall_count > 0 else 0.2)

            # Category weight
            cat_weight = category_weights.get(m["category"], 0.5)

            # Freshness (inverse age, for new memories)
            freshness = max(0, 1 - age_days / _FRESHNESS_WINDOW_DAYS)

            score = (
                _WEIGHT_RECALL_FREQ * recall_freq
                + _WEIGHT_RECALL_RECENCY * recall_recency
                + _WEIGHT_AGE_VALUE * age_value
                + _WEIGHT_CATEGORY * cat_weight
                + _WEIGHT_FRESHNESS * freshness
            )
            m["score"] = round(score, 3)

        memories.sort(key=lambda m: m["score"], reverse=True)
        return memories[:limit]

    def prune(self, min_score: float = 0.1, max_age_days: int = 90, dry_run: bool = True) -> list[dict[str, Any]]:
        """Prune low-value memories.

        Removes memories that:
        - Score below min_score AND are older than 30 days
        - Are category 'done' and older than max_age_days with no recalls
        - Have never been recalled and are older than max_age_days

        Args:
            min_score: Minimum score threshold
            max_age_days: Maximum age for unrecalled memories
            dry_run: If True, return candidates without deleting

        Returns:
            List of pruned (or to-be-pruned) memory dicts.
        """
        scored = self.score_memories(limit=10000)
        now = datetime.now(timezone.utc)

        to_prune = []
        for m in scored:
            created = _parse_utc(m["date"])
            age_days = (now - created).days
            recall_count = m.get("recall_count") or 0

            should_prune = False
            reason = ""

            # Low score + old enough
            if m["score"] < min_score and age_days > 30:
                should_prune = True
                reason = f"low score ({m['score']}) and {age_days} days old"

            # Done category, old, never recalled
            elif m["category"] == "done" and age_days > max_age_days and recall_count == 0:
                should_prune = True
                reason = f"done category, {age_days} days old, never recalled"

            # Never recalled and very old
            elif recall_count == 0 and age_days > max_age_days:
                should_prune = True
                reason = f"never recalled, {age_days} days old"

            if should_prune:
                m["prune_reason"] = reason
                to_prune.append(m)

        if not dry_run and to_prune:
            conn = self._connect(readonly=False)
            try:
                ids = [m["id"] for m in to_prune]
                placeholders = ",".join("?" * len(ids))
                conn.execute(f"DELETE FROM memories WHERE id IN ({placeholders})", ids)
                conn.commit()
            finally:
                conn.close()

        return to_prune

    def stats(self) -> dict[str, Any]:
        """Get memory statistics.

        Returns:
            Dict with total count, category breakdown, recall stats.
        """
        if not self.db_path.exists():
            return {"total": 0, "categories": {}, "recalled": 0, "never_recalled": 0}

        conn = self._connect()
        try:
            total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            categories = {}
            for row in conn.execute("SELECT category, COUNT(*) as cnt FROM memories GROUP BY category"):
                categories[row[0]] = row[1]
            recalled = conn.execute("SELECT COUNT(*) FROM memories WHERE recall_count > 0").fetchone()[0]
            never_recalled = conn.execute(
                "SELECT COUNT(*) FROM memories WHERE recall_count = 0 OR recall_count IS NULL"
            ).fetchone()[0]
            top_recalled = conn.execute(
                "SELECT id, summary, recall_count FROM memories"
                " WHERE recall_count > 0 ORDER BY recall_count DESC LIMIT 5"
            ).fetchall()

            return {
                "total": total,
                "categories": categories,
                "recalled": recalled,
                "never_recalled": never_recalled,
                "top_recalled": [{"id": r[0], "summary": r[1], "recall_count": r[2]} for r in top_recalled],
            }
        except sqlite3.Error as e:
            log(f"Database error: {e}")
            return {"total": 0, "categories": {}, "recalled": 0, "never_recalled": 0}
        finally:
            conn.close()

    def _find_duplicates(self) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Find duplicate memory pairs using exact and fuzzy matching.

        Compares every pair of memories for similarity:
        - Exact match: normalized summaries identical (case-insensitive, stripped)
        - Fuzzy match: Jaccard similarity of word sets >= 0.75

        Returns:
            List of (keep, remove) tuples. The memory with higher recall_count
            is kept; ties broken by higher id (newer).
        """
        if not self.db_path.exists():
            return []

        conn = self._connect()
        try:
            cursor = conn.execute(
                "SELECT id, date, category, sentiment, summary, details, tags,"
                " recall_count, last_recalled FROM memories"
            )
            memories = [dict(row) for row in cursor.fetchall()]
        except sqlite3.Error as e:
            log(f"Database error: {e}")
            return []
        finally:
            conn.close()

        if len(memories) < 2:
            return []

        def _normalize(text: str) -> str:
            return text.strip().lower()

        def _tokenize(text: str) -> set[str]:
            tokens = set()
            for word in text.lower().split():
                cleaned = re.sub(r"[^a-z0-9]", "", word)
                if cleaned:
                    tokens.add(cleaned)
            return tokens

        def _jaccard(set_a: set[str], set_b: set[str]) -> float:
            if not set_a and not set_b:
                return 1.0
            union = set_a | set_b
            if not union:
                return 0.0
            return len(set_a & set_b) / len(union)

        def _pick_keep_remove(a: dict[str, Any], b: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            rc_a = a.get("recall_count") or 0
            rc_b = b.get("recall_count") or 0
            if rc_a > rc_b:
                return a, b
            if rc_b > rc_a:
                return b, a
            # Equal recall_count — keep newer (higher id)
            return (a, b) if a["id"] > b["id"] else (b, a)

        # Pre-compute normalized summaries and token sets
        norm_cache: dict[int, str] = {}
        token_cache: dict[int, set[str]] = {}
        for m in memories:
            norm_cache[m["id"]] = _normalize(m["summary"])
            token_cache[m["id"]] = _tokenize(m["summary"])

        matched_ids: set[int] = set()
        pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []

        for i, a in enumerate(memories):
            if a["id"] in matched_ids:
                continue
            for b in memories[i + 1 :]:
                if b["id"] in matched_ids:
                    continue

                is_dup = False
                # Exact match
                if norm_cache[a["id"]] == norm_cache[b["id"]]:
                    is_dup = True
                # Fuzzy match
                elif _jaccard(token_cache[a["id"]], token_cache[b["id"]]) >= 0.75:
                    is_dup = True

                if is_dup:
                    keep, remove = _pick_keep_remove(a, b)
                    pairs.append((keep, remove))
                    matched_ids.add(a["id"])
                    matched_ids.add(b["id"])
                    break  # a is matched, move to next i

        return pairs

    def merge_duplicates(self, dry_run: bool = True) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Detect and merge duplicate memories.

        Args:
            dry_run: If True, return duplicate pairs without deleting.

        Returns:
            List of (keep, remove) pairs.
        """
        pairs = self._find_duplicates()

        if not dry_run and pairs:
            conn = self._connect(readonly=False)
            try:
                ids_to_delete = [remove["id"] for _, remove in pairs]
                placeholders = ",".join("?" * len(ids_to_delete))
                conn.execute(
                    f"DELETE FROM memories WHERE id IN ({placeholders})",
                    ids_to_delete,
                )
                conn.commit()
            finally:
                conn.close()

        return pairs

    def dream(self) -> str:
        """Run full memory consolidation — score, prune, merge duplicates, report.

        Self-contained action that performs ALL maintenance in one call:
        1. Score all memories
        2. Prune low-value memories (actually deletes them)
        3. Merge duplicate memories (actually deletes duplicates)
        4. Generate a report of everything done

        Inspired by OpenClaw's dreaming system which consolidates short-term
        signals into durable memory. See: https://docs.openclaw.ai/concepts/dreaming

        Returns:
            Dream report as markdown string.
        """

        scored = self.score_memories(limit=10000)
        stats = self.stats()
        pruned = self.prune(dry_run=False)

        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        lines = [f"# Dream Report — {now}", ""]

        # Stats
        lines.append("## Stats")
        lines.append(f"- Total memories: {stats['total']}")
        lines.append(f"- Recalled at least once: {stats['recalled']}")
        lines.append(f"- Never recalled: {stats['never_recalled']}")
        if stats.get("categories"):
            cats = ", ".join(f"{k}: {v}" for k, v in sorted(stats["categories"].items()))
            lines.append(f"- Categories: {cats}")
        lines.append("")

        # Top memories
        if scored:
            lines.append("## Top memories by score")
            for m in scored[:10]:
                lines.append(f"- [{m['score']}] ({m['category']}) {m['summary']}")
            lines.append("")

        # Pruned
        if pruned:
            lines.append(f"## Pruned ({len(pruned)})")
            for m in pruned:
                lines.append(f"- #{m['id']} ({m['category']}) {m['summary']} — {m['prune_reason']}")
            lines.append("")
        else:
            lines.append("## Pruned")
            lines.append("None — all memories are healthy.")
            lines.append("")

        # Duplicates
        merged_pairs = self.merge_duplicates(dry_run=False)
        if merged_pairs:
            lines.append(f"## Duplicates merged ({len(merged_pairs)})")
            for keep, remove in merged_pairs:
                keep_rc = keep.get("recall_count") or 0
                remove_rc = remove.get("recall_count") or 0
                lines.append(
                    f'- Kept #{keep["id"]} "{keep["summary"]}" (recall: {keep_rc}),'
                    f' removed #{remove["id"]} "{remove["summary"]}" (recall: {remove_rc})'
                )
            lines.append("")
        else:
            lines.append("## Duplicates merged")
            lines.append("No duplicates found.")
            lines.append("")

        return "\n".join(lines)

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
