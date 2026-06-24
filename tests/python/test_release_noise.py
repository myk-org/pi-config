"""Tests for release changelog noise filtering."""

import pytest

from myk_pi_tools.release.info import Commit, _is_changelog_noise


@pytest.mark.parametrize(
    "subject,expected_noise",
    [
        # Should be filtered (noise)
        ("address coderabbit review comments", True),
        ("address CodeRabbit comments", True),
        ("Address coderabbit suggestions", True),
        ("address review comments", True),
        ("chore: checkpoint progress", True),
        ("chore: bump version to 3.2.0", True),
        ("regenerate docs", True),
        ("pre-commit autoupdate", True),
        # Should NOT be filtered (real commits)
        ("fix: address coderabbit suggestions", False),
        ("update coderabbit config", False),
        ("fix: address review feedback", False),
        ("feat: add /create-skill command", False),
        ("fix: coderabbit CLI integration", False),
        ("Merge pull request #360 from myk-org/feat/coderabbit", True),
        ("Merge branch 'main' into feature", True),
        ("feat: new feature", False),
        ("fix: bug fix", False),
        ("chore: update dependencies", False),
    ],
)
def test_changelog_noise_filter(subject: str, expected_noise: bool) -> None:
    commit = Commit(
        hash="abc123def456",  # pragma: allowlist secret
        short_hash="abc123d",
        subject=subject,
        author="Test Author",
        date="2026-01-01",
        body="",
    )
    assert _is_changelog_noise(commit) == expected_noise, f"Expected noise={expected_noise} for: {subject}"
