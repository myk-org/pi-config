"""Tests for the memory module."""

from pathlib import Path

import pytest

from myk_pi_tools.memory.store import MemoryDB


@pytest.fixture
def memory_db(tmp_path: Path) -> MemoryDB:
    """Create a MemoryDB with a temporary database."""
    db_path = tmp_path / "memories.db"
    return MemoryDB(db_path=db_path)


class TestMemoryDB:
    def test_add_and_list(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Test lesson")
        results = memory_db.list_memories()
        assert len(results) == 1
        assert results[0]["summary"] == "Test lesson"
        assert results[0]["category"] == "lesson"

    def test_add_with_all_fields(self, memory_db: MemoryDB) -> None:
        mid = memory_db.add(
            category="mistake",
            summary="Used sleep for polling",
            details="Should have used async agent",
            sentiment="negative",
            tags="async,polling",
        )
        assert mid is not None
        results = memory_db.list_memories()
        assert len(results) == 1
        assert results[0]["sentiment"] == "negative"
        assert results[0]["tags"] == "async,polling"
        assert results[0]["details"] == "Should have used async agent"

    def test_invalid_category(self, memory_db: MemoryDB) -> None:
        with pytest.raises(ValueError, match="Invalid category"):
            memory_db.add(category="invalid", summary="test")

    def test_invalid_sentiment(self, memory_db: MemoryDB) -> None:
        with pytest.raises(ValueError, match="Invalid sentiment"):
            memory_db.add(category="lesson", summary="test", sentiment="angry")

    def test_search(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="buildah chown bug", tags="docker,buildah")
        memory_db.add(category="done", summary="Added security auditor")
        results = memory_db.search("buildah")
        assert len(results) == 1
        assert "buildah" in results[0]["summary"]

    def test_search_by_tags(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Some lesson", tags="docker,buildah")
        results = memory_db.search("docker")
        assert len(results) == 1

    def test_search_with_category_filter(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Docker lesson", tags="docker")
        memory_db.add(category="done", summary="Docker task done", tags="docker")
        results = memory_db.search("docker", category="lesson")
        assert len(results) == 1
        assert results[0]["category"] == "lesson"

    def test_list_by_category(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Lesson 1")
        memory_db.add(category="done", summary="Done 1")
        memory_db.add(category="lesson", summary="Lesson 2")
        results = memory_db.list_memories(category="lesson")
        assert len(results) == 2
        assert all(r["category"] == "lesson" for r in results)

    def test_list_limit(self, memory_db: MemoryDB) -> None:
        for i in range(10):
            memory_db.add(category="done", summary=f"Task {i}")
        results = memory_db.list_memories(limit=5)
        assert len(results) == 5

    def test_delete(self, memory_db: MemoryDB) -> None:
        mid = memory_db.add(category="lesson", summary="To delete")
        assert memory_db.delete(mid) is True
        results = memory_db.list_memories()
        assert len(results) == 0

    def test_delete_nonexistent(self, memory_db: MemoryDB) -> None:
        assert memory_db.delete(999) is False

    def test_empty_search(self, memory_db: MemoryDB) -> None:
        results = memory_db.search("nonexistent")
        assert results == []

    def test_db_created_on_init(self, tmp_path: Path) -> None:
        db_path = tmp_path / "subdir" / "memories.db"
        MemoryDB(db_path=db_path)
        assert db_path.exists()

    def test_order_by_date_desc(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="done", summary="First")
        memory_db.add(category="done", summary="Second")
        results = memory_db.list_memories()
        # Most recent first
        assert results[0]["summary"] == "Second"
        assert results[1]["summary"] == "First"
