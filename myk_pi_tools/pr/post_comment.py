"""Post inline comments to a PR as a single GitHub review with summary.

Usage:
    myk-pi-tools pr post-comment <owner/repo> <pr_number> <commit_sha> <json_file>
    myk-pi-tools pr post-comment <owner/repo> <pr_number> <commit_sha> -  # stdin

JSON Input Format (array of comments):
    [
        {
            "path": "src/main.py",
            "line": 42,
            "body": "### [CRITICAL] SQL Injection\\n\\nDescription..."
        },
        {
            "path": "src/utils.py",
            "line": 15,
            "body": "### [WARNING] Missing error handling\\n\\nDescription..."
        }
    ]

Severity Markers:
    - ### [CRITICAL] Title - For critical security/functionality issues
    - ### [WARNING] Title  - For important but non-critical issues
    - ### [SUGGESTION] Title - For code improvements and suggestions
    If no severity marker is present, the comment is categorized as SUGGESTION.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Comment:
    """A PR review comment."""

    path: str
    line: int
    body: str

    @property
    def severity(self) -> str:
        """Extract severity from comment body."""
        body = self.body.lstrip()
        match = re.match(r"^### \[(CRITICAL|WARNING|SUGGESTION)\]", body)
        if match:
            return match.group(1)
        return "SUGGESTION"

    @property
    def title(self) -> str:
        """Extract title from comment body."""
        first_line = self.body.lstrip().split("\n", 1)[0]
        # Remove severity marker if present
        title = re.sub(r"^### \[(CRITICAL|WARNING|SUGGESTION)\]\s*", "", first_line)
        # Remove leading ### if still present
        title = re.sub(r"^###\s*", "", title)
        return title[:80]  # Truncate to 80 chars


@dataclass
class ReviewResult:
    """Result of posting a review."""

    status: str
    comment_count: int
    posted: list[dict[str, Any]] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


def validate_repo_format(repo_full_name: str) -> bool:
    """Validate repository format (owner/repo).

    Args:
        repo_full_name: Repository name in owner/repo format.

    Returns:
        True if valid format.
    """
    return bool(re.match(r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$", repo_full_name))


def validate_pr_number(pr_number: str) -> bool:
    """Validate PR number is numeric.

    Args:
        pr_number: PR number string.

    Returns:
        True if numeric.
    """
    return bool(re.match(r"^\d+$", pr_number))


def validate_commit_sha(sha: str) -> bool:
    """Validate commit SHA is a 40-character hex string.

    Args:
        sha: Commit SHA string.

    Returns:
        True if valid 40-character hex string.
    """
    return bool(re.match(r"^[0-9a-fA-F]{40}$", sha))


def _parse_line(item: dict[str, Any], index: int) -> int:
    """Parse line value from comment item.

    Args:
        item: Comment dictionary with 'line' field.
        index: Index of the comment in the input array (for error messages).

    Returns:
        The line number as an integer.

    Raises:
        SystemExit: If line value cannot be converted to int.
    """
    try:
        return int(item["line"])
    except (TypeError, ValueError):
        print(
            f"Error: Comment at index {index} has non-numeric 'line' value: {item['line']!r}",
            file=sys.stderr,
        )
        sys.exit(1)


def load_comments(json_source: str) -> list[Comment]:
    """Load comments from JSON file or stdin.

    Args:
        json_source: Path to JSON file, or "-" for stdin.

    Returns:
        List of Comment objects.

    Raises:
        SystemExit: If JSON is invalid or missing required fields.
    """
    if json_source == "-":
        content = sys.stdin.read()
    else:
        json_path = Path(json_source)
        if not json_path.is_file():
            print(f"Error: JSON file not found: {json_source}", file=sys.stderr)
            sys.exit(1)
        content = json_path.read_text()

    # Sanitize JSON - try progressive parsing to find valid JSON start
    # This handles cases where text gets prepended by hooks/shell
    lines = content.split("\n")
    for i, line in enumerate(lines):
        if line.strip().startswith("["):
            try:
                candidate = "\n".join(lines[i:])
                json.loads(candidate)  # Test if valid
                content = candidate
                break
            except json.JSONDecodeError:
                continue

    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, list):
        print("Error: JSON input must be an array of comments", file=sys.stderr)
        sys.exit(1)

    # Validate and convert to Comment objects
    comments = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            print(f"Error: Comment at index {i} is not an object", file=sys.stderr)
            sys.exit(1)
        for field_name in ("path", "line", "body"):
            if field_name not in item:
                print(
                    f"Error: Comment at index {i} missing '{field_name}' field",
                    file=sys.stderr,
                )
                sys.exit(1)
        comments.append(
            Comment(
                path=item["path"],
                line=_parse_line(item, i),
                body=item["body"],
            )
        )

    return comments


def generate_review_body(comments: list[Comment]) -> str:
    """Generate the review summary body.

    Args:
        comments: List of comments.

    Returns:
        Markdown formatted review body.
    """
    # Categorize comments by severity
    critical: list[tuple[str, int, str]] = []
    warning: list[tuple[str, int, str]] = []
    suggestion: list[tuple[str, int, str]] = []

    for comment in comments:
        entry = (comment.path, comment.line, comment.title)
        if comment.severity == "CRITICAL":
            critical.append(entry)
        elif comment.severity == "WARNING":
            warning.append(entry)
        else:
            suggestion.append(entry)

    # Build review body
    lines = [
        "## Code Review",
        "",
        f"Found **{len(comments)}** issue(s) in this PR:",
        "",
    ]

    def add_section(title: str, emoji: str, items: list[tuple[str, int, str]]) -> None:
        if not items:
            return

        def _cell(s: str) -> str:
            s = " ".join(str(s).splitlines())
            return s.replace("|", r"\|")

        lines.append(f"### {emoji} {title} ({len(items)})")
        lines.append("")
        lines.append("| File | Line | Issue |")
        lines.append("|------|------|-------|")
        for path, line, issue_title in items:
            lines.append(f"| `{_cell(path)}` | {line} | {_cell(issue_title)} |")
        lines.append("")

    add_section("Critical Issues", ":red_circle:", critical)
    add_section("Warnings", ":warning:", warning)
    add_section("Suggestions", ":bulb:", suggestion)

    lines.append("---")
    lines.append("*Review generated by pi*")

    return "\n".join(lines)


def post_review(
    repo_full_name: str,
    pr_number: str,
    commit_sha: str,
    comments: list[Comment],
) -> ReviewResult:
    """Post a review with inline comments to GitHub.

    Args:
        repo_full_name: Repository in owner/repo format.
        pr_number: PR number.
        commit_sha: Commit SHA to comment on.
        comments: List of comments to post.

    Returns:
        ReviewResult with status and details.
    """
    review_body = generate_review_body(comments)

    # Build review payload
    payload = {
        "commit_id": commit_sha,
        "body": review_body,
        "event": "COMMENT",
        "comments": [
            {
                "path": c.path,
                "line": c.line,
                "body": c.body,
                "side": "RIGHT",
            }
            for c in comments
        ],
    }

    try:
        subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{repo_full_name}/pulls/{pr_number}/reviews",
                "-X",
                "POST",
                "--input",
                "-",
            ],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )

        posted = [{"path": c.path, "line": c.line} for c in comments]
        return ReviewResult(
            status="success",
            comment_count=len(comments),
            posted=posted,
        )

    except subprocess.CalledProcessError as e:
        return ReviewResult(
            status="failed",
            comment_count=len(comments),
            failed=[{"path": c.path, "line": c.line} for c in comments],
            error=e.stderr,
        )
    except subprocess.TimeoutExpired:
        return ReviewResult(
            status="failed",
            comment_count=len(comments),
            failed=[{"path": c.path, "line": c.line} for c in comments],
            error="GitHub API request timed out after 120 seconds",
        )


def run(owner_repo: str, pr_number: str, commit_sha: str, json_file: str) -> None:
    """Main entry point for the pr-post-comment command.

    Args:
        owner_repo: Repository in owner/repo format.
        pr_number: PR number.
        commit_sha: Commit SHA to comment on.
        json_file: Path to JSON file with comments, or "-" for stdin.
    """
    # Validate arguments
    if not validate_repo_format(owner_repo):
        print(
            f"Error: Invalid repo format. Expected 'owner/repo', got: {owner_repo}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not validate_pr_number(pr_number):
        print(
            f"Error: PR number must be numeric, got: {pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Load comments
    comments = load_comments(json_file)

    if not comments:
        print(json.dumps({"status": "success", "comment_count": 0, "posted": [], "failed": []}))
        return

    print(f"Posting review with {len(comments)} comment(s) on PR #{pr_number}...", file=sys.stderr)

    # Post review
    result = post_review(owner_repo, pr_number, commit_sha, comments)

    # Output result as JSON
    output = {
        "status": result.status,
        "comment_count": result.comment_count,
        "posted": result.posted,
        "failed": result.failed,
    }
    if result.error:
        output["error"] = result.error
        print("", file=sys.stderr)
        print("Common issues:", file=sys.stderr)
        print("  - Line numbers might not be part of the diff in this PR", file=sys.stderr)
        print(f"  - File paths might not exist in commit {commit_sha}", file=sys.stderr)
        print("  - Commit SHA might not be the HEAD of the PR", file=sys.stderr)
        print("", file=sys.stderr)
        print(
            "Tip: Only lines that were modified or added in the PR can receive inline comments",
            file=sys.stderr,
        )

    print(json.dumps(output, indent=2))

    if result.status == "failed":
        sys.exit(1)
