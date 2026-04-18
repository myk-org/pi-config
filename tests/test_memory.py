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


class TestRecallTracking:
    def test_search_increments_recall_count(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="buildah bug", tags="docker")
        memory_db.search("buildah")
        results = memory_db.list_memories()
        assert results[0]["recall_count"] == 1

    def test_search_increments_multiple_times(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="buildah bug", tags="docker")
        memory_db.search("buildah")
        memory_db.search("buildah")
        memory_db.search("buildah")
        results = memory_db.list_memories()
        assert results[0]["recall_count"] == 3

    def test_search_sets_last_recalled(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="buildah bug", tags="docker")
        memory_db.search("buildah")
        results = memory_db.list_memories()
        assert results[0]["last_recalled"] is not None

    def test_search_no_match_no_recall(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="buildah bug", tags="docker")
        memory_db.search("nonexistent")
        results = memory_db.list_memories()
        assert results[0]["recall_count"] == 0

    def test_new_memory_has_zero_recall(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="test")
        results = memory_db.list_memories()
        assert results[0]["recall_count"] == 0
        assert results[0]["last_recalled"] is None


class TestScoring:
    def test_score_empty_db(self, memory_db: MemoryDB) -> None:
        assert memory_db.score_memories() == []

    def test_score_returns_scores(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Test lesson")
        results = memory_db.score_memories()
        assert len(results) == 1
        assert "score" in results[0]
        assert isinstance(results[0]["score"], float)

    def test_recalled_memory_scores_higher(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="recalled lesson", tags="test")
        memory_db.add(category="lesson", summary="forgotten lesson", tags="other")
        # Recall the first one several times
        for _ in range(5):
            memory_db.search("recalled")
        results = memory_db.score_memories()
        recalled = next(m for m in results if "recalled" in m["summary"])
        forgotten = next(m for m in results if "forgotten" in m["summary"])
        assert recalled["score"] > forgotten["score"]

    def test_score_respects_limit(self, memory_db: MemoryDB) -> None:
        for i in range(10):
            memory_db.add(category="done", summary=f"Task {i}")
        results = memory_db.score_memories(limit=3)
        assert len(results) == 3


class TestPruning:
    def test_prune_empty_db(self, memory_db: MemoryDB) -> None:
        assert memory_db.prune() == []

    def test_prune_dry_run_doesnt_delete(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="done", summary="Old task")
        # Force old date
        conn = memory_db._connect(readonly=False)
        conn.execute("UPDATE memories SET date = '2020-01-01 00:00:00'")
        conn.commit()
        conn.close()
        pruned = memory_db.prune(dry_run=True)
        assert len(pruned) > 0
        # Still exists
        assert len(memory_db.list_memories()) == 1

    def test_prune_apply_deletes(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="done", summary="Old task")
        conn = memory_db._connect(readonly=False)
        conn.execute("UPDATE memories SET date = '2020-01-01 00:00:00'")
        conn.commit()
        conn.close()
        pruned = memory_db.prune(dry_run=False)
        assert len(pruned) > 0
        assert len(memory_db.list_memories()) == 0

    def test_prune_keeps_recalled_memories(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Important lesson", tags="test")
        # Make it old
        conn = memory_db._connect(readonly=False)
        conn.execute("UPDATE memories SET date = '2020-01-01 00:00:00'")
        conn.commit()
        conn.close()
        # But recall it frequently
        for _ in range(10):
            memory_db.search("Important")
        pruned = memory_db.prune(dry_run=True)
        # Should not be pruned because it's frequently recalled
        assert all("Important" not in p["summary"] for p in pruned)


class TestStats:
    def test_stats_empty(self, memory_db: MemoryDB) -> None:
        result = memory_db.stats()
        assert result["total"] == 0

    def test_stats_with_data(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="L1")
        memory_db.add(category="lesson", summary="L2")
        memory_db.add(category="done", summary="D1")
        result = memory_db.stats()
        assert result["total"] == 3
        assert result["categories"]["lesson"] == 2
        assert result["categories"]["done"] == 1

    def test_stats_recall_tracking(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="buildah bug", tags="docker")
        memory_db.add(category="lesson", summary="not searched")
        memory_db.search("buildah")
        result = memory_db.stats()
        assert result["recalled"] == 1
        assert result["never_recalled"] == 1


class TestDream:
    def test_dream_empty_db(self, memory_db: MemoryDB) -> None:
        report = memory_db.dream()
        assert "Dream Report" in report
        assert "Total memories: 0" in report

    def test_dream_with_data(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="lesson", summary="Test lesson")
        report = memory_db.dream()
        assert "Dream Report" in report
        assert "Total memories: 1" in report

    def test_dream_shows_prune_candidates(self, memory_db: MemoryDB) -> None:
        memory_db.add(category="done", summary="Old task")
        # Make it old so it becomes a prune candidate
        conn = memory_db._connect(readonly=False)
        conn.execute("UPDATE memories SET date = '2020-01-01 00:00:00'")
        conn.commit()
        conn.close()
        report = memory_db.dream()
        assert "Prune candidates" in report

    def test_dream_returns_string(self, memory_db: MemoryDB) -> None:
        report = memory_db.dream()
        assert isinstance(report, str)
