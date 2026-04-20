"""Tests for the memory module."""

import sqlite3
from pathlib import Path

import pytest

from myk_pi_tools.memory.store import _TEMPLATE, MemoryFile


@pytest.fixture
def memory_file(tmp_path: Path) -> MemoryFile:
    """Create a MemoryFile with a temporary path."""
    file_path = tmp_path / "memory.md"
    return MemoryFile(file_path=file_path)


class TestMemoryFile:
    def test_creates_file_on_read(self, memory_file: MemoryFile) -> None:
        content = memory_file.read()
        assert memory_file.file_path.exists()
        assert "# Memories" in content
        assert "## Pinned" in content
        assert "## Learned" in content

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        file_path = tmp_path / "sub" / "dir" / "memory.md"
        mem = MemoryFile(file_path=file_path)
        mem.read()
        assert file_path.exists()

    def test_write_and_read(self, memory_file: MemoryFile) -> None:
        memory_file.write("custom content")
        assert memory_file.read() == "custom content"

    def test_template_structure(self) -> None:
        assert "## Pinned" in _TEMPLATE
        assert "## Learned" in _TEMPLATE


class TestAddPinned:
    def test_add_pinned(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("lesson", "Always use uv run")
        content = memory_file.read()
        assert "- [lesson] Always use uv run" in content

    def test_pinned_appears_in_pinned_section(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("preference", "Never merge without asking")
        content = memory_file.read()
        lines = content.split("\n")
        pinned_idx = next(i for i, line in enumerate(lines) if "## Pinned" in line)
        learned_idx = next(i for i, line in enumerate(lines) if "## Learned" in line)
        entry_idx = next(i for i, line in enumerate(lines) if "Never merge without asking" in line)
        assert pinned_idx < entry_idx < learned_idx

    def test_add_multiple_pinned(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("lesson", "First lesson")
        memory_file.add_pinned("preference", "Second preference")
        content = memory_file.read()
        assert "- [lesson] First lesson" in content
        assert "- [preference] Second preference" in content


class TestAddLearned:
    def test_add_learned(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("mistake", "Used sleep for polling")
        content = memory_file.read()
        assert "- [mistake] Used sleep for polling" in content

    def test_learned_appears_in_learned_section(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Cache mounts need uid")
        content = memory_file.read()
        lines = content.split("\n")
        learned_idx = next(i for i, line in enumerate(lines) if "## Learned" in line)
        entry_idx = next(i for i, line in enumerate(lines) if "Cache mounts need uid" in line)
        assert entry_idx > learned_idx

    def test_add_multiple_learned(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "First")
        memory_file.add_learned("mistake", "Second")
        content = memory_file.read()
        assert "- [lesson] First" in content
        assert "- [mistake] Second" in content


class TestMixedSections:
    def test_pinned_and_learned_separate(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("preference", "Pinned entry")
        memory_file.add_learned("lesson", "Learned entry")
        content = memory_file.read()
        lines = content.split("\n")
        pinned_idx = next(i for i, line in enumerate(lines) if "## Pinned" in line)
        learned_idx = next(i for i, line in enumerate(lines) if "## Learned" in line)
        pinned_entry = next(i for i, line in enumerate(lines) if "Pinned entry" in line)
        learned_entry = next(i for i, line in enumerate(lines) if "Learned entry" in line)
        assert pinned_idx < pinned_entry < learned_idx < learned_entry


class TestMigration:
    def _create_test_db(self, db_path: Path) -> None:
        """Create a test SQLite memory DB."""
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE memories ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "date TEXT NOT NULL,"
            "category TEXT NOT NULL,"
            "summary TEXT NOT NULL,"
            "sentiment TEXT DEFAULT 'neutral',"
            "details TEXT,"
            "tags TEXT,"
            "recall_count INTEGER DEFAULT 0,"
            "last_recalled TEXT"
            ")"
        )
        conn.execute(
            "INSERT INTO memories (date, category, summary) VALUES ('2026-01-01 00:00:00', 'lesson', 'Test lesson one')"
        )
        conn.execute(
            "INSERT INTO memories (date, category, summary) VALUES "
            "('2026-01-02 00:00:00', 'preference', 'Test preference')"
        )
        conn.execute(
            "INSERT INTO memories (date, category, summary) VALUES ('2026-01-03 00:00:00', 'mistake', 'Test mistake')"
        )
        conn.commit()
        conn.close()

    def test_migrate_from_db(self, tmp_path: Path) -> None:
        db_path = tmp_path / "memories.db"
        self._create_test_db(db_path)
        mem = MemoryFile(file_path=tmp_path / "memory.md")
        count = mem.migrate_from_db()
        assert count == 3
        content = mem.read()
        assert "- [lesson] Test lesson one" in content
        assert "- [preference] Test preference" in content
        assert "- [mistake] Test mistake" in content

    def test_migrate_deletes_db(self, tmp_path: Path) -> None:
        db_path = tmp_path / "memories.db"
        self._create_test_db(db_path)
        # Also create dreams files
        (tmp_path / "dreams.md").write_text("old dreams")
        (tmp_path / "dreams.lock").write_text("")
        mem = MemoryFile(file_path=tmp_path / "memory.md")
        mem.migrate_from_db()
        assert not db_path.exists()
        assert not (tmp_path / "dreams.md").exists()
        assert not (tmp_path / "dreams.lock").exists()

    def test_migrate_no_db(self, tmp_path: Path) -> None:
        mem = MemoryFile(file_path=tmp_path / "memory.md")
        count = mem.migrate_from_db()
        assert count == 0

    def test_migrate_empty_db(self, tmp_path: Path) -> None:
        db_path = tmp_path / "memories.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, date TEXT, category TEXT, summary TEXT)")
        conn.commit()
        conn.close()
        mem = MemoryFile(file_path=tmp_path / "memory.md")
        count = mem.migrate_from_db()
        assert count == 0
        assert not db_path.exists()

    def test_migrate_idempotent(self, tmp_path: Path) -> None:
        db_path = tmp_path / "memories.db"
        self._create_test_db(db_path)
        mem = MemoryFile(file_path=tmp_path / "memory.md")
        mem.migrate_from_db()
        # Second call — no DB, returns 0
        count = mem.migrate_from_db()
        assert count == 0
