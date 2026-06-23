"""Platform ABC and platform-neutral data types."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class PRMetadata:
    """Platform-neutral PR/MR metadata."""

    title: str
    base_branch: str
    head_sha: str
    base_sha: str
    start_sha: str  # For GitLab position objects; on GitHub, equals base_sha
    url: str
    pr_number: int
    state: str = ""
    raw: dict[str, Any] = field(default_factory=dict)  # Full API response for platform-specific needs


@dataclass
class ChangedFile:
    """Platform-neutral changed file."""

    path: str
    patch: str
    status: str
    additions: int = 0
    deletions: int = 0


@dataclass
class ReviewThread:
    """Platform-neutral review thread/discussion."""

    thread_id: str  # GitHub GraphQL node ID or GitLab discussion UUID
    path: str
    line: int | None
    end_line: int | None
    body: str
    author: str
    replies: list[dict[str, Any]] = field(default_factory=list)
    is_resolved: bool = False
    is_outdated: bool = False
    raw: dict[str, Any] = field(default_factory=dict)  # Full API response


class Platform(ABC):
    """Abstract interface for code hosting platforms.

    All methods return platform-neutral types. Implementations
    must not leak platform-specific identifiers into business logic.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Platform name: 'github' or 'gitlab'."""

    @property
    @abstractmethod
    def owner(self) -> str:
        """Repository owner or namespace."""

    @property
    @abstractmethod
    def repo(self) -> str:
        """Repository name."""

    @property
    @abstractmethod
    def project_path(self) -> str:
        """Full project path. For GitHub: owner/repo. For GitLab: group/subgroup/project."""

    @abstractmethod
    def fetch_pr_metadata(self, pr_number: int) -> PRMetadata:
        """Fetch PR/MR metadata."""

    @abstractmethod
    def fetch_diff(self, pr_number: int) -> str:
        """Fetch unified diff for a PR/MR."""

    @abstractmethod
    def fetch_changed_files(self, pr_number: int) -> list[ChangedFile]:
        """Fetch list of changed files with patches."""

    @abstractmethod
    def fetch_review_threads(self, pr_number: int, *, include_resolved: bool = False) -> list[ReviewThread]:
        """Fetch review threads/discussions."""

    @abstractmethod
    def fetch_issue_comments(self, pr_number: int) -> list[dict[str, Any]]:
        """Fetch issue/MR comments.

        Used for: Qodo sticky finding parsing, Qodo reply detection,
        Qodo mid-review detection, Qodo approval checking, CodeRabbit
        rate-limit detection, CodeRabbit summary comment lookup,
        consolidated body-comment posting.
        """

    @abstractmethod
    def post_review_comment(self, pr_number: int, commit_sha: str, path: str, line: int, body: str) -> str:
        """Post an inline review comment. Returns comment ID."""

    @abstractmethod
    def reply_to_thread(self, pr_number: int, thread_id: str, body: str) -> None:
        """Reply to an existing review thread/discussion."""

    @abstractmethod
    def resolve_thread(self, pr_number: int, thread_id: str) -> None:
        """Resolve a review thread/discussion."""

    @abstractmethod
    def get_file_content(self, path: str, ref: str = "") -> str | None:
        """Fetch file content from the repository. Returns None if not found."""

    @abstractmethod
    def post_pr_comment(self, pr_number: int, body: str) -> str:
        """Post a general PR/MR comment (not inline). Returns comment ID/URL."""

    @abstractmethod
    def get_pr_url(self, pr_number: int) -> str:
        """Return the web URL for a PR/MR."""

    @abstractmethod
    def get_pr_number_for_branch(self, branch: str) -> int | None:
        """Find the PR/MR number for a given branch. Returns None if not found."""
