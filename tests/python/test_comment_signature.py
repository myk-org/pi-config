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
        """Preserve an existing valid footer even when the runtime model differs."""
        body = "Hello\n\n---\n*Assisted-by: PI (old-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == body
        assert result.count("*Assisted-by: PI (old-model)*") == 1

    def test_existing_valid_signature_without_canonical_separator(self) -> None:
        """A valid signature anywhere in the body prevents a second one."""
        body = "Summary\n*Assisted-by: PI (old-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == body
        assert result.count("*Assisted-by: PI (old-model)*") == 1

    def test_collapses_two_noncanonical_valid_signatures(self) -> None:
        """Keep the first noncanonical model, dropping the second signature."""
        body = "Summary\n*Assisted-by: PI (first-model)*\n*Assisted-by: PI (second-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == "Summary\n*Assisted-by: PI (first-model)*"
        assert result.count("*Assisted-by: PI (") == 1

    def test_preserves_first_when_later_footer_is_canonical(self) -> None:
        """A later canonical footer must not override an earlier signature."""
        body = "Summary\n*Assisted-by: PI (first-model)*\n\n---\n*Assisted-by: PI (second-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == "Summary\n*Assisted-by: PI (first-model)*"
        assert result.count("*Assisted-by: PI (") == 1

    def test_preserves_unrelated_crlf_prose(self) -> None:
        """Appending a footer does not rewrite the user's line endings."""
        body = "First line\r\nSecond line\r\n"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == body + "\n\n---\n*Assisted-by: PI (new-model)*"

    def test_existing_crlf_signed_footer_prevents_second_signature(self) -> None:
        """A signed CRLF footer stays byte-for-byte unchanged."""
        body = "First line\r\nSecond line\r\n\r\n---\r\n*Assisted-by: PI (old-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == body

    def test_duplicate_canonical_crlf_footers_normalize_to_first(self) -> None:
        """Discard duplicate CRLF footers while preserving the first verbatim."""
        footer = "\r\n\r\n---\r\n*Assisted-by: PI (old-model)*"
        body = "First line\r\nSecond line" + footer
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body + footer)
        assert result == body

    def test_slash_and_space_model_id_is_idempotent(self) -> None:
        """A runtime model ID containing slash and spaces remains valid."""
        signature = "Assisted-by: PI (vendor/model with spaces)"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": signature}):
            first = append_signature("Summary")
            second = append_signature(first)
        assert first == second
        assert second.count("*Assisted-by: PI (") == 1

    def test_inline_example_does_not_prevent_runtime_signature(self) -> None:
        """Inline example prose remains intact and does not count as a footer."""
        body = "*Assisted-by: PI (old)* is an example"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (runtime)"}):
            result = append_signature(body)
        assert result == body + "\n\n---\n*Assisted-by: PI (runtime)*"

    def test_inline_example_is_not_removed_after_real_footer(self) -> None:
        """A prose example following a valid footer must survive normalization."""
        body = "*Assisted-by: PI (real)*\n*Assisted-by: PI (old)* is an example"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (runtime)"}):
            assert append_signature(body) == body

    def test_plus_at_model_footer_is_idempotent(self) -> None:
        """An existing model using + and @ remains the sole signature on retry."""
        body = "Summary\n\n---\n*Assisted-by: PI (vendor/model+fast@latest)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (runtime)"}):
            first = append_signature(body)
            second = append_signature(first)
        assert first == second == body

    def test_replaces_quoted_placeholder_without_separator(self) -> None:
        """Discard an unresolved noncanonical placeholder before signing."""
        body = "Summary\n*Assisted-by: PI ('\"${PI_MODEL:-unknown}\"')*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == "Summary\n\n---\n*Assisted-by: PI (new-model)*"
        assert result.count("*Assisted-by: PI (") == 1

    def test_replaces_quoted_pr260_unresolved_footer(self) -> None:
        """Remove the exact PR260 unresolved footer before signing."""
        body = "Summary\n\n---\n*Assisted-by: PI ('\"${PI_MODEL:-unknown}\"')*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == "Summary\n\n---\n*Assisted-by: PI (new-model)*"
        assert result.count("*Assisted-by: PI (new-model)*") == 1

    def test_collapses_duplicate_identical_valid_footers(self) -> None:
        """Keep the first valid footer and discard identical duplicates."""
        footer = "\n\n---\n*Assisted-by: PI (old-model)*"
        body = "Summary" + footer + footer
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature(body)
        assert result == "Summary" + footer
        assert result.count("*Assisted-by: PI (old-model)*") == 1

    def test_removes_unresolved_footer_beside_valid_footer(self) -> None:
        """A template beside a valid footer must not trigger a second signature."""
        placeholder = "\n\n---\n*Assisted-by: PI ('\"${PI_MODEL:-unknown}\"')*"
        footer = "\n\n---\n*Assisted-by: PI (old-model)*"
        with patch.dict("os.environ", {"PI_COMMENT_SIGNATURE": "Assisted-by: PI (new-model)"}):
            result = append_signature("Summary" + placeholder + footer)
        assert result == "Summary" + footer
        assert result.count("*Assisted-by: PI (old-model)*") == 1
