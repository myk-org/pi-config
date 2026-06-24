"""Tests for auto_skip_replied_findings — post-enrichment dedup for Qodo sticky findings."""

from typing import Any

from myk_pi_tools.reviews.fetch import auto_skip_replied_findings


class TestAutoSkipRepliedFindings:
    """Test the post-enrichment auto-skip pass for already-replied Qodo findings."""

    def test_already_replied_no_qodo_response_is_auto_skipped(self) -> None:
        """already_replied=True + _enrichment_checked + no qodo_response → is_auto_skipped=True."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "status": "pending",
                "body": "Some finding",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 1
        assert findings[0]["is_auto_skipped"] is True
        assert findings[0]["status"] == "skipped"
        assert findings[0]["skip_reason"] == "Already replied, Qodo did not push back"

    def test_already_replied_with_qodo_response_remains_actionable(self) -> None:
        """already_replied=True + qodo_response present → stays pending (Qodo pushed back)."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "qodo_response": "Still present, not fixed",
                "status": "pending",
                "body": "Some finding",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 0
        assert not findings[0].get("is_auto_skipped")
        assert findings[0]["status"] == "pending"

    def test_not_already_replied_remains_actionable(self) -> None:
        """No already_replied → stays pending (new finding)."""
        findings: list[dict[str, Any]] = [
            {
                "status": "pending",
                "body": "New finding",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 0
        assert not findings[0].get("is_auto_skipped")
        assert findings[0]["status"] == "pending"

    def test_already_auto_skipped_not_re_processed(self) -> None:
        """Already is_auto_skipped → not re-processed."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "is_auto_skipped": True,
                "status": "skipped",
                "body": "Already skipped",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 0

    def test_non_pending_status_not_skipped(self) -> None:
        """already_replied=True but status is 'addressed' → not re-processed."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "status": "addressed",
                "body": "Already addressed",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 0

    def test_mixed_silent_accept_is_skipped(self) -> None:
        """In a mixed list, the silent-accept finding is auto-skipped."""
        findings: list[dict[str, Any]] = [
            {"already_replied": True, "_enrichment_checked": True, "status": "pending", "body": "Silent accept"},
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "qodo_response": "Not fixed",
                "status": "pending",
                "body": "Pushback",
            },
            {"status": "pending", "body": "New finding"},
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 1
        assert findings[0]["is_auto_skipped"] is True
        assert findings[0]["status"] == "skipped"

    def test_mixed_pushback_remains_actionable(self) -> None:
        """In a mixed list, the pushback finding stays pending."""
        findings: list[dict[str, Any]] = [
            {"already_replied": True, "_enrichment_checked": True, "status": "pending", "body": "Silent accept"},
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "qodo_response": "Not fixed",
                "status": "pending",
                "body": "Pushback",
            },
            {"status": "pending", "body": "New finding"},
        ]
        auto_skip_replied_findings(findings)
        assert not findings[1].get("is_auto_skipped")
        assert findings[1]["status"] == "pending"

    def test_mixed_new_finding_remains_actionable(self) -> None:
        """In a mixed list, the new finding stays pending."""
        findings: list[dict[str, Any]] = [
            {"already_replied": True, "_enrichment_checked": True, "status": "pending", "body": "Silent accept"},
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "qodo_response": "Not fixed",
                "status": "pending",
                "body": "Pushback",
            },
            {"status": "pending", "body": "New finding"},
        ]
        auto_skip_replied_findings(findings)
        assert not findings[2].get("is_auto_skipped")
        assert findings[2]["status"] == "pending"

    def test_empty_qodo_response_treated_as_no_response(self) -> None:
        """already_replied=True + empty qodo_response → auto-skipped (empty = no pushback)."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "qodo_response": "",
                "status": "pending",
                "body": "Finding with empty response",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 1
        assert findings[0]["is_auto_skipped"] is True

    def test_already_replied_false_explicit_remains_actionable(self) -> None:
        """already_replied=False (explicit) → stays pending (not replied)."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": False,
                "_enrichment_checked": True,
                "status": "pending",
                "body": "Explicit false",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 0
        assert not findings[0].get("is_auto_skipped")
        assert findings[0]["status"] == "pending"

    def test_qodo_response_none_treated_as_no_response(self) -> None:
        """already_replied=True + qodo_response=None → auto-skipped (None = no pushback)."""
        findings: list[dict[str, Any]] = [
            {
                "already_replied": True,
                "_enrichment_checked": True,
                "qodo_response": None,
                "status": "pending",
                "body": "Finding with None response",
            }
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 1
        assert findings[0]["is_auto_skipped"] is True

    def test_empty_findings_list(self) -> None:
        """Empty findings list → returns 0, no errors."""
        findings: list[dict[str, Any]] = []
        count = auto_skip_replied_findings(findings)
        assert count == 0

    def test_not_enrichment_checked_not_skipped(self) -> None:
        """already_replied=True but no _enrichment_checked → not skipped (enrichment didn't run)."""
        findings: list[dict[str, Any]] = [
            {"already_replied": True, "status": "pending", "body": "Not checked"},
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 0
        assert not findings[0].get("is_auto_skipped")
        assert findings[0]["status"] == "pending"

    def test_enrichment_checked_allows_auto_skip(self) -> None:
        """already_replied=True + _enrichment_checked=True + no response → auto-skipped."""
        findings: list[dict[str, Any]] = [
            {"already_replied": True, "_enrichment_checked": True, "status": "pending", "body": "Checked"},
        ]
        count = auto_skip_replied_findings(findings)
        assert count == 1
        assert findings[0]["is_auto_skipped"] is True

    def test_enrichment_with_empty_replies_sets_checked(self) -> None:
        """When no Qodo replies exist, enrichment still sets _enrichment_checked."""
        from myk_pi_tools.reviews.fetch import _enrich_findings_with_qodo_replies

        findings: list[dict[str, Any]] = [
            {"already_replied": True, "status": "pending", "body": "Silent Qodo"},
        ]
        _enrich_findings_with_qodo_replies(findings, [])
        assert findings[0].get("_enrichment_checked") is True
        # Now auto-skip should work
        count = auto_skip_replied_findings(findings)
        assert count == 1
        assert findings[0]["is_auto_skipped"] is True
