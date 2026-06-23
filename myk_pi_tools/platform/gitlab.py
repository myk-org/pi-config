"""GitLab platform implementation using glab CLI."""

from __future__ import annotations

import json
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


def _print_stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


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
            _print_stderr("Error: glab CLI not found. Install glab.")
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
                _print_stderr(
                    f"Error: glab not authenticated for {self._host}. Run: glab auth login --hostname {self._host}"
                )
                sys.exit(1)
        except subprocess.TimeoutExpired:
            _print_stderr("Error: glab auth status timed out.")
            sys.exit(1)

    # ── Internal helpers ──

    @property
    def _encoded_path(self) -> str:
        """URL-encoded project path for API endpoints."""
        return url_quote(self._project_path, safe="")

    def _run_api(
        self,
        endpoint: str,
        *,
        method: str = "GET",
        input_data: str | None = None,
        paginate: bool = False,
        timeout: int = 120,
    ) -> Any | None:
        """Run a REST API call via glab api."""
        cmd = ["glab", "api"]
        if method != "GET":
            cmd.extend(["-X", method])
        if paginate:
            cmd.append("--paginate")
        cmd.append(endpoint)

        kwargs: dict[str, Any] = {"capture_output": True, "text": True, "timeout": timeout, "cwd": self._cwd}
        if input_data:
            kwargs["input"] = input_data

        try:
            result = subprocess.run(cmd, **kwargs)
        except subprocess.TimeoutExpired:
            _print_stderr(f"Error: API call to {endpoint} timed out after {timeout}s")
            return None

        if result.returncode != 0:
            if result.stderr:
                _print_stderr(f"Warning: API call to {endpoint} failed: {result.stderr.strip()}")
            return None

        if not result.stdout.strip():
            return None

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as e:
            _print_stderr(f"Error parsing JSON from glab api: {e}")
            return None

    def _encode_file_path(self, path: str) -> str:
        """URL-encode a file path for GitLab file API."""
        return url_quote(path, safe="")

    # ── Platform properties ──

    @property
    def name(self) -> str:
        return "gitlab"

    @property
    def owner(self) -> str:
        parts = self._project_path.rsplit("/", 1)
        return parts[0] if len(parts) > 1 else ""

    @property
    def repo(self) -> str:
        return self._project_path.rsplit("/", 1)[-1]

    @property
    def project_path(self) -> str:
        return self._project_path

    # ── Platform methods ──

    def fetch_pr_metadata(self, pr_number: int) -> PRMetadata:
        result = self._run_api(f"projects/{self._encoded_path}/merge_requests/{pr_number}")
        if result is None:
            _print_stderr(f"Error: Failed to fetch MR metadata for {self._project_path}!{pr_number}")
            sys.exit(1)

        diff_refs = result.get("diff_refs") or {}

        return PRMetadata(
            title=result.get("title", ""),
            base_branch=result.get("target_branch", ""),
            head_sha=diff_refs.get("head_sha", result.get("sha", "")),
            base_sha=diff_refs.get("base_sha", ""),
            start_sha=diff_refs.get("start_sha", diff_refs.get("base_sha", "")),
            url=result.get("web_url", ""),
            pr_number=pr_number,
            state=result.get("state", ""),
            raw=result,
        )

    def fetch_diff(self, pr_number: int) -> str:
        """Fetch MR diff using glab mr diff."""
        try:
            result = subprocess.run(
                ["glab", "mr", "diff", str(pr_number)],
                capture_output=True,
                text=True,
                timeout=120,
                cwd=self._cwd,
            )
            if result.returncode == 0:
                return result.stdout
            _print_stderr(f"Error: Failed to fetch MR diff: {result.stderr}")
            sys.exit(1)
        except FileNotFoundError:
            _print_stderr("Error: glab CLI not found.")
            sys.exit(1)
        except subprocess.TimeoutExpired:
            _print_stderr(f"Error: Timed out fetching MR diff for {self._project_path}!{pr_number}")
            sys.exit(1)

    def fetch_changed_files(self, pr_number: int) -> list[ChangedFile]:
        result = self._run_api(f"projects/{self._encoded_path}/merge_requests/{pr_number}/changes")
        if result is None:
            _print_stderr(f"Error: Failed to fetch changed files for {self._project_path}!{pr_number}")
            sys.exit(1)

        changes = result.get("changes") or []
        files: list[ChangedFile] = []
        for change in changes:
            # Determine status from GitLab change data
            if change.get("new_file"):
                status = "added"
            elif change.get("deleted_file"):
                status = "removed"
            elif change.get("renamed_file"):
                status = "renamed"
            else:
                status = "modified"

            files.append(
                ChangedFile(
                    path=change.get("new_path", change.get("old_path", "")),
                    patch=change.get("diff", ""),
                    status=status,
                )
            )

        return files

    def fetch_review_threads(self, pr_number: int, *, include_resolved: bool = False) -> list[ReviewThread]:
        """Fetch MR discussions (threads) via REST API."""
        result = self._run_api(
            f"projects/{self._encoded_path}/merge_requests/{pr_number}/discussions",
            paginate=True,
        )
        if result is None:
            return []

        threads: list[ReviewThread] = []
        for discussion in result:
            notes = discussion.get("notes") or []
            if not notes:
                continue

            # Skip system notes (e.g., "mentioned in commit", "assigned to")
            first_note = notes[0]
            if first_note.get("system", False):
                continue

            is_resolved = discussion.get("individual_note", False) is False and any(
                n.get("resolvable", False) for n in notes
            )
            # Check if all resolvable notes are resolved
            resolvable_notes = [n for n in notes if n.get("resolvable", False)]
            if resolvable_notes:
                is_resolved = all(n.get("resolved", False) for n in resolvable_notes)
            else:
                is_resolved = False

            if is_resolved and not include_resolved:
                continue

            # First note is the comment, rest are replies
            rest_notes = notes[1:]

            author = first_note.get("author", {}).get("username", "")

            threads.append(
                ReviewThread(
                    thread_id=discussion.get("id", ""),
                    path=first_note.get("position", {}).get("new_path", ""),
                    line=first_note.get("position", {}).get("new_line"),
                    end_line=None,
                    body=first_note.get("body", ""),
                    author=author,
                    replies=[
                        {
                            "author": n.get("author", {}).get("username", ""),
                            "body": n.get("body", ""),
                            "created_at": n.get("created_at"),
                        }
                        for n in rest_notes
                    ],
                    is_resolved=is_resolved,
                    raw={
                        "note_id": first_note.get("id"),
                        "discussion_id": discussion.get("id"),
                        "created_at": first_note.get("created_at"),
                    },
                )
            )

        return threads

    def fetch_issue_comments(self, pr_number: int) -> list[dict[str, Any]]:
        """Fetch MR notes (comments) via REST API."""
        result = self._run_api(
            f"projects/{self._encoded_path}/merge_requests/{pr_number}/notes",
            paginate=True,
        )
        if result is None:
            return []

        # Transform to match the shape expected by parsers
        # (similar to GitHub issue comments structure)
        comments = []
        for note in result:
            if note.get("system", False):
                continue
            comments.append({
                "id": note.get("id"),
                "node_id": str(note.get("id", "")),
                "body": note.get("body", ""),
                "user": {
                    "login": note.get("author", {}).get("username", ""),
                },
                "created_at": note.get("created_at"),
                "updated_at": note.get("updated_at"),
            })

        return comments

    def post_review_comment(self, pr_number: int, commit_sha: str, path: str, line: int, body: str) -> str:  # noqa: ARG002
        """Post an inline comment as a new MR discussion with position."""
        # First fetch MR metadata for diff_refs
        metadata = self.fetch_pr_metadata(pr_number)

        payload = {
            "body": body,
            "position": {
                "base_sha": metadata.base_sha,
                "start_sha": metadata.start_sha,
                "head_sha": metadata.head_sha,
                "position_type": "text",
                "new_path": path,
                "old_path": path,
                "new_line": line,
            },
        }

        result = self._run_api(
            f"projects/{self._encoded_path}/merge_requests/{pr_number}/discussions",
            method="POST",
            input_data=json.dumps(payload),
        )
        if result is None:
            _print_stderr(f"Error: Failed to post review comment on {path}:{line}")
            return ""
        return str(result.get("id", ""))

    def reply_to_thread(self, pr_number: int, thread_id: str, body: str) -> None:
        """Reply to an MR discussion."""
        payload = {"body": body}
        result = self._run_api(
            f"projects/{self._encoded_path}/merge_requests/{pr_number}/discussions/{thread_id}/notes",
            method="POST",
            input_data=json.dumps(payload),
        )
        if result is None:
            _print_stderr(f"Error: Failed to reply to discussion {thread_id}")

    def resolve_thread(self, pr_number: int, thread_id: str) -> None:
        """Resolve an MR discussion."""
        result = self._run_api(
            f"projects/{self._encoded_path}/merge_requests/{pr_number}/discussions/{thread_id}",
            method="PUT",
            input_data=json.dumps({"resolved": True}),
        )
        if result is None:
            _print_stderr(f"Error: Failed to resolve discussion {thread_id}")

    def get_file_content(self, path: str, ref: str = "") -> str | None:
        """Fetch file content from GitLab repository."""
        encoded_path = self._encode_file_path(path)
        endpoint = f"projects/{self._encoded_path}/repository/files/{encoded_path}/raw"
        if ref:
            endpoint += f"?ref={ref}"

        # Raw file content — not JSON, use subprocess directly
        cmd = ["glab", "api", endpoint]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=self._cwd,
            )
            return result.stdout if result.returncode == 0 and result.stdout else None
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return None

    def post_pr_comment(self, pr_number: int, body: str) -> str:
        """Post a general MR note."""
        payload = {"body": body}
        result = self._run_api(
            f"projects/{self._encoded_path}/merge_requests/{pr_number}/notes",
            method="POST",
            input_data=json.dumps(payload),
        )
        if result is None:
            _print_stderr(f"Error: Failed to post MR comment on {self._project_path}!{pr_number}")
            return ""
        return str(result.get("id", ""))

    def get_pr_url(self, pr_number: int) -> str:
        return f"https://{self._host}/{self._project_path}/-/merge_requests/{pr_number}"

    def get_pr_number_for_branch(self, branch: str) -> int | None:
        """Find MR number for a given branch using glab mr list."""
        try:
            result = subprocess.run(
                ["glab", "mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=self._cwd,
            )
            if result.returncode == 0 and result.stdout.strip():
                mrs = json.loads(result.stdout)
                if mrs and len(mrs) > 0:
                    return int(mrs[0].get("iid", 0)) or None
        except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError, ValueError):
            pass
        return None
