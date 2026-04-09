"""Fetch release validation info and commits since last tag.

This module replicates the logic from get-release-info.sh.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass


@dataclass
class Metadata:
    """Repository metadata."""

    owner: str
    repo: str
    current_branch: str
    default_branch: str

    def to_dict(self) -> dict[str, str]:
        """Convert to dictionary."""
        return {
            "owner": self.owner,
            "repo": self.repo,
            "current_branch": self.current_branch,
            "default_branch": self.default_branch,
        }


@dataclass
class Validations:
    """Release prerequisite validations."""

    on_target_branch: bool
    default_branch: str
    current_branch: str
    working_tree_clean: bool
    dirty_files: str
    fetch_successful: bool
    synced_with_remote: bool
    unpushed_commits: int
    behind_remote: int
    all_passed: bool

    def to_dict(self) -> dict[str, str | bool | int]:
        """Convert to dictionary."""
        return {
            "on_target_branch": self.on_target_branch,
            "default_branch": self.default_branch,
            "current_branch": self.current_branch,
            "working_tree_clean": self.working_tree_clean,
            "dirty_files": self.dirty_files,
            "fetch_successful": self.fetch_successful,
            "synced_with_remote": self.synced_with_remote,
            "unpushed_commits": self.unpushed_commits,
            "behind_remote": self.behind_remote,
            "all_passed": self.all_passed,
        }


@dataclass
class Commit:
    """A single commit."""

    hash: str
    short_hash: str
    subject: str
    body: str
    author: str
    date: str

    def to_dict(self) -> dict[str, str]:
        """Convert to dictionary."""
        return {
            "hash": self.hash,
            "short_hash": self.short_hash,
            "subject": self.subject,
            "body": self.body,
            "author": self.author,
            "date": self.date,
        }


@dataclass
class ReleaseInfo:
    """Complete release information."""

    metadata: Metadata
    validations: Validations
    last_tag: str | None
    all_tags: list[str]
    commits: list[Commit]
    commit_count: int
    is_first_release: bool | None
    target_branch: str | None
    tag_match: str | None

    def to_dict(self) -> dict[str, object]:
        """Convert to dictionary for JSON output."""
        return {
            "metadata": self.metadata.to_dict(),
            "validations": self.validations.to_dict(),
            "last_tag": self.last_tag,
            "all_tags": self.all_tags,
            "commits": [c.to_dict() for c in self.commits],
            "commit_count": self.commit_count,
            "is_first_release": self.is_first_release,
            "target_branch": self.target_branch,
            "tag_match": self.tag_match,
        }


def _run_command(cmd: list[str], capture_stderr: bool = False, timeout: int = 60) -> tuple[int, str]:
    """Run a command and return exit code and output."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
        output = result.stdout.strip()
        if capture_stderr and result.returncode != 0:
            output = result.stderr.strip()
        return result.returncode, output
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 1, ""


def _check_dependencies() -> list[str]:
    """Check for required dependencies."""
    missing = []
    for cmd in ["gh", "git"]:
        if shutil.which(cmd) is None:
            missing.append(cmd)
    return missing


def _detect_repo(repo: str | None) -> str | None:
    """Detect repository from git context or use provided value."""
    if repo:
        return repo

    code, output = _run_command(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
    if code == 0 and output:
        return output
    return None


def _get_current_branch() -> str:
    """Get the current git branch."""
    code, output = _run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    return output if code == 0 else ""


def _get_default_branch() -> str:
    """Get the default branch from GitHub."""
    code, output = _run_command(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])
    return output if code == 0 and output else "main"


def _get_last_tag(tag_match: str | None = None) -> str | None:
    """Get the most recent tag, optionally filtered by a glob pattern."""
    cmd = ["git", "describe", "--tags", "--abbrev=0"]
    if tag_match:
        cmd.extend(["--match", tag_match])
    code, output = _run_command(cmd)
    return output if code == 0 and output else None


def _get_all_tags(limit: int = 10, tag_match: str | None = None) -> list[str]:
    """Get recent tags sorted by version (last N), optionally filtered."""
    cmd = ["git", "tag", "--sort=-v:refname"]
    if tag_match:
        cmd.extend(["-l", "--", tag_match])
    code, output = _run_command(cmd)
    if code != 0 or not output:
        return []
    tags = output.split("\n")
    return [t for t in tags[:limit] if t]


_VERSION_BRANCH_RE = re.compile(r"^v(\d+\.\d+)$")

# Valid characters for tag match glob patterns (letters, digits, dots, asterisks, hyphens, underscores)
_VALID_TAG_MATCH_RE = re.compile(r"^[A-Za-z0-9._*][A-Za-z0-9._*-]*$")

# Valid characters for branch names (no leading dash, no revision syntax)
_VALID_BRANCH_RE = re.compile(r"^(?!.*\.\.)[A-Za-z0-9._/][A-Za-z0-9._/-]*$")

_ERR_INVALID_TARGET = "Invalid target branch: {!r}. Must not start with '-' or contain revision syntax."
_ERR_INVALID_TAG_MATCH = "Invalid tag-match pattern: {!r}. Only alphanumeric, '.', '*', '-', '_' allowed."


def _detect_version_branch(current_branch: str) -> tuple[str | None, str | None]:
    """Auto-detect version branch and infer tag match pattern.

    If the current branch matches vMAJOR.MINOR (e.g., v2.10), returns
    the branch as the target and a glob pattern to scope tag discovery.

    Returns:
        Tuple of (target_branch, tag_match) or (None, None) if not a version branch.
    """
    match = _VERSION_BRANCH_RE.match(current_branch)
    if match:
        version_prefix = match.group(1)
        return current_branch, f"v{version_prefix}.*"
    return None, None


def _perform_validations(default_branch: str, current_branch: str, target_branch: str | None = None) -> Validations:
    """Perform release prerequisite validations."""
    # 1. Default Branch Check
    effective_target = target_branch or default_branch
    on_target_branch = current_branch == effective_target

    # 2. Clean Working Tree Check
    working_tree_clean = True
    dirty_files = ""

    diff_code, _ = _run_command(["git", "diff", "--quiet"])
    cached_code, _ = _run_command(["git", "diff", "--cached", "--quiet"])

    if diff_code != 0 or cached_code != 0:
        working_tree_clean = False
        _, status_output = _run_command(["git", "status", "--porcelain"])
        if status_output:
            dirty_files = "\n".join(status_output.split("\n")[:10])

    # 3. Remote Sync Check
    fetch_code, _ = _run_command(["git", "fetch", "origin", effective_target, "--quiet"])
    fetch_successful = fetch_code == 0

    if not fetch_successful:
        synced_with_remote = False
        unpushed_commits = 0
        behind_remote = 0
    else:
        # Check for unpushed commits
        _, unpushed_output = _run_command([
            "git",
            "rev-list",
            f"origin/{effective_target}..{effective_target}",
            "--count",
        ])
        unpushed_commits = int(unpushed_output) if unpushed_output.isdigit() else 0

        # Check if behind remote
        _, behind_output = _run_command([
            "git",
            "rev-list",
            f"{effective_target}..origin/{effective_target}",
            "--count",
        ])
        behind_remote = int(behind_output) if behind_output.isdigit() else 0

        synced_with_remote = unpushed_commits == 0 and behind_remote == 0

    # Calculate all_passed
    all_passed = fetch_successful and on_target_branch and working_tree_clean and synced_with_remote

    return Validations(
        on_target_branch=on_target_branch,
        default_branch=default_branch,
        current_branch=current_branch,
        working_tree_clean=working_tree_clean,
        dirty_files=dirty_files,
        fetch_successful=fetch_successful,
        synced_with_remote=synced_with_remote,
        unpushed_commits=unpushed_commits,
        behind_remote=behind_remote,
        all_passed=all_passed,
    )


def _get_commits(last_tag: str | None, limit: int = 100) -> tuple[list[Commit], bool]:
    """Get commits since last tag.

    Returns:
        Tuple of (commits list, is_first_release flag)
    """
    if last_tag:
        commit_range = f"{last_tag}..HEAD"
        is_first_release = False
    else:
        commit_range = "HEAD"
        is_first_release = True

    # Use %x00 as record separator, %x1F as field separator
    # Include body in the format string
    format_str = "%H%x1F%h%x1F%s%x1F%an%x1F%ai%x1F%b%x00"
    code, output = _run_command(["git", "log", f"--format={format_str}", "-n", str(limit), commit_range])

    if code != 0 or not output:
        return [], is_first_release

    commits = []
    # Split by record separator, filter empty
    for record in output.split("\x00"):
        if not record.strip():
            continue

        parts = record.split("\x1f")
        if len(parts) < 6:
            continue

        hash_full, short_hash, subject, author, date = parts[:5]
        # Body is everything after the 5th field separator
        body = parts[5] if len(parts) > 5 else ""
        # Clean up body
        body = " ".join(body.split())

        commits.append(
            Commit(
                hash=hash_full,
                short_hash=short_hash,
                subject=subject,
                body=body,
                author=author,
                date=date,
            )
        )

    return commits, is_first_release


def get_release_info(repo: str | None = None, target: str | None = None, tag_match: str | None = None) -> ReleaseInfo:
    """Fetch release information for a GitHub repository.

    Args:
        repo: Repository in owner/repo format. If None, detects from git context.
        target: Target branch for release (overrides default branch check).
        tag_match: Glob pattern to filter tags (e.g., 'v2.10.*').

    Returns:
        ReleaseInfo object with all release data.

    Raises:
        RuntimeError: If dependencies are missing or repository cannot be determined.
    """
    # Check dependencies
    missing = _check_dependencies()
    if missing:
        raise RuntimeError(f"Missing dependencies: {', '.join(missing)}")

    # Detect repository
    full_repo = _detect_repo(repo)
    if not full_repo:
        raise RuntimeError("Could not determine repository. Use --repo owner/repo or run from a git repository.")

    # Parse owner and repo
    parts = full_repo.split("/")
    if len(parts) != 2:
        raise RuntimeError(f"Invalid repository format: {full_repo}")
    owner, repo_name = parts

    # Get branch info
    current_branch = _get_current_branch()
    default_branch = _get_default_branch()

    # Auto-detect version branch if no explicit target
    effective_target = target
    if target and not _VALID_BRANCH_RE.match(target):
        raise RuntimeError(_ERR_INVALID_TARGET.format(target))
    effective_tag_match = tag_match
    if not effective_target:
        auto_target, auto_tag_match = _detect_version_branch(current_branch)
        if auto_target:
            effective_target = auto_target
            if not effective_tag_match:
                effective_tag_match = auto_tag_match

    # Fall back to default branch if no target was determined
    if not effective_target:
        effective_target = default_branch

    # Validate tag_match pattern
    if effective_tag_match and not _VALID_TAG_MATCH_RE.match(effective_tag_match):
        raise RuntimeError(_ERR_INVALID_TAG_MATCH.format(effective_tag_match))

    # Perform validations
    validations = _perform_validations(default_branch, current_branch, effective_target)

    metadata = Metadata(
        owner=owner,
        repo=repo_name,
        current_branch=current_branch,
        default_branch=default_branch,
    )

    # Early return if validations failed - skip expensive commit collection
    if not validations.all_passed:
        return ReleaseInfo(
            metadata=metadata,
            validations=validations,
            last_tag=None,
            all_tags=[],
            commits=[],
            commit_count=0,
            is_first_release=None,
            target_branch=effective_target,
            tag_match=effective_tag_match,
        )

    # Validations passed - proceed with expensive operations
    last_tag = _get_last_tag(effective_tag_match)
    all_tags = _get_all_tags(tag_match=effective_tag_match)
    commits, is_first_release = _get_commits(last_tag)

    return ReleaseInfo(
        metadata=metadata,
        validations=validations,
        last_tag=last_tag,
        all_tags=all_tags,
        commits=commits,
        commit_count=len(commits),
        is_first_release=is_first_release,
        target_branch=effective_target,
        tag_match=effective_tag_match,
    )


def run(repo: str | None = None, target: str | None = None, tag_match: str | None = None) -> None:
    """Entry point for CLI command.

    Args:
        repo: Repository in owner/repo format. If None, detects from git context.
        target: Target branch for release (overrides default branch check).
        tag_match: Glob pattern to filter tags (e.g., 'v2.10.*').
    """
    try:
        info = get_release_info(repo, target=target, tag_match=tag_match)
        print(json.dumps(info.to_dict(), indent=2))
    except RuntimeError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
