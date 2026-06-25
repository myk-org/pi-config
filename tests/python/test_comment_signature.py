"""Tests for comment signature injection."""

from __future__ import annotations

from unittest.mock import patch

from myk_pi_tools.comment_signature import append_signature


class TestAppendSignature:
    """Test append_signature function."""

    def test_appends_when_env_set(self) -> None:
        """Signature appended when PI_COMMENT_SIGNATURE is set."""
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (test-model)"}):
            result = append_signature("Hello world")
        assert result == "Hello world\n\n---\n*Assisted-by: PI (test-model)*"

    def test_no_change_when_env_unset(self) -> None:
        """Body unchanged when PI_COMMENT_SIGNATURE is not set."""
        with patch.dict("os.environ", {}, clear=True):
            result = append_signature("Hello world")
        assert result == "Hello world"

    def test_no_change_when_env_empty(self) -> None:
        """Body unchanged when PI_COMMENT_SIGNATURE is empty string."""
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": ""}):
            result = append_signature("Hello world")
        assert result == "Hello world"

    def test_idempotent_no_duplicate(self) -> None:
        """Calling twice does not duplicate the signature."""
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (test-model)"}):
            first = append_signature("Hello world")
            second = append_signature(first)
        assert first == second
        assert second.count("Assisted-by") == 1

    def test_empty_body(self) -> None:
        """Works with empty body."""
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (model)"}):
            result = append_signature("")
        assert result == "\n\n---\n*Assisted-by: PI (model)*"

    def test_body_with_existing_different_signature(self) -> None:
        """Different signature content is appended (not idempotent across models)."""
        body = "Hello\n\n---\n*Assisted-by: PI (old-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result.count("Assisted-by") == 2
