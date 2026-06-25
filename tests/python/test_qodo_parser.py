"""Tests for qodo_parser dynamic type/category detection."""

from __future__ import annotations

from myk_pi_tools.reviews.qodo_parser import parse_qodo_sticky_comment


class TestParseQodoStickyComment:
    """Test dynamic finding type/category parsing."""

    def _make_sticky(self, findings_html: str) -> str:
        """Wrap findings HTML in a valid Qodo sticky comment structure."""
        return f"<h3>Code Review by Qodo</h3>\n{findings_html}"

    def test_bug_type_parsed(self) -> None:
        """Bug finding type is correctly identified."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>🐞 Bug</code> <code>≡ Correctness</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Bug"
        assert findings[0]["category"] == "Correctness"

    def test_skill_insight_type_parsed(self) -> None:
        """Skill insight type is correctly identified."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>📜 Skill insight</code> <code>▣ Testability</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Skill insight"
        assert findings[0]["category"] == "Testability"

    def test_rule_violation_type_parsed(self) -> None:
        """Rule violation type is correctly identified."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>📘 Rule violation</code> <code>⛨ Security</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Rule violation"
        assert findings[0]["category"] == "Security"

    def test_requirement_gap_type_parsed(self) -> None:
        """Requirement gap type is correctly identified."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>📎 Requirement gap</code> <code>☼ Reliability</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Requirement gap"
        assert findings[0]["category"] == "Reliability"

    def test_resolved_finding_not_returned(self) -> None:
        """Resolved findings are excluded from results."""
        html = self._make_sticky(
            "<details><summary>  1.  <s>Title</s> "
            "<code>✓ Resolved</code> <code>🐞 Bug</code> <code>≡ Correctness</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 0

    def test_dismissed_finding_not_returned(self) -> None:
        """Dismissed findings are excluded from results."""
        html = self._make_sticky(
            "<details><summary>  1.  <s>Title</s> "
            "<code>✗ Dismissed</code> <code>📜 Skill insight</code> <code>▣ Testability</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 0

    def test_extra_code_tags_dont_shift_type(self) -> None:
        """Extra code tags (like severity) don't corrupt type/category."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>🐞 Bug</code> <code>≡ Correctness</code> <code>HIGH</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Bug"
        assert findings[0]["category"] == "Correctness"

    def test_unknown_emoji_falls_back_to_positional(self) -> None:
        """Code tags with unrecognized emojis use positional assignment."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>🔥 New category</code> <code>⚡ Performance</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "New category"
        assert findings[0]["category"] == "Performance"

    def test_no_emoji_falls_back_to_positional(self) -> None:
        """Code tags without any emoji use positional assignment."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>Custom type</code> <code>Custom category</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Custom type"
        assert findings[0]["category"] == "Custom category"

    def test_single_code_tag_sets_type_only(self) -> None:
        """Only one non-status code tag sets type, category remains empty."""
        html = self._make_sticky("<details><summary>  1.  <b>Title</b> <code>🐞 Bug</code></summary>\ndesc\n</details>")
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Bug"
        assert findings[0]["category"] == ""

    def test_type_emoji_with_unknown_category_emoji(self) -> None:
        """Known type emoji + unknown category emoji both parsed correctly."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>📎 Requirement gap</code> <code>🌟 Quality</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Requirement gap"
        assert findings[0]["category"] == "Quality"

    def test_single_category_tag_no_type_emoji(self) -> None:
        """Single non-type-emoji code tag is assigned as type (positional fallback)."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> <code>≡ Correctness</code></summary>\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        assert findings[0]["finding_type"] == "Correctness"
        assert findings[0]["category"] == ""

    def test_reverse_order_no_emoji_fallback(self) -> None:
        """When category tag appears before type tag with no emojis, positional assignment still works."""
        html = self._make_sticky(
            "<details><summary>  1.  <b>Title</b> "
            "<code>Testability</code> <code>Skill insight</code></summary>"
            "\ndesc\n</details>"
        )
        findings = parse_qodo_sticky_comment(html)
        assert len(findings) == 1
        # Positional: first = type, second = category (even if semantically reversed)
        assert findings[0]["finding_type"] == "Testability"
        assert findings[0]["category"] == "Skill insight"
