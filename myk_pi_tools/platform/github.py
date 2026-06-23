"""GitHub platform implementation using gh CLI."""

from __future__ import annotations

import shutil
import subprocess
import sys
from typing import Any

from myk_pi_tools.platform.base import (
    ChangedFile,
    Platform,
    PRMetadata,
    ReviewThread,
)


class GitHubPlatform(Platform):
    """GitHub implementation using gh CLI and GraphQL API."""

    def __init__(self, owner: str, repo: str, *, cwd: str | None = None) -> None:
        self._owner = owner
        self._repo = repo
        self._cwd = cwd
        self._verify_auth()

    def _verify_auth(self) -> None:
        """Pre-flight check: verify gh is installed and authenticated."""
        if not shutil.which("gh"):
            print("Error: GitHub CLI (gh) not found. Install gh.", file=sys.stderr)
            sys.exit(1)
        try:
            result = subprocess.run(
                ["gh", "auth", "status"],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=self._cwd,
            )
            if result.returncode != 0:
                print(
                    "Error: gh not authenticated. Run: gh auth login",
                    file=sys.stderr,
                )
                sys.exit(1)
        except subprocess.TimeoutExpired:
            print("Error: gh auth status timed out.", file=sys.stderr)
            sys.exit(1)

    @property
    def name(self) -> str:
        return "github"

    @property
    def owner(self) -> str:
        return self._owner

    @property
    def repo(self) -> str:
        return self._repo

    @property
    def project_path(self) -> str:
        return f"{self._owner}/{self._repo}"

    def fetch_pr_metadata(self, pr_number: int) -> PRMetadata:
        raise NotImplementedError("GitHubPlatform.fetch_pr_metadata — TODO Phase 2")

    def fetch_diff(self, pr_number: int) -> str:
        raise NotImplementedError("GitHubPlatform.fetch_diff — TODO Phase 2")

    def fetch_changed_files(self, pr_number: int) -> list[ChangedFile]:
        raise NotImplementedError("GitHubPlatform.fetch_changed_files — TODO Phase 2")

    def fetch_review_threads(self, pr_number: int, *, include_resolved: bool = False) -> list[ReviewThread]:
        raise NotImplementedError("GitHubPlatform.fetch_review_threads — TODO Phase 2")

    def fetch_issue_comments(self, pr_number: int) -> list[dict[str, Any]]:
        raise NotImplementedError("GitHubPlatform.fetch_issue_comments — TODO Phase 2")

    def post_review_comment(self, pr_number: int, commit_sha: str, path: str, line: int, body: str) -> str:
        raise NotImplementedError("GitHubPlatform.post_review_comment — TODO Phase 2")

    def reply_to_thread(self, pr_number: int, thread_id: str, body: str) -> None:
        raise NotImplementedError("GitHubPlatform.reply_to_thread — TODO Phase 2")

    def resolve_thread(self, pr_number: int, thread_id: str) -> None:
        raise NotImplementedError("GitHubPlatform.resolve_thread — TODO Phase 2")

    def get_file_content(self, path: str, ref: str = "") -> str | None:
        raise NotImplementedError("GitHubPlatform.get_file_content — TODO Phase 2")

    def post_pr_comment(self, pr_number: int, body: str) -> str:
        raise NotImplementedError("GitHubPlatform.post_pr_comment — TODO Phase 2")

    def get_pr_url(self, pr_number: int) -> str:
        return f"https://github.com/{self._owner}/{self._repo}/pull/{pr_number}"

    def get_pr_number_for_branch(self, branch: str) -> int | None:
        raise NotImplementedError("GitHubPlatform.get_pr_number_for_branch — TODO Phase 2")
