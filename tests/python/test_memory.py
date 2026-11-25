"""Tests for the memory module."""

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from click.testing import CliRunner

from myk_pi_tools.memory.commands import memory
from myk_pi_tools.memory.store import (
    CATEGORY_TO_TOPIC,
    MemoryFile,
    _entry_hash,
    _read_latest_jsonl_dict,
    _topic_template,
)


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

    def test_migrate_writes_grouped_entries_across_topics(self, tmp_path: Path) -> None:
        memory_dir = tmp_path / "memory"
        memory_dir.mkdir(parents=True)
        db_path = memory_dir / "memories.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, date TEXT, category TEXT, summary TEXT)")
        rows = [
            ("2026-01-01 00:00:00", "lesson", "First lesson"),
            ("2026-01-02 00:00:00", "preference", "First preference"),
            ("2026-01-03 00:00:00", "lesson", "Second lesson"),
            ("2026-01-04 00:00:00", "preference", "Second preference"),
            ("2026-01-05 00:00:00", "mistake", "Only mistake"),
        ]
        conn.executemany("INSERT INTO memories (date, category, summary) VALUES (?, ?, ?)", rows)
        conn.commit()
        conn.close()

        topics_dir = memory_dir / "topics"
        mem = MemoryFile(file_path=topics_dir)
        count = mem.migrate_from_db()

        assert count == 5
        assert (topics_dir / "lessons.md").read_text(encoding="utf-8") == (
            "# Lessons\n- [lesson] First lesson\n- [lesson] Second lesson\n"
        )
        assert (topics_dir / "preferences.md").read_text(encoding="utf-8") == (
            "# Preferences\n- [preference] First preference\n- [preference] Second preference\n"
        )
        assert (topics_dir / "mistakes.md").read_text(encoding="utf-8") == ("# Mistakes\n- [mistake] Only mistake\n")

    def test_migrate_strips_trailing_whitespace_between_entries(self, tmp_path: Path) -> None:
        memory_dir = tmp_path / "migrated" / "memory"
        memory_dir.mkdir(parents=True)
        db_path = memory_dir / "memories.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, date TEXT, category TEXT, summary TEXT)")
        rows = [
            ("2026-01-01 00:00:00", "lesson", "First lesson\n"),
            ("2026-01-02 00:00:00", "lesson", "Second lesson  \n\n"),
            ("2026-01-03 00:00:00", "lesson", "Third lesson"),
        ]
        conn.executemany("INSERT INTO memories (date, category, summary) VALUES (?, ?, ?)", rows)
        conn.commit()
        conn.close()

        migrated_topics = memory_dir / "topics"
        migrated_mem = MemoryFile(file_path=migrated_topics)
        count = migrated_mem.migrate_from_db()

        seq_topics = tmp_path / "sequential" / "topics"
        seq_mem = MemoryFile(file_path=seq_topics)
        for _date, category, summary in rows:
            seq_mem.add_learned(category, summary)

        migrated_text = (migrated_topics / "lessons.md").read_text(encoding="utf-8")
        assert count == 3
        assert "\n\n" not in migrated_text
        assert migrated_text == (seq_topics / "lessons.md").read_text(encoding="utf-8")


class TestMemoryStatus:
    def test_status_reports_code_tier_counts(self, tmp_path: Path) -> None:
        topics_dir = tmp_path / "memory" / "topics"
        topics_dir.mkdir(parents=True)
        (topics_dir / "lessons.md").write_text(
            "# Lessons\n\n- [lesson] Never use `git add .`\n",
            encoding="utf-8",
        )
        hash_key = _entry_hash("- [lesson] Never use `git add .`")
        scores = {
            "entries": {
                hash_key: {
                    "class": "lesson",
                    "score": 2,
                    "evidenceCount": 3,
                    "cue": "explicit",
                    "firstSeen": "2026-07-17T00:00:00Z",
                    "lastReinforced": "2026-07-17T00:00:00Z",
                    "userState": "auto",
                    "lifecycle": "active",
                    "trigger": "bash_contains git add .",
                    "action": "block",
                }
            },
            "lastRebuild": "2026-07-17T00:00:00Z",
        }
        (tmp_path / "memory" / "memory-scores.json").write_text(
            json.dumps(scores),
            encoding="utf-8",
        )
        (tmp_path / "memory" / "promotions.md").write_text(
            "### abc\n- status: proposed\n",
            encoding="utf-8",
        )

        runner = CliRunner()
        result = runner.invoke(memory, ["--file-path", str(topics_dir), "status"])
        assert result.exit_code == 0, result.output
        assert "injected (topic lines): 1" in result.output
        assert "code-tier (enforced scores): 1" in result.output
        assert "promotion candidates (proposed): 1" in result.output
        assert "bash_contains git add ." in result.output


class TestEntryHashParity:
    """Issue #915: the Python CLI must agree with the TypeScript hash (SHA-256, 16 hex)."""

    def test_entry_hash_is_sha256_16(self) -> None:
        line = "- [lesson] Never use `git add .`"
        expected = hashlib.sha256(line.encode("utf-8")).hexdigest()[:16]
        assert _entry_hash(line) == expected
        assert len(_entry_hash(line)) == 16

    def test_entry_hash_is_not_legacy_fnv(self) -> None:
        # Legacy FNV-1a of this line was 8 hex chars — must not collide with new scheme
        line = "- [lesson] Keep tests fast"
        assert len(_entry_hash(line)) == 16

    def test_forget_removes_marker_variants(self, memory_file: MemoryFile) -> None:
        """forget() matches enforced/pinned/id marker combinations (issue #915)."""
        topics_dir = memory_file.file_path
        topics_dir.mkdir(parents=True, exist_ok=True)
        (topics_dir / "lessons.md").write_text(
            "# Lessons\n\n- [lesson] Never force-push *(enforced)* {#deadbeef}\n",
            encoding="utf-8",
        )
        assert memory_file.forget("lesson", "Never force-push") is True
        assert "Never force-push" not in (topics_dir / "lessons.md").read_text()


class TestReadLatestJsonlDict:
    def test_empty_file_returns_none(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        jsonl_path.write_bytes(b"")
        assert _read_latest_jsonl_dict(jsonl_path) is None

    def test_trailing_blank_lines(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        jsonl_path.write_text('{"a": 1}\n{"a": 2}\n\n\n', encoding="utf-8")
        assert _read_latest_jsonl_dict(jsonl_path) == {"a": 2}

    def test_trailing_whitespace_lines(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        jsonl_path.write_text('{"a": 1}\n{"a": 2}\n   \n\t\n', encoding="utf-8")
        assert _read_latest_jsonl_dict(jsonl_path) == {"a": 2}

    def test_trailing_corrupt_json_lines(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        jsonl_path.write_text('{"valid": true}\n{not valid json\n{"broken":\n', encoding="utf-8")
        assert _read_latest_jsonl_dict(jsonl_path) == {"valid": True}

    def test_trailing_non_dict_json_lines(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        jsonl_path.write_text('{"valid": true}\n[1, 2, 3]\n"just-a-string"\n42\n', encoding="utf-8")
        assert _read_latest_jsonl_dict(jsonl_path) == {"valid": True}

    def test_line_larger_than_chunk_size(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        large_payload = {"entries": {"big": "x" * 200}}
        jsonl_path.write_text(
            '{"entries": {"small": "y"}}\n' + json.dumps(large_payload) + "\n",
            encoding="utf-8",
        )
        assert _read_latest_jsonl_dict(jsonl_path, chunk_size=16) == large_payload

    def test_multibyte_utf8_split_across_chunk_boundaries(self, tmp_path: Path) -> None:
        jsonl_path = tmp_path / "scores.jsonl"
        payload = {"entries": {"k1": "🚀 café 日本語 — αβγ"}}
        jsonl_path.write_text(
            '{"entries": {"old": "prev"}}\n' + json.dumps(payload, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        assert _read_latest_jsonl_dict(jsonl_path, chunk_size=7) == payload

    @staticmethod
    def _seed_forget_jsonl(
        memory_file: MemoryFile, note: str, suffix: str = "\n"
    ) -> tuple[str, Path, dict[str, object]]:
        memory_file.add_learned("lesson", "Target rule")
        h = _entry_hash("- [lesson] Target rule")
        jsonl_path = memory_file.file_path.parent / "memory-scores.jsonl"
        state: dict[str, object] = {
            "entries": {
                h: {"class": "lesson", "score": 2.0},
                "keep": {"note": note},
            }
        }
        jsonl_path.write_text(
            json.dumps(state, ensure_ascii=False) + suffix,
            encoding="utf-8",
        )
        return h, jsonl_path, state

    def test_forget_ignores_jsonl_trailing_noise(self, memory_file: MemoryFile) -> None:
        h, jsonl_path, state = self._seed_forget_jsonl(
            memory_file,
            "plain note",
            suffix='\n\n   \n[1,2,3]\n{"broken":\n',
        )

        assert memory_file.forget("lesson", "Target rule") is True
        latest = _read_latest_jsonl_dict(jsonl_path)
        assert latest is not None
        assert h not in latest["entries"]
        assert latest["entries"]["keep"] == state["entries"]["keep"]  # type: ignore[index]

    def test_forget_preserves_large_jsonl_line(self, memory_file: MemoryFile) -> None:
        h, jsonl_path, state = self._seed_forget_jsonl(memory_file, "x" * 80000)

        assert memory_file.forget("lesson", "Target rule") is True
        latest = _read_latest_jsonl_dict(jsonl_path)
        assert latest is not None
        assert h not in latest["entries"]
        assert latest["entries"]["keep"] == state["entries"]["keep"]  # type: ignore[index]

    def test_forget_preserves_utf8_jsonl_entries(self, memory_file: MemoryFile) -> None:
        h, jsonl_path, state = self._seed_forget_jsonl(memory_file, "🚀 café 日本語 — αβγ")

        assert memory_file.forget("lesson", "Target rule") is True
        latest = _read_latest_jsonl_dict(jsonl_path)
        assert latest is not None
        assert h not in latest["entries"]
        assert latest["entries"]["keep"] == state["entries"]["keep"]  # type: ignore[index]

    def test_forget_cleans_sqlite_state_db(self, memory_file: MemoryFile) -> None:
        memory_file.add_learned("lesson", "SQLite target rule")
        h = _entry_hash("- [lesson] SQLite target rule")
        data_dir = memory_file.file_path.parent.parent / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        db_path = data_dir / "state.db"

        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE kv_state ("
            "store_key TEXT PRIMARY KEY, payload TEXT NOT NULL, "
            "revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO kv_state (store_key, payload, revision, updated_at) VALUES (?, ?, 1, ?)",
            (
                "memory-scoring",
                json.dumps({"entries": {h: {"class": "lesson", "score": 2.0}, "keep": {"class": "lesson"}}}),
                "2026-01-01T00:00:00Z",
            ),
        )
        conn.commit()
        conn.close()

        assert memory_file.forget("lesson", "SQLite target rule") is True

        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT payload, revision FROM kv_state WHERE store_key = 'memory-scoring'").fetchone()
        conn.close()
        assert row is not None
        payload = json.loads(row[0])
        assert h not in payload["entries"]
        assert "keep" in payload["entries"]
        assert row[1] == 2
