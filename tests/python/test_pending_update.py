"""Tests for myk_pi_tools.reviews.pending_update — backfill_node_ids and run()."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

from myk_pi_tools.reviews.pending_update import backfill_node_ids, run

# ---------------------------------------------------------------------------
# backfill_node_ids tests
# ---------------------------------------------------------------------------


class TestBackfillNodeIds:
    """Tests for the backfill_node_ids function."""

    def _make_comment(
        self,
        *,
        comment_id: int = 100,
        node_id: str | None = "PRRC_abc",
        status: str = "accepted",
        refined_body: str | None = "refined",
        path: str = "src/main.py",
    ) -> dict[str, Any]:
        c: dict[str, Any] = {
            "id": comment_id,
            "path": path,
            "status": status,
            "body": "original",
        }
        if node_id is not None:
            c["node_id"] = node_id
        if refined_body is not None:
            c["refined_body"] = refined_body
        return c

    def test_no_backfill_needed_all_have_node_id(self) -> None:
        """No API call when all accepted comments already have node_id."""
        comments = [self._make_comment(node_id="PRRC_abc")]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api") as mock_run_gh_api:
            backfill_node_ids("owner", "repo", 1, 2, comments)
            mock_run_gh_api.assert_not_called()

    def test_no_backfill_needed_non_accepted_missing_node_id(self) -> None:
        """No API call when the only comment missing node_id is not accepted."""
        comments = [self._make_comment(node_id=None, status="rejected")]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api") as mock_run_gh_api:
            backfill_node_ids("owner", "repo", 1, 2, comments)
            mock_run_gh_api.assert_not_called()

    def test_no_backfill_needed_missing_refined_body(self) -> None:
        """No API call when accepted comment missing node_id has no refined_body."""
        comments = [self._make_comment(node_id=None, refined_body=None)]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api") as mock_run_gh_api:
            backfill_node_ids("owner", "repo", 1, 2, comments)
            mock_run_gh_api.assert_not_called()

    def test_no_backfill_empty_comments(self) -> None:
        """No API call on empty comments list."""
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api") as mock_run_gh_api:
            backfill_node_ids("owner", "repo", 1, 2, [])
            mock_run_gh_api.assert_not_called()

    def test_backfill_success(self) -> None:
        """API call fills in missing node_id from response."""
        comments = [
            self._make_comment(comment_id=100, node_id=None),
            self._make_comment(comment_id=200, node_id="PRRC_existing"),
        ]
        api_response = [
            {"id": 100, "node_id": "PRRC_backfilled_100"},
            {"id": 200, "node_id": "PRRC_existing"},
            {"id": 300, "node_id": "PRRC_other"},
        ]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api", return_value=api_response):
            backfill_node_ids("owner", "repo", 1, 2, comments)

        assert comments[0]["node_id"] == "PRRC_backfilled_100"
        assert comments[1]["node_id"] == "PRRC_existing"

    def test_backfill_multiple_missing(self) -> None:
        """Backfills multiple comments in one pass."""
        comments = [
            self._make_comment(comment_id=10, node_id=None, path="a.py"),
            self._make_comment(comment_id=20, node_id=None, path="b.py"),
        ]
        api_response = [
            {"id": 10, "node_id": "PRRC_10"},
            {"id": 20, "node_id": "PRRC_20"},
        ]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api", return_value=api_response):
            backfill_node_ids("owner", "repo", 1, 2, comments)

        assert comments[0]["node_id"] == "PRRC_10"
        assert comments[1]["node_id"] == "PRRC_20"

    def test_backfill_id_not_found_in_api(self) -> None:
        """Comment id not found in API response — node_id stays missing."""
        comments = [self._make_comment(comment_id=999, node_id=None)]
        api_response = [{"id": 1, "node_id": "PRRC_1"}]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api", return_value=api_response):
            backfill_node_ids("owner", "repo", 1, 2, comments)

        assert "node_id" not in comments[0]

    def test_backfill_api_returns_none(self) -> None:
        """run_gh_api returning None (any failure) is handled gracefully — comments unchanged."""
        comments = [self._make_comment(comment_id=100, node_id=None)]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api", return_value=None):
            backfill_node_ids("owner", "repo", 1, 2, comments)

        assert "node_id" not in comments[0]

    def test_backfill_api_returns_non_list(self) -> None:
        """Non-list API response (e.g. error dict) triggers isinstance guard — comments unchanged."""
        comments = [self._make_comment(comment_id=100, node_id=None)]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api", return_value={"error": "something"}):
            backfill_node_ids("owner", "repo", 1, 2, comments)

        assert "node_id" not in comments[0]

    def test_backfill_correct_endpoint(self) -> None:
        """Verifies the correct REST API endpoint is called."""
        comments = [self._make_comment(comment_id=100, node_id=None)]
        with patch("myk_pi_tools.reviews.pending_update.run_gh_api", return_value=[]) as mock_run_gh_api:
            backfill_node_ids("myorg", "myrepo", 42, 99, comments)

        mock_run_gh_api.assert_called_once_with("/repos/myorg/myrepo/pulls/42/reviews/99/comments", paginate=True)


# ---------------------------------------------------------------------------
# run() integration tests — backfill is called & error message updated
# ---------------------------------------------------------------------------


class TestRunBackfillIntegration:
    """Tests that run() calls backfill and shows the updated error message."""

    def _write_json(self, tmp_path: Path, data: dict[str, Any]) -> str:
        path = tmp_path / "review.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return str(path)

    def _make_data(self, comments: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "metadata": {
                "owner": "o",
                "repo": "r",
                "pr_number": 1,
                "review_id": 2,
            },
            "comments": comments,
        }

    @patch("myk_pi_tools.reviews.pending_update.check_dependencies")
    @patch("myk_pi_tools.reviews.pending_update.backfill_node_ids")
    @patch("myk_pi_tools.reviews.pending_update.update_comment_body", return_value="success")
    def test_run_calls_backfill_before_update(
        self, mock_update: Any, mock_backfill: Any, _mock_deps: Any, tmp_path: Path
    ) -> None:
        """run() calls backfill_node_ids before update_comment_body."""
        data = self._make_data([
            {
                "id": 1,
                "node_id": "PRRC_1",
                "path": "a.py",
                "body": "old",
                "refined_body": "new",
                "status": "accepted",
            }
        ])
        json_path = self._write_json(tmp_path, data)

        call_order: list[str] = []
        mock_backfill.side_effect = lambda *_a, **_kw: call_order.append("backfill")

        def _track_update(*_a: object, **_kw: object) -> str:
            call_order.append("update")
            return "success"

        mock_update.side_effect = _track_update

        run(json_path)

        mock_backfill.assert_called_once_with("o", "r", 1, 2, data["comments"])
        assert "backfill" in call_order and "update" in call_order
        assert call_order.index("backfill") < call_order.index("update")

    @patch("myk_pi_tools.reviews.pending_update.check_dependencies")
    @patch("myk_pi_tools.reviews.pending_update.backfill_node_ids")
    def test_run_error_message_missing_node_id(
        self, _mock_backfill: Any, _mock_deps: Any, tmp_path: Path, capsys: Any
    ) -> None:
        """Error message includes re-run hint when node_id missing after backfill."""
        data = self._make_data([
            {
                "id": 1,
                "path": "a.py",
                "body": "old",
                "refined_body": "new",
                "status": "accepted",
                # no node_id
            }
        ])
        json_path = self._write_json(tmp_path, data)

        exit_code = run(json_path)
        assert exit_code == 1

        captured = capsys.readouterr()
        assert "Re-run 'reviews pending-fetch' to refresh." in captured.err
