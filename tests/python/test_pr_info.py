"""Tests for myk-pi-tools pr info command."""

from unittest.mock import patch

import pytest

from myk_pi_tools.pr.common import PRInfo
from myk_pi_tools.pr.info import fetch_pr_info, run


class TestFetchPrInfo:
    """Test fetch_pr_info function."""

    def test_successful_fetch(self) -> None:
        """Successfully fetch PR info from GitHub API."""
        mock_api_response = (
            '{"user": {"login": "testuser"}, "head": {"sha": "abc123",'
            ' "repo": {"full_name": "fork/repo"}}, "base": {"ref": "main",'
            ' "repo": {"full_name": "org/repo"}}, "title": "Test PR",'
            ' "state": "open", "body": "PR body",'
            ' "labels": [{"name": "bug"}],'
            ' "assignees": [{"login": "reviewer"}]}'
        )

        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = mock_api_response
            mock_run.return_value.returncode = 0

            result = fetch_pr_info(PRInfo(owner="org", repo="repo", pr_number="1"))

        assert result["user"]["login"] == "testuser"
        assert result["head"]["sha"] == "abc123"

    def test_invalid_json_exits(self) -> None:
        """Invalid JSON response causes sys.exit(1)."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = "not json"
            mock_run.return_value.returncode = 0

            with pytest.raises(SystemExit) as exc_info:
                fetch_pr_info(PRInfo(owner="org", repo="repo", pr_number="1"))
            assert exc_info.value.code == 1

    def test_gh_not_found_exits(self) -> None:
        """Missing gh CLI causes sys.exit(1)."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            with pytest.raises(SystemExit) as exc_info:
                fetch_pr_info(PRInfo(owner="org", repo="repo", pr_number="1"))
            assert exc_info.value.code == 1


class TestRun:
    """Test the run function output."""

    @staticmethod
    def _fork_api_response() -> str:
        return (
            '{"user": {"login": "Chenli-Hu"}, "head": {"sha": "abc",'
            ' "repo": {"full_name": "Chenli-Hu/repo"}}, "base": {"ref": "main",'
            ' "repo": {"full_name": "RedHatQE/repo"}}, "title": "test PR",'
            ' "state": "open", "body": "", "labels": [], "assignees": []}'
        )

    def test_output_contains_author(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Output JSON contains author field from user.login."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = self._fork_api_response()
            mock_run.return_value.returncode = 0

            run(["RedHatQE/repo", "503"])

        import json

        output = json.loads(capsys.readouterr().out)
        assert output["author"] == "Chenli-Hu"

    def test_output_contains_owner(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Output JSON contains owner extracted from base repo."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = self._fork_api_response()
            mock_run.return_value.returncode = 0

            run(["RedHatQE/repo", "503"])

        import json

        output = json.loads(capsys.readouterr().out)
        assert output["owner"] == "RedHatQE"

    def test_output_detects_fork(self, capsys: pytest.CaptureFixture[str]) -> None:
        """is_fork is True when head and base repos differ."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = self._fork_api_response()
            mock_run.return_value.returncode = 0

            run(["RedHatQE/repo", "503"])

        import json

        output = json.loads(capsys.readouterr().out)
        assert output["is_fork"] is True

    def test_output_detects_non_fork(self, capsys: pytest.CaptureFixture[str]) -> None:
        """is_fork is False when head and base repos match."""
        mock_api_response = (
            '{"user": {"login": "dev"}, "head": {"sha": "abc",'
            ' "repo": {"full_name": "org/repo"}}, "base": {"ref": "main",'
            ' "repo": {"full_name": "org/repo"}}, "title": "test",'
            ' "state": "open", "body": "", "labels": [], "assignees": []}'
        )

        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = mock_api_response
            mock_run.return_value.returncode = 0

            run(["org/repo", "1"])

        import json

        output = json.loads(capsys.readouterr().out)
        assert output["is_fork"] is False
