"""Tests for ask_qodo — post question to Qodo and wait for reply."""

from __future__ import annotations

import subprocess
from unittest.mock import patch

from myk_pi_tools.reviews.ask_qodo import ask_qodo, run


class TestAskQodo:
    """Test the ask_qodo() function."""

    def test_success_returns_reply_body(self) -> None:
        """Posts comment, receives matching Qodo reply → returns reply body."""
        question = "What does this function do?"
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
        ):
            mock_run.return_value.returncode = 0
            mock_api.return_value = [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "created_at": "2099-01-01T00:00:00Z",
                    "body": (
                        "> What does this function do?\n\nThis function processes input data and returns a result."
                    ),
                }
            ]
            result = ask_qodo("org", "repo", "42", question)

        assert "This function processes input data" in result
        assert "What does this function do?" in result

    def test_multiline_question_match(self) -> None:
        """All non-empty stripped lines from question must appear in reply body."""
        question = "Line one\nLine two\n\nLine three"
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
        ):
            mock_run.return_value.returncode = 0
            # Reply contains all lines
            mock_api.return_value = [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "created_at": "2099-01-01T00:00:00Z",
                    "body": "> Line one\n> Line two\n> Line three\n\nHere is my answer.",
                }
            ]
            result = ask_qodo("org", "repo", "42", question)

        assert "Here is my answer." in result

    def test_partial_match_skipped(self) -> None:
        """Reply missing some match lines is not accepted → timeout."""
        question = "Line one\nLine two"
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
            patch("myk_pi_tools.reviews.ask_qodo.time.time") as mock_time,
        ):
            mock_run.return_value.returncode = 0
            # Reply only contains Line one, not Line two
            mock_api.return_value = [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "created_at": "2099-01-01T00:00:00Z",
                    "body": "> Line one\n\nSome answer without line two.",
                }
            ]
            mock_time.side_effect = [0, 0, 700]
            result = ask_qodo("org", "repo", "42", question)

        assert result == ""

    def test_timeout_returns_empty_string(self) -> None:
        """No matching reply within timeout → returns empty string."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api", return_value=[]),
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
            patch("myk_pi_tools.reviews.ask_qodo.time.time") as mock_time,
        ):
            mock_run.return_value.returncode = 0
            # first call = start, loop: enter check + exit check exceed timeout
            mock_time.side_effect = [0, 0, 700]
            result = ask_qodo("org", "repo", "42", "Hello?")

        assert result == ""

    def test_post_failure_called_process_error(self) -> None:
        """gh api post fails with CalledProcessError → returns empty string."""
        with patch(
            "myk_pi_tools.reviews.ask_qodo.subprocess.run",
            side_effect=subprocess.CalledProcessError(1, "gh", stderr="forbidden"),
        ):
            result = ask_qodo("org", "repo", "42", "Hello?")

        assert result == ""

    def test_post_failure_timeout_expired(self) -> None:
        """gh api post times out → returns empty string."""
        with patch(
            "myk_pi_tools.reviews.ask_qodo.subprocess.run",
            side_effect=subprocess.TimeoutExpired("gh", 30),
        ):
            result = ask_qodo("org", "repo", "42", "Hello?")

        assert result == ""

    def test_post_failure_file_not_found(self) -> None:
        """gh binary not found → returns empty string."""
        with patch(
            "myk_pi_tools.reviews.ask_qodo.subprocess.run",
            side_effect=FileNotFoundError,
        ):
            result = ask_qodo("org", "repo", "42", "Hello?")

        assert result == ""

    def test_ignores_non_qodo_comments(self) -> None:
        """Comments from other users are ignored."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
            patch("myk_pi_tools.reviews.ask_qodo.time.time") as mock_time,
        ):
            mock_run.return_value.returncode = 0
            mock_api.return_value = [
                {
                    "user": {"login": "some-other-bot"},
                    "created_at": "2099-01-01T00:00:00Z",
                    "body": "Hello?",
                }
            ]
            mock_time.side_effect = [0, 0, 700]
            result = ask_qodo("org", "repo", "42", "Hello?")

        assert result == ""

    def test_ignores_old_qodo_comments(self) -> None:
        """Qodo comments created before the post time are ignored."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
            patch("myk_pi_tools.reviews.ask_qodo.time.time") as mock_time,
        ):
            mock_run.return_value.returncode = 0
            # Comment created far in the past
            mock_api.return_value = [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "created_at": "2000-01-01T00:00:00Z",
                    "body": "Hello?",
                }
            ]
            mock_time.side_effect = [0, 0, 700]
            result = ask_qodo("org", "repo", "42", "Hello?")

        assert result == ""

    def test_accepts_qodo_code_review_login(self) -> None:
        """Accepts replies from 'qodo-code-review' (without [bot] suffix)."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
        ):
            mock_run.return_value.returncode = 0
            mock_api.return_value = [
                {
                    "user": {"login": "qodo-code-review"},
                    "created_at": "2099-01-01T00:00:00Z",
                    "body": "My question\n\nQodo reply here.",
                }
            ]
            result = ask_qodo("org", "repo", "42", "My question")

        assert "Qodo reply here." in result


class TestRun:
    """Test the run() CLI entry point."""

    def test_pr_flag_calls_ask_qodo_with_correct_args(self) -> None:
        """--pr owner/repo 123 'question' → calls ask_qodo with correct args, prints reply."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.ask_qodo", return_value="Qodo says hi") as mock_ask,
            patch("builtins.print") as mock_print,
        ):
            try:
                run(["--pr", "myorg/myrepo", "99", "What is this?"])
            except SystemExit as e:
                assert e.code == 0

        mock_ask.assert_called_once_with("myorg", "myrepo", "99", "What is this?")
        mock_print.assert_called_once_with("Qodo says hi")

    def test_pr_flag_question_before_flag(self) -> None:
        """Question parts before --pr are joined with parts after."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.ask_qodo", return_value="reply") as mock_ask,
            patch("builtins.print"),
        ):
            try:
                run(["part1", "--pr", "o/r", "1", "part2"])
            except SystemExit as e:
                assert e.code == 0

        mock_ask.assert_called_once_with("o", "r", "1", "part1 part2")

    def test_auto_detect_without_pr_flag(self) -> None:
        """Without --pr, calls get_pr_info then ask_qodo."""
        with (
            patch(
                "myk_pi_tools.reviews.ask_qodo.get_pr_info",
                return_value=("auto-owner", "auto-repo", "55"),
            ) as mock_info,
            patch("myk_pi_tools.reviews.ask_qodo.ask_qodo", return_value="auto reply") as mock_ask,
            patch("builtins.print") as mock_print,
        ):
            try:
                run(["How does this work?"])
            except SystemExit as e:
                assert e.code == 0

        mock_info.assert_called_once_with("")
        mock_ask.assert_called_once_with("auto-owner", "auto-repo", "55", "How does this work?")
        mock_print.assert_called_once_with("auto reply")

    def test_empty_question_exits_1(self) -> None:
        """Empty question → sys.exit(1)."""
        with patch("myk_pi_tools.reviews.ask_qodo.get_pr_info", return_value=("o", "r", "1")):
            try:
                run([""])
            except SystemExit as e:
                assert e.code == 1

    def test_no_reply_exits_1(self) -> None:
        """ask_qodo returns empty string (timeout) → sys.exit(1)."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.ask_qodo", return_value=""),
            patch("builtins.print"),
        ):
            try:
                run(["--pr", "o/r", "1", "question"])
            except SystemExit as e:
                assert e.code == 1

    def test_success_exits_0(self) -> None:
        """ask_qodo returns non-empty reply → sys.exit(0)."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.ask_qodo", return_value="got it"),
            patch("builtins.print"),
        ):
            try:
                run(["--pr", "o/r", "1", "question"])
            except SystemExit as e:
                assert e.code == 0

    def test_help_exits_0(self) -> None:
        """--help → sys.exit(0)."""
        try:
            run(["--help"])
        except SystemExit as e:
            assert e.code == 0

    def test_no_args_exits_0(self) -> None:
        """No args → sys.exit(0) (shows help)."""
        try:
            run([])
        except SystemExit as e:
            assert e.code == 0

    def test_pr_flag_missing_args_exits_1(self) -> None:
        """--pr without enough arguments → sys.exit(1)."""
        try:
            run(["--pr", "o/r"])
        except SystemExit as e:
            assert e.code == 1
