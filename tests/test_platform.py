"""Tests for the platform module — URL parsing, detection, and dataclasses."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from myk_pi_tools.platform.base import ChangedFile, PRMetadata, ReviewThread
from myk_pi_tools.pr.common import PRInfo, parse_args


class TestGitLabURLParsing:
    """Test GitLab MR URL parsing in parse_args."""

    def test_simple_gitlab_url(self) -> None:
        info = parse_args(["https://gitlab.com/group/project/-/merge_requests/42"], "diff")
        assert info.platform == "gitlab"
        assert info.owner == "group"
        assert info.repo == "project"
        assert info.pr_number == 42
        assert info.project_path == "group/project"
        assert info.host == "gitlab.com"

    def test_nested_groups(self) -> None:
        info = parse_args(["https://gitlab.com/group/subgroup/project/-/merge_requests/42"], "diff")
        assert info.platform == "gitlab"
        assert info.owner == "group/subgroup"
        assert info.repo == "project"
        assert info.pr_number == 42
        assert info.project_path == "group/subgroup/project"

    def test_self_hosted(self) -> None:
        info = parse_args(
            ["https://gitlab.cee.redhat.com/migrationqe/mtv-autodeploy/-/merge_requests/63"],
            "diff",
        )
        assert info.platform == "gitlab"
        assert info.owner == "migrationqe"
        assert info.repo == "mtv-autodeploy"
        assert info.pr_number == 63
        assert info.host == "gitlab.cee.redhat.com"

    def test_deep_nesting(self) -> None:
        info = parse_args(["https://gitlab.com/a/b/c/d/-/merge_requests/1"], "diff")
        assert info.platform == "gitlab"
        assert info.owner == "a/b/c"
        assert info.repo == "d"
        assert info.pr_number == 1
        assert info.project_path == "a/b/c/d"

    def test_gitlab_url_with_query_params(self) -> None:
        info = parse_args(
            ["https://gitlab.com/group/project/-/merge_requests/42?tab=changes"],
            "diff",
        )
        assert info.platform == "gitlab"
        assert info.pr_number == 42


class TestGitHubURLParsing:
    """Test GitHub PR URL parsing in parse_args."""

    def test_standard_github_url(self) -> None:
        info = parse_args(["https://github.com/myk-org/pi-config/pull/545"], "diff")
        assert info.platform == "github"
        assert info.owner == "myk-org"
        assert info.repo == "pi-config"
        assert info.pr_number == 545
        assert info.project_path == "myk-org/pi-config"

    def test_github_url_with_trailing_path(self) -> None:
        info = parse_args(["https://github.com/owner/repo/pull/123/files"], "diff")
        assert info.platform == "github"
        assert info.pr_number == 123

    def test_pr_number_is_int(self) -> None:
        """PR number should always be int, not str."""
        info = parse_args(["https://github.com/owner/repo/pull/999"], "diff")
        assert isinstance(info.pr_number, int)


class TestPlatformDataclasses:
    """Test platform-neutral dataclasses."""

    def test_pr_metadata(self) -> None:
        m = PRMetadata(
            title="Fix bug",
            base_branch="main",
            head_sha="abc123",
            base_sha="def456",
            start_sha="def456",
            url="https://github.com/o/r/pull/1",
            pr_number=1,
        )
        assert m.title == "Fix bug"
        assert m.start_sha == "def456"
        assert m.state == ""  # default
        assert m.raw == {}  # default

    def test_changed_file(self) -> None:
        f = ChangedFile(path="src/main.py", patch="@@ -1,2 +1,3 @@", status="modified")
        assert f.path == "src/main.py"
        assert f.additions == 0  # default
        assert f.deletions == 0  # default

    def test_review_thread(self) -> None:
        t = ReviewThread(
            thread_id="abc",
            path="file.py",
            line=10,
            end_line=None,
            body="Fix this",
            author="user1",
        )
        assert t.thread_id == "abc"
        assert t.is_resolved is False  # default
        assert t.is_outdated is False  # default
        assert t.replies == []  # default
        assert t.raw == {}  # default


class TestCreatePlatform:
    """Test create_platform dispatch."""

    @patch("myk_pi_tools.platform.github.shutil.which", return_value="/usr/bin/gh")
    @patch("myk_pi_tools.platform.github.subprocess.run")
    def test_creates_github_platform(self, mock_run: MagicMock, _mock_which: MagicMock) -> None:
        """create_platform with github PRInfo returns GitHubPlatform."""
        # Mock gh auth status
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        from myk_pi_tools.platform.github import GitHubPlatform
        from myk_pi_tools.pr.common import create_platform

        pr_info = PRInfo(owner="myk-org", repo="pi-config", pr_number=1, platform="github")
        platform = create_platform(pr_info)
        assert isinstance(platform, GitHubPlatform)
        assert platform.name == "github"
        assert platform.owner == "myk-org"
        assert platform.repo == "pi-config"

    @patch("myk_pi_tools.platform.gitlab.shutil.which", return_value="/usr/bin/glab")
    @patch("myk_pi_tools.platform.gitlab.subprocess.run")
    def test_creates_gitlab_platform(self, mock_run: MagicMock, _mock_which: MagicMock) -> None:
        """create_platform with gitlab PRInfo returns GitLabPlatform."""
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        from myk_pi_tools.platform.gitlab import GitLabPlatform
        from myk_pi_tools.pr.common import create_platform

        pr_info = PRInfo(
            owner="group",
            repo="project",
            pr_number=42,
            platform="gitlab",
            project_path="group/project",
            host="gitlab.com",
        )
        platform = create_platform(pr_info)
        assert isinstance(platform, GitLabPlatform)
        assert platform.name == "gitlab"
        assert platform.project_path == "group/project"


class TestPlatformDetectionFromURL:
    """Test detect_platform URL detection (mocked auth)."""

    @patch("myk_pi_tools.platform.github.shutil.which", return_value="/usr/bin/gh")
    @patch("myk_pi_tools.platform.github.subprocess.run")
    def test_github_url(self, mock_run: MagicMock, _mock_which: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        from myk_pi_tools.platform import detect_platform
        from myk_pi_tools.platform.github import GitHubPlatform

        platform = detect_platform(url="https://github.com/owner/repo/pull/123")
        assert isinstance(platform, GitHubPlatform)
        assert platform.owner == "owner"
        assert platform.repo == "repo"

    @patch("myk_pi_tools.platform.gitlab.shutil.which", return_value="/usr/bin/glab")
    @patch("myk_pi_tools.platform.gitlab.subprocess.run")
    def test_gitlab_url(self, mock_run: MagicMock, _mock_which: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        from myk_pi_tools.platform import detect_platform
        from myk_pi_tools.platform.gitlab import GitLabPlatform

        platform = detect_platform(url="https://gitlab.com/group/project/-/merge_requests/42")
        assert isinstance(platform, GitLabPlatform)
        assert platform.project_path == "group/project"

    @patch("myk_pi_tools.platform.gitlab.shutil.which", return_value="/usr/bin/glab")
    @patch("myk_pi_tools.platform.gitlab.subprocess.run")
    def test_self_hosted_gitlab_url(self, mock_run: MagicMock, _mock_which: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

        from myk_pi_tools.platform import detect_platform
        from myk_pi_tools.platform.gitlab import GitLabPlatform

        platform = detect_platform(url="https://gitlab.cee.redhat.com/migrationqe/mtv-autodeploy/-/merge_requests/63")
        assert isinstance(platform, GitLabPlatform)
        assert platform.project_path == "migrationqe/mtv-autodeploy"

    def test_unknown_url_exits(self) -> None:
        with pytest.raises(SystemExit):
            from myk_pi_tools.platform import detect_platform

            detect_platform(url="https://bitbucket.org/owner/repo/pull-requests/42")
