"""GitHub platform implementation using gh CLI."""

from __future__ import annotations

import json
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
from myk_pi_tools.utils import merge_paginated_json


def _print_stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


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
            _print_stderr("Error: GitHub CLI (gh) not found. Install gh.")
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
                _print_stderr("Error: gh not authenticated. Run: gh auth login")
                sys.exit(1)
        except subprocess.TimeoutExpired:
            _print_stderr("Error: gh auth status timed out.")
            sys.exit(1)

    # ── Internal helpers ──

    def _run_api(
        self,
        endpoint: str,
        *,
        paginate: bool = False,
        method: str | None = None,
        input_data: str | None = None,
        headers: list[str] | None = None,
        timeout: int = 120,
    ) -> Any | None:
        """Run a REST API call via gh api."""
        cmd = ["gh", "api"]
        if paginate:
            cmd.append("--paginate")
        if method:
            cmd.extend(["-X", method])
        if headers:
            for h in headers:
                cmd.extend(["-H", h])
        cmd.append(endpoint)

        kwargs: dict[str, Any] = {"capture_output": True, "text": True, "timeout": timeout, "cwd": self._cwd}
        if input_data:
            cmd.extend(["--input", "-"])
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

        try:
            if paginate:
                return merge_paginated_json(result.stdout)
            return json.loads(result.stdout)
        except json.JSONDecodeError as e:
            _print_stderr(f"Error parsing JSON from gh api: {e}")
            return None

    def _run_graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any] | None:
        """Run a GraphQL query via gh api graphql."""
        payload = {"query": query, "variables": variables}
        cmd = ["gh", "api", "graphql", "--input", "-"]

        try:
            result = subprocess.run(
                cmd,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=120,
                cwd=self._cwd,
            )
        except subprocess.TimeoutExpired:
            _print_stderr("Error: GraphQL query timed out after 120s")
            return None

        if result.returncode != 0:
            if result.stderr:
                _print_stderr(f"Warning: GraphQL query failed: {result.stderr.strip()}")
            return None

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            return None

        if data.get("errors"):
            _print_stderr(f"Warning: GraphQL errors: {data['errors'][0].get('message', 'Unknown')}")

        return data

    def _run_graphql_mutation(self, query: str, variables: dict[str, Any]) -> tuple[bool, Any]:
        """Run a GraphQL mutation. Returns (success, result_or_error)."""
        payload = {"query": query, "variables": variables}
        cmd = ["gh", "api", "graphql", "--input", "-"]

        try:
            result = subprocess.run(
                cmd,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=120,
                cwd=self._cwd,
            )
        except subprocess.TimeoutExpired:
            return False, "GraphQL mutation timed out after 120s"

        stdout = result.stdout or ""
        stderr = result.stderr or ""

        if result.returncode != 0:
            return False, (stdout + ("\n" + stderr if stderr else "")).strip()

        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            return False, (stdout + ("\n" + stderr if stderr else "")).strip()

        if data.get("errors") and len(data["errors"]) > 0:
            return False, data["errors"][0].get("message", "Unknown error")

        return True, data

    # ── Platform properties ──

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

    # ── Platform methods ──

    def fetch_pr_metadata(self, pr_number: int) -> PRMetadata:
        result = self._run_api(f"/repos/{self._owner}/{self._repo}/pulls/{pr_number}")
        if result is None:
            _print_stderr(f"Error: Failed to fetch PR metadata for {self.project_path}#{pr_number}")
            sys.exit(1)

        head_sha = result.get("head", {}).get("sha", "")
        base_sha = result.get("base", {}).get("sha", "")

        return PRMetadata(
            title=result.get("title", ""),
            base_branch=result.get("base", {}).get("ref", ""),
            head_sha=head_sha,
            base_sha=base_sha,
            start_sha=base_sha,  # GitHub: start_sha == base_sha
            url=result.get("html_url", ""),
            pr_number=pr_number,
            state=result.get("state", ""),
            raw=result,
        )

    def fetch_diff(self, pr_number: int) -> str:
        try:
            result = subprocess.run(
                ["gh", "pr", "diff", str(pr_number), "--repo", self.project_path],
                capture_output=True,
                text=True,
                check=True,
                timeout=120,
                cwd=self._cwd,
            )
            return result.stdout
        except FileNotFoundError:
            _print_stderr("Error: GitHub CLI (gh) not found.")
            sys.exit(1)
        except subprocess.TimeoutExpired:
            _print_stderr(f"Error: Timed out fetching PR diff for {self.project_path}#{pr_number}")
            sys.exit(1)
        except subprocess.CalledProcessError as e:
            _print_stderr(f"Error: Failed to fetch PR diff: {e.stderr}")
            sys.exit(1)

    def fetch_changed_files(self, pr_number: int) -> list[ChangedFile]:
        result = self._run_api(
            f"/repos/{self._owner}/{self._repo}/pulls/{pr_number}/files",
            paginate=True,
        )
        if result is None:
            _print_stderr(f"Error: Failed to fetch changed files for {self.project_path}#{pr_number}")
            sys.exit(1)

        return [
            ChangedFile(
                path=f["filename"],
                patch=f.get("patch", ""),
                status=f["status"],
                additions=f.get("additions", 0),
                deletions=f.get("deletions", 0),
            )
            for f in result
        ]

    def fetch_review_threads(self, pr_number: int, *, include_resolved: bool = False) -> list[ReviewThread]:
        """Fetch review threads using paginated GraphQL."""
        all_threads: list[dict[str, Any]] = []
        cursor: str | None = None
        has_next_page = True

        query_tmpl = """
            query($owner: String!, $repo: String!, $pr: Int!{cursor_param}) {{
                repository(owner: $owner, name: $repo) {{
                    pullRequest(number: $pr) {{
                        reviewThreads(first: 100{after_clause}) {{
                            pageInfo {{ hasNextPage endCursor }}
                            nodes {{
                                id
                                isResolved
                                comments(first: 100) {{
                                    nodes {{
                                        id
                                        databaseId
                                        author {{ login }}
                                        path
                                        line
                                        body
                                        createdAt
                                    }}
                                }}
                            }}
                        }}
                    }}
                }}
            }}
        """

        while has_next_page:
            if cursor is None:
                query = query_tmpl.format(cursor_param="", after_clause="")
                variables: dict[str, Any] = {"owner": self._owner, "repo": self._repo, "pr": pr_number}
            else:
                query = query_tmpl.format(cursor_param=", $cursor: String!", after_clause=", after: $cursor")
                variables = {"owner": self._owner, "repo": self._repo, "pr": pr_number, "cursor": cursor}

            raw = self._run_graphql(query, variables)
            if raw is None or raw.get("errors"):
                break

            try:
                threads_data = raw["data"]["repository"]["pullRequest"]["reviewThreads"]
                page_info = threads_data["pageInfo"]
                nodes = threads_data.get("nodes") or []
            except (KeyError, TypeError):
                break

            has_next_page = page_info.get("hasNextPage", False)
            cursor = page_info.get("endCursor")
            all_threads.extend(nodes)

        # Convert to platform-neutral ReviewThread
        result_threads: list[ReviewThread] = []
        for thread in all_threads:
            is_resolved = thread.get("isResolved", False)
            if is_resolved and not include_resolved:
                continue

            comments = thread.get("comments", {}).get("nodes") or []
            if not comments:
                continue

            first = comments[0]
            rest = comments[1:]

            result_threads.append(
                ReviewThread(
                    thread_id=thread.get("id", ""),
                    path=first.get("path", ""),
                    line=first.get("line"),
                    end_line=None,
                    body=first.get("body", ""),
                    author=(first.get("author") or {}).get("login", ""),
                    replies=[
                        {
                            "author": (c.get("author") or {}).get("login", ""),
                            "body": c.get("body", ""),
                            "created_at": c.get("createdAt"),
                        }
                        for c in rest
                    ],
                    is_resolved=is_resolved,
                    raw={
                        "node_id": first.get("id"),
                        "comment_id": first.get("databaseId"),
                        "created_at": first.get("createdAt"),
                    },
                )
            )

        return result_threads

    def fetch_issue_comments(self, pr_number: int) -> list[dict[str, Any]]:
        result = self._run_api(
            f"/repos/{self._owner}/{self._repo}/issues/{pr_number}/comments",
            paginate=True,
        )
        return result if result is not None else []

    def post_review_comment(self, pr_number: int, commit_sha: str, path: str, line: int, body: str) -> str:
        """Post an inline review comment as a single-comment review."""
        payload = {
            "commit_id": commit_sha,
            "body": "",
            "event": "COMMENT",
            "comments": [{"path": path, "line": line, "body": body, "side": "RIGHT"}],
        }
        result = self._run_api(
            f"/repos/{self._owner}/{self._repo}/pulls/{pr_number}/reviews",
            method="POST",
            input_data=json.dumps(payload),
        )
        if result is None:
            _print_stderr(f"Error: Failed to post review comment on {path}:{line}")
            return ""
        return str(result.get("id", ""))

    def reply_to_thread(self, pr_number: int, thread_id: str, body: str) -> None:
        """Reply to a review thread using GraphQL mutation."""
        _ = pr_number  # Required by Platform ABC; GraphQL mutation uses thread_id only
        max_len = 60000
        if len(body) > max_len:
            body = body[:max_len] + "\n...[truncated]"

        query = """
        mutation($threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
            comment { id }
          }
        }
        """
        success, result = self._run_graphql_mutation(query, {"threadId": thread_id, "body": body})
        if not success:
            _print_stderr(f"Error posting reply to thread {thread_id}: {result}")

    def resolve_thread(self, pr_number: int, thread_id: str) -> None:
        """Resolve a review thread using GraphQL mutation."""
        _ = pr_number  # Required by Platform ABC; GraphQL mutation uses thread_id only
        query = """
        mutation($threadId: ID!) {
          resolveReviewThread(input: {threadId: $threadId}) {
            thread { id isResolved }
          }
        }
        """
        success, result = self._run_graphql_mutation(query, {"threadId": thread_id})
        if not success:
            _print_stderr(f"Error resolving thread {thread_id}: {result}")

    def get_file_content(self, path: str, ref: str = "") -> str | None:
        endpoint = f"/repos/{self._owner}/{self._repo}/contents/{path}"
        if ref:
            endpoint += f"?ref={ref}"
        cmd = ["gh", "api", endpoint, "-H", "Accept: application/vnd.github.raw"]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=self._cwd)
            return proc.stdout if proc.returncode == 0 and proc.stdout else None
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return None

    def post_pr_comment(self, pr_number: int, body: str) -> str:
        """Post a general PR comment (issue comment)."""
        result = self._run_api(
            f"/repos/{self._owner}/{self._repo}/issues/{pr_number}/comments",
            method="POST",
            input_data=json.dumps({"body": body}),
        )
        if result is None:
            _print_stderr(f"Error: Failed to post PR comment on {self.project_path}#{pr_number}")
            return ""
        return str(result.get("id", ""))

    def get_pr_url(self, pr_number: int) -> str:
        return f"https://github.com/{self._owner}/{self._repo}/pull/{pr_number}"

    def get_pr_number_for_branch(self, branch: str) -> int | None:
        """Find PR number for a given branch using gh pr view."""
        try:
            result = subprocess.run(
                ["gh", "pr", "view", branch, "--repo", self.project_path, "--json", "number", "--jq", ".number"],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=self._cwd,
            )
            if result.returncode == 0 and result.stdout.strip():
                return int(result.stdout.strip())
        except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
            pass
        return None

    def post_review_batch(
        self,
        pr_number: int,
        commit_sha: str,
        comments: list[dict[str, Any]],
        review_body: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Post all comments as a single GitHub review (batch API call).

        Uses POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews which
        accepts multiple inline comments in one request.
        """
        payload = {
            "commit_id": commit_sha,
            "body": review_body,
            "event": "COMMENT",
            "comments": [{"path": c["path"], "line": c["line"], "body": c["body"], "side": "RIGHT"} for c in comments],
        }
        result = self._run_api(
            f"/repos/{self._owner}/{self._repo}/pulls/{pr_number}/reviews",
            method="POST",
            input_data=json.dumps(payload),
        )
        if result is not None:
            posted = [{"path": c["path"], "line": c["line"]} for c in comments]
            return posted, []
        else:
            failed = [{"path": c["path"], "line": c["line"]} for c in comments]
            return [], failed

    def lookup_thread_id_from_node_id(self, node_id: str) -> str | None:
        """Look up thread_id from a review comment node_id via GraphQL."""
        query = """
        query($nodeId: ID!) {
          node(id: $nodeId) {
            ... on PullRequestReviewComment {
              pullRequestReviewThread { id }
            }
          }
        }
        """
        result = self._run_graphql(query, {"nodeId": node_id})
        if result is None:
            return None
        try:
            return result["data"]["node"]["pullRequestReviewThread"]["id"]
        except (KeyError, TypeError):
            return None
