"""GitLab platform implementation using glab CLI."""

from __future__ import annotations

import shutil
import subprocess
import sys
from typing import Any
from urllib.parse import quote as url_quote

from myk_pi_tools.platform.base import (
    ChangedFile,
    Platform,
    PRMetadata,
    ReviewThread,
)


class GitLabPlatform(Platform):
    """GitLab implementation using glab CLI and REST API."""

    def __init__(
        self,
        host: str,
        project_path: str,
        *,
        mr_number: int | None = None,
        cwd: str | None = None,
    ) -> None:
        self._host = host
        self._project_path = project_path
        self._mr_number = mr_number
        self._cwd = cwd
        self._verify_auth()

    def _verify_auth(self) -> None:
        """Pre-flight check: verify glab is installed and authenticated."""
        if not shutil.which("glab"):
            print("Error: glab CLI not found. Install glab.", file=sys.stderr)
            sys.exit(1)
        try:
            result = subprocess.run(
                ["glab", "auth", "status"],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=self._cwd,
            )
            if result.returncode != 0:
                print(
                    f"Error: glab not authenticated for {self._host}. Run: glab auth login --hostname {self._host}",
                    file=sys.stderr,
                )
                sys.exit(1)
        except subprocess.TimeoutExpired:
            print("Error: glab auth status timed out.", file=sys.stderr)
            sys.exit(1)

    @property
    def name(self) -> str:
        return "gitlab"

    @property
    def owner(self) -> str:
        """For GitLab, returns the namespace (may contain slashes for nested groups)."""
        parts = self._project_path.rsplit("/", 1)
        return parts[0] if len(parts) > 1 else ""

    @property
    def repo(self) -> str:
        """For GitLab, returns the project name (last segment)."""
        return self._project_path.rsplit("/", 1)[-1]

    @property
    def project_path(self) -> str:
        return self._project_path

    @property
    def encoded_project_path(self) -> str:
        """URL-encoded project path for GitLab API endpoints."""
        return url_quote(self._project_path, safe="")

    def fetch_pr_metadata(self, pr_number: int) -> PRMetadata:
        raise NotImplementedError("GitLabPlatform.fetch_pr_metadata — TODO Phase 2")

    def fetch_diff(self, pr_number: int) -> str:
        raise NotImplementedError("GitLabPlatform.fetch_diff — TODO Phase 2")

    def fetch_changed_files(self, pr_number: int) -> list[ChangedFile]:
        raise NotImplementedError("GitLabPlatform.fetch_changed_files — TODO Phase 2")

    def fetch_review_threads(self, pr_number: int, *, include_resolved: bool = False) -> list[ReviewThread]:
        raise NotImplementedError("GitLabPlatform.fetch_review_threads — TODO Phase 2")

    def fetch_issue_comments(self, pr_number: int) -> list[dict[str, Any]]:
        raise NotImplementedError("GitLabPlatform.fetch_issue_comments — TODO Phase 2")

    def post_review_comment(self, pr_number: int, commit_sha: str, path: str, line: int, body: str) -> str:
        raise NotImplementedError("GitLabPlatform.post_review_comment — TODO Phase 2")

    def reply_to_thread(self, pr_number: int, thread_id: str, body: str) -> None:
        raise NotImplementedError("GitLabPlatform.reply_to_thread — TODO Phase 2")

    def resolve_thread(self, pr_number: int, thread_id: str) -> None:
        raise NotImplementedError("GitLabPlatform.resolve_thread — TODO Phase 2")

    def get_file_content(self, path: str, ref: str = "") -> str | None:
        raise NotImplementedError("GitLabPlatform.get_file_content — TODO Phase 2")

    def post_pr_comment(self, pr_number: int, body: str) -> str:
        raise NotImplementedError("GitLabPlatform.post_pr_comment — TODO Phase 2")

    def get_pr_url(self, pr_number: int) -> str:
        return f"https://{self._host}/{self._project_path}/-/merge_requests/{pr_number}"

    def get_pr_number_for_branch(self, branch: str) -> int | None:
        raise NotImplementedError("GitLabPlatform.get_pr_number_for_branch — TODO Phase 2")
