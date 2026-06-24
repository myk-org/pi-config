"""Tests for the memory module."""

import json
import sqlite3
from pathlib import Path

import pytest

from myk_pi_tools.memory.store import CATEGORY_TO_TOPIC, MemoryFile, _entry_hash, _topic_template


@pytest.fixture
def memory_file(tmp_path: Path) -> MemoryFile:
    """Create a MemoryFile with a temporary topics directory."""
    topics_dir = tmp_path / "topics"
    return MemoryFile(file_path=topics_dir)


class TestMemoryFile:
    def test_creates_dir_on_read(self, memory_file: MemoryFile) -> None:
        content = memory_file.read()
        assert memory_file.file_path.exists()
        assert memory_file.file_path.is_dir()
        assert content == ""

    def test_creates_parent_dirs(self, tmp_path: Path) -> None:
        topics_dir = tmp_path / "sub" / "dir" / "topics"
        mem = MemoryFile(file_path=topics_dir)
        mem.read()
        assert topics_dir.exists()

    def test_topic_template_structure(self) -> None:
        template = _topic_template("lessons")
        assert template == "# Lessons\n"

    def test_category_to_topic_mapping(self) -> None:
        assert CATEGORY_TO_TOPIC["preference"] == "preferences"
        assert CATEGORY_TO_TOPIC["lesson"] == "lessons"
        assert CATEGORY_TO_TOPIC["pattern"] == "patterns"
        assert CATEGORY_TO_TOPIC["decision"] == "decisions"
        assert CATEGORY_TO_TOPIC["done"] == "completions"
        assert CATEGORY_TO_TOPIC["mistake"] == "mistakes"


class TestAddPinned:
    def test_add_pinned(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("lesson", "Always use uv run")
        content = memory_file.read()
        assert "- [lesson] Always use uv run *(pinned)*" in content

    def test_pinned_appears_in_correct_topic_file(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("preference", "Never merge without asking")
        topic_path = memory_file.file_path / "preferences.md"
        assert topic_path.exists()
        content = topic_path.read_text()
        assert "# Preferences" in content
        assert "- [preference] Never merge without asking *(pinned)*" in content

    def test_add_multiple_pinned(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("lesson", "First lesson")
        memory_file.add_pinned("preference", "Second preference")
        # Each goes to its own topic file
        lessons = (memory_file.file_path / "lessons.md").read_text()
        prefs = (memory_file.file_path / "preferences.md").read_text()
        assert "- [lesson] First lesson *(pinned)*" in lessons
        assert "- [preference] Second preference *(pinned)*" in prefs

    def test_add_multiple_to_same_topic(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("lesson", "First lesson")
        memory_file.add_pinned("lesson", "Second lesson")
        content = (memory_file.file_path / "lessons.md").read_text()
        assert "- [lesson] First lesson *(pinned)*" in content
        assert "- [lesson] Second lesson *(pinned)*" in content


class TestAddLearned:
    def test_add_learned(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("mistake", "Used sleep for polling")
        content = memory_file.read()
        assert "- [mistake] Used sleep for polling" in content

    def test_learned_appears_in_correct_topic_file(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Cache mounts need uid")
        topic_path = memory_file.file_path / "lessons.md"
        assert topic_path.exists()
        content = topic_path.read_text()
        assert "# Lessons" in content
        assert "- [lesson] Cache mounts need uid" in content

    def test_add_multiple_learned(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "First")
        memory_file.add_learned("mistake", "Second")
        lessons = (memory_file.file_path / "lessons.md").read_text()
        mistakes = (memory_file.file_path / "mistakes.md").read_text()
        assert "- [lesson] First" in lessons
        assert "- [mistake] Second" in mistakes

    def test_learned_not_marked_pinned(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Some lesson")
        content = (memory_file.file_path / "lessons.md").read_text()
        assert "*(pinned)*" not in content


class TestMixedEntries:
    def test_pinned_and_learned_in_same_topic(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("lesson", "Pinned entry")
        memory_file.add_learned("lesson", "Learned entry")
        content = (memory_file.file_path / "lessons.md").read_text()
        assert "- [lesson] Pinned entry *(pinned)*" in content
        assert "- [lesson] Learned entry" in content

    def test_read_merges_all_topics(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("preference", "Pinned pref")
        memory_file.add_learned("lesson", "Learned lesson")
        memory_file.add_learned("mistake", "A mistake")
        content = memory_file.read()
        assert "Pinned pref" in content
        assert "Learned lesson" in content
        assert "A mistake" in content

    def test_read_topics_sorted_alphabetically(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("mistake", "A mistake")
        memory_file.add_learned("lesson", "A lesson")
        content = memory_file.read()
        # lessons.md comes before mistakes.md alphabetically
        lesson_pos = content.index("A lesson")
        mistake_pos = content.index("A mistake")
        assert lesson_pos < mistake_pos


class TestForget:
    def test_forget_learned_entry(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Some lesson")
        assert memory_file.forget("lesson", "Some lesson") is True
        content = (memory_file.file_path / "lessons.md").read_text()
        assert "Some lesson" not in content

    def test_forget_pinned_entry(self, memory_file: MemoryFile) -> None:
        memory_file.add_pinned("preference", "Always use uv")
        assert memory_file.forget("preference", "Always use uv") is True
        content = (memory_file.file_path / "preferences.md").read_text()
        assert "Always use uv" not in content

    def test_forget_nonexistent_entry(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Existing lesson")
        assert memory_file.forget("lesson", "Does not exist") is False

    def test_forget_nonexistent_topic_file(self, memory_file: MemoryFile) -> None:
        assert memory_file.forget("lesson", "No topic file") is False

    def test_forget_leaves_other_entries(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Keep this")
        memory_file.add_learned("lesson", "Remove this")
        assert memory_file.forget("lesson", "Remove this") is True
        content = (memory_file.file_path / "lessons.md").read_text()
        assert "Keep this" in content
        assert "Remove this" not in content

    def test_forget_cleans_scores_file(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Some lesson")
        line = "- [lesson] Some lesson"
        scores = {"entries": {_entry_hash(line): {"class": "lesson", "score": 1.0}}}
        # scores file lives in parent of topics dir
        scores_path = memory_file.file_path.parent / "memory-scores.json"
        scores_path.parent.mkdir(parents=True, exist_ok=True)
        scores_path.write_text(json.dumps(scores))

        assert memory_file.forget("lesson", "Some lesson") is True
        updated = json.loads(scores_path.read_text())
        assert _entry_hash(line) not in updated["entries"]

    def test_forget_no_scores_file(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "Some lesson")
        scores_path = memory_file.file_path.parent / "memory-scores.json"
        assert not scores_path.exists()
        assert memory_file.forget("lesson", "Some lesson") is True


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
        # DB lives in .pi/memory/, topics dir is .pi/memory/topics/
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir(parents=True)
        db_path = memory_dir / "memories.db"
        self._create_test_db(db_path)
        topics_dir = memory_dir / "topics"
        mem = MemoryFile(file_path=topics_dir)
        count = mem.migrate_from_db()
        assert count == 3
        content = mem.read()
        assert "- [lesson] Test lesson one" in content
        assert "- [preference] Test preference" in content
        assert "- [mistake] Test mistake" in content
        # Verify entries went to correct topic files
        assert (topics_dir / "lessons.md").exists()
        assert (topics_dir / "preferences.md").exists()
        assert (topics_dir / "mistakes.md").exists()

    def test_migrate_deletes_db(self, tmp_path: Path) -> None:
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir(parents=True)
        db_path = memory_dir / "memories.db"
        self._create_test_db(db_path)
        # Also create dreams files
        (memory_dir / "dreams.md").write_text("old dreams")
        (memory_dir / "dreams.lock").write_text("")
        topics_dir = memory_dir / "topics"
        mem = MemoryFile(file_path=topics_dir)
        mem.migrate_from_db()
        assert not db_path.exists()
        assert not (memory_dir / "dreams.md").exists()
        assert not (memory_dir / "dreams.lock").exists()

    def test_migrate_no_db(self, tmp_path: Path) -> None:
        topics_dir = tmp_path / "memory" / "topics"
        mem = MemoryFile(file_path=topics_dir)
        count = mem.migrate_from_db()
        assert count == 0

    def test_migrate_empty_db(self, tmp_path: Path) -> None:
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir(parents=True)
        db_path = memory_dir / "memories.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, date TEXT, category TEXT, summary TEXT)")
        conn.commit()
        conn.close()
        topics_dir = memory_dir / "topics"
        mem = MemoryFile(file_path=topics_dir)
        count = mem.migrate_from_db()
        assert count == 0
        assert not db_path.exists()

    def test_migrate_idempotent(self, tmp_path: Path) -> None:
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir(parents=True)
        db_path = memory_dir / "memories.db"
        self._create_test_db(db_path)
        topics_dir = memory_dir / "topics"
        mem = MemoryFile(file_path=topics_dir)
        mem.migrate_from_db()
        # Second call — no DB, returns 0
        count = mem.migrate_from_db()
        assert count == 0
