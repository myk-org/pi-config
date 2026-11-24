"""Unified GitHub CLI (``gh``) transport adapter for ``myk_pi_tools``.

Owns all ``gh`` CLI interactions in one deep module:
- CLI dependency checks (``check_dependencies``)
- Low-level ``gh`` execution (``run_gh``)
- REST API execution and paginated JSON merging (``run_gh_api``, ``merge_paginated_json``)
- Issue/PR comment posting (``post_issue_comment``)
- PR URL parsing and branch-based PR resolution (``parse_pr_url``, ``get_pr_info``)
- GraphQL execution with HTTP header splitting, partial-data preservation on
  nonzero exits, and sensitive preview redaction on parse failures
  (``run_graphql_raw``, ``run_graphql``, ``run_gh_graphql``)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import traceback
from collections.abc import Mapping, Sequence
from typing import Any

from myk_pi_tools.logger import create_logger

log = create_logger(__name__)

__all__ = [
    "check_dependencies",
    "get_pr_info",
    "merge_paginated_json",
    "parse_pr_url",
    "post_issue_comment",
    "redact_response_preview",
    "response_body_bytes",
    "run_gh",
    "run_gh_api",
    "run_gh_api_result",
    "run_gh_graphql",
    "run_graphql",
    "run_graphql_raw",
    "split_http_response",
]

_PR_URL_WITH_SCHEME_RE = re.compile(
    r"^https?://github\.com/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/pull/(\d+)(?:[/?#].*)?$"
)
_PR_URL_OPTIONAL_SCHEME_RE = re.compile(
    r"^(?:https?://)?github\.com/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/pull/(\d+)(?:[/?#].*)?$"
)

_HTTP_RESPONSE = re.compile(r"HTTP/\d(?:\.\d)?\s+(\d{3})\b[^\r\n]*(?:\r?\n.*)*?\r?\n\r?\n")
_HTTP_RESPONSE_BYTES = re.compile(rb"HTTP/\d(?:\.\d)?\s+\d{3}\b[^\r\n]*(?:\r?\n.*)*?\r?\n\r?\n")


def _print_stderr(msg: str) -> None:
    """Print diagnostic message to stderr."""
    print(msg, file=sys.stderr)


def check_dependencies(
    commands: Sequence[str] = ("gh",),
    *,
    error_message: str | None = None,
) -> None:
    """Verify required CLI tools are installed on PATH, exiting with code 1 if missing."""
    for cmd in commands:
        if shutil.which(cmd) is None:
            log.error("Required CLI dependency not found on PATH: %s", cmd)
            _print_stderr(error_message or f"Error: '{cmd}' is required but not installed.")
            sys.exit(1)


def parse_pr_url(url: str, *, require_scheme: bool = True) -> tuple[str, str, str] | None:
    """Parse a GitHub PR URL into ``(owner, repo, pr_number)`` or ``None``."""
    pattern = _PR_URL_WITH_SCHEME_RE if require_scheme else _PR_URL_OPTIONAL_SCHEME_RE
    match = pattern.match(url.strip())
    if match:
        return match.group(1), match.group(2), match.group(3)
    return None


def merge_paginated_json(text: str) -> list[Any]:
    """Merge concatenated JSON arrays from ``gh api --paginate`` output.

    ``gh --paginate`` returns concatenated JSON arrays like ``[...][...]``.
    Uses ``json.JSONDecoder.raw_decode`` to parse each array boundary
    correctly without corrupting bracket sequences inside string values.
    """
    merged: list[Any] = []
    decoder = json.JSONDecoder()
    idx = 0
    text = text.strip()
    while idx < len(text):
        obj, end = decoder.raw_decode(text, idx)
        if isinstance(obj, list):
            merged.extend(obj)
        else:
            merged.append(obj)
        idx = end
        while idx < len(text) and text[idx] in " \t\n\r":
            idx += 1
    return merged


def run_gh(
    args: Sequence[str],
    *,
    input: str | None = None,
    timeout: int = 60,
) -> tuple[int, str, str]:
    """Run a ``gh`` CLI command and return ``(returncode, stdout, stderr)``."""
    cmd = ["gh", *args]
    log.debug("Running gh CLI command: %s", cmd[1] if len(cmd) > 1 else "")
    try:
        result = subprocess.run(
            cmd,
            input=input,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
            timeout=timeout,
        )
        raw_stdout = getattr(result, "stdout", "")
        raw_stderr = getattr(result, "stderr", "")
        stdout = raw_stdout if isinstance(raw_stdout, str) else ""
        stderr = raw_stderr if isinstance(raw_stderr, str) else ""
        return result.returncode, stdout, stderr
    except FileNotFoundError:
        log.warning("gh CLI binary not found on PATH")
        return 1, "", "gh CLI not found. Install from https://cli.github.com/"
    except subprocess.TimeoutExpired:
        log.warning("gh CLI command timed out after %ds", timeout)
        return 1, "", f"Command timed out after {timeout}s"
    except subprocess.CalledProcessError as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        return exc.returncode, stdout, stderr
    except OSError as exc:
        log.warning("gh CLI execution failed: %s", exc)
        return 1, "", f"gh CLI execution failed: {exc}"


def run_gh_api_result(
    endpoint: str,
    *,
    paginate: bool = False,
    method: str | None = None,
    input_data: Any | None = None,
    jq: str | None = None,
    headers: Sequence[str] | None = None,
    timeout: int = 120,
) -> tuple[Any | None, str]:
    """Run a GitHub REST API call via ``gh api`` and return ``(parsed_json, error_msg)``."""
    args: list[str] = ["api"]
    if method:
        args.extend(["--method", method])
    if paginate:
        args.append("--paginate")
    if headers:
        for header in headers:
            args.extend(["-H", header])
    if jq:
        args.extend(["--jq", jq])
    args.append(endpoint)

    stdin_payload: str | None = None
    if input_data is not None:
        args.extend(["--input", "-"])
        stdin_payload = input_data if isinstance(input_data, str) else json.dumps(input_data)

    code, stdout, stderr = run_gh(args, input=stdin_payload, timeout=timeout)
    if code != 0:
        err_clean = stderr.strip()
        return None, err_clean or f"gh api exited with code {code}"

    try:
        if paginate:
            return merge_paginated_json(stdout), ""
        return json.loads(stdout), ""
    except json.JSONDecodeError as exc:
        return None, f"JSON parse error: {exc}"


def run_gh_api(
    endpoint: str,
    *,
    paginate: bool = False,
    method: str | None = None,
    input_data: Any | None = None,
    jq: str | None = None,
    headers: Sequence[str] | None = None,
    timeout: int = 120,
    quiet: bool = False,
) -> Any | None:
    """Run a GitHub REST API call via ``gh api`` and return parsed JSON or ``None`` on error."""
    data, error = run_gh_api_result(
        endpoint,
        paginate=paginate,
        method=method,
        input_data=input_data,
        jq=jq,
        headers=headers,
        timeout=timeout,
    )
    if error:
        if error.startswith("JSON parse error:"):
            if not quiet:
                _print_stderr(f"Error parsing JSON from gh api: {error.removeprefix('JSON parse error: ')}")
            if quiet:
                log.debug("Failed to parse JSON from gh api %s: %s", endpoint, error)
            else:
                log.warning("Failed to parse JSON from gh api %s: %s", endpoint, error)
        elif "timed out" in error.lower():
            if not quiet:
                _print_stderr(f"Error: API call to {endpoint} timed out after {timeout} seconds")
            log.warning("GitHub API call to %s timed out after %ds", endpoint, timeout)
        else:
            if not quiet:
                _print_stderr(f"Warning: API call to {endpoint} failed: {error}")
            if quiet:
                log.debug("GitHub API call to %s failed: %s", endpoint, error)
            else:
                log.warning("GitHub API call to %s failed: %s", endpoint, error)
        return None

    return data


def post_issue_comment(
    owner: str,
    repo: str,
    pr_number: str | int,
    body: str,
    *,
    timeout: int = 30,
) -> tuple[bool, str, str]:
    """Post an issue/PR comment via ``gh api``.

    Returns ``(ok, stdout, error_message)``.
    """
    code, stdout, stderr = run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "-X",
            "POST",
            "-f",
            f"body={body}",
        ],
        timeout=timeout,
    )
    if code == 0:
        return True, stdout if isinstance(stdout, str) else "", ""
    err_text = stderr.strip() if isinstance(stderr, str) else ""
    if not err_text:
        err_text = f"rc={code}"
    log.warning("Failed to post issue comment on %s/%s#%s: %s", owner, repo, pr_number, err_text)
    return False, "", err_text


def _get_upstream_repo() -> str | None:
    """Get upstream remote's ``owner/repo`` if configured, or ``None``."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "upstream"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None

        url = result.stdout.strip()
        for pattern in (
            r"git@github\.com:([^/]+/[^/]+?)(?:\.git)?$",
            r"ssh://git@github\.com/([^/]+/[^/]+?)(?:\.git)?$",
            r"https?://github\.com/([^/]+/[^/]+?)(?:\.git)?$",
        ):
            match = re.match(pattern, url)
            if match:
                return match.group(1)
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def get_pr_info(pr_url: str = "") -> tuple[str, str, str]:
    """Resolve ``(owner, repo, pr_number)`` from a PR URL or current git branch.

    Args:
        pr_url: Optional PR URL. If valid, owner/repo/number are extracted directly.

    Returns:
        Tuple of ``(owner, repo, pr_number)``.
    """
    if pr_url:
        parsed = parse_pr_url(pr_url)
        if parsed:
            return parsed
        _print_stderr(f"Warning: '{pr_url}' did not match a GitHub PR URL pattern, falling back to branch detection")

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            _print_stderr("Error: Could not get current branch")
            sys.exit(1)
        current_branch = result.stdout.strip()
        if current_branch == "HEAD":
            _print_stderr("Error: Detached HEAD; cannot infer PR from branch. Check out a branch with an open PR.")
            sys.exit(1)
    except (subprocess.TimeoutExpired, OSError):
        _print_stderr("Error: git command timed out")
        sys.exit(1)

    repos_to_try: list[str | None] = [None]
    upstream_repo = _get_upstream_repo()
    if upstream_repo:
        repos_to_try.append(upstream_repo)

    pr_number: str | None = None
    matched_repo: str | None = None

    for target_repo in repos_to_try:
        args = ["pr", "view", current_branch, "--json", "number", "--jq", ".number"]
        if target_repo:
            args.extend(["-R", target_repo])

        code, stdout, _stderr = run_gh(args, timeout=30)
        if code == 0 and stdout.strip():
            pr_number = stdout.strip()
            matched_repo = target_repo
            if target_repo:
                _print_stderr(f"Found PR #{pr_number} on upstream ({target_repo})")
            break

    if pr_number is None:
        tried = "origin"
        if upstream_repo:
            tried += f" and upstream ({upstream_repo})"
        _print_stderr(f"Error: No PR found for branch '{current_branch}' on {tried}")
        sys.exit(1)

    if matched_repo:
        parts = matched_repo.split("/")
        if len(parts) == 2:
            return parts[0], parts[1], pr_number
        _print_stderr(f"Error: Unexpected repo format from upstream: '{matched_repo}'")
        sys.exit(1)

    code, stdout, stderr = run_gh(
        ["repo", "view", "--json", "owner,name", "-q", '.owner.login + "/" + .name'],
        timeout=30,
    )
    if code != 0 or not stdout.strip():
        if "timed out" in stderr.lower():
            _print_stderr("Error: gh repo view timed out")
        else:
            _print_stderr("Error: Could not get repository information")
        sys.exit(1)

    repo_full_name = stdout.strip()
    owner_repo = repo_full_name.split("/")
    if len(owner_repo) != 2:
        _print_stderr(f"Error: Could not parse owner/repo from: '{repo_full_name}'")
        sys.exit(1)

    return owner_repo[0], owner_repo[1], pr_number


def split_http_response(stdout: str) -> tuple[dict[str, str], str, str]:
    """Return leading final HTTP response headers, body, and status from ``gh api --include`` output."""
    offset = 0
    response = _HTTP_RESPONSE.match(stdout)
    if not response:
        log.debug("No HTTP response headers found", extra={"output_chars": len(stdout)})
        return {}, stdout, "unknown"
    while response:
        offset += response.end()
        next_response = _HTTP_RESPONSE.match(stdout[offset:])
        if not next_response:
            break
        response = next_response
    headers = {
        key.lower(): value.strip()
        for line in response.group().splitlines()[1:]
        if ":" in line
        for key, value in [line.split(":", 1)]
    }
    body = stdout[offset:]
    log.debug(
        "Parsed HTTP response headers",
        extra={"status": response.group(1), "header_count": len(headers), "body_chars": len(body)},
    )
    return headers, body, response.group(1)


def response_body_bytes(stdout: bytes) -> bytes:
    """Return the body following contiguous leading ``gh api --include`` response blocks."""
    offset = 0
    response = _HTTP_RESPONSE_BYTES.match(stdout)
    while response:
        offset += response.end()
        response = _HTTP_RESPONSE_BYTES.match(stdout[offset:])
    body = stdout[offset:]
    log.debug("Extracted HTTP response body bytes", extra={"body_bytes": len(body)})
    return body


def redact_response_preview(body: str, secrets: Sequence[str]) -> str:
    """Bound and redact a response preview without retaining request content."""
    preview = body
    candidates: list[str] = []
    for secret in secrets:
        if not secret:
            continue
        candidates.append(secret)
        # Signed bodies append a footer after "\n\n---\n"; also redact the unsigned text
        # and substantial individual lines in case an upstream proxy reflects an excerpt.
        if "\n" in secret:
            unsigned = secret.split("\n\n---\n", 1)[0].strip()
            if unsigned and unsigned != secret:
                candidates.append(unsigned)
            for line in secret.splitlines():
                stripped = line.strip()
                if len(stripped) >= 8 and stripped not in candidates:
                    candidates.append(stripped)

    # Replace longest candidates first so substrings don't break longer matches.
    for candidate in sorted(candidates, key=len, reverse=True):
        preview = preview.replace(candidate, "[REDACTED]").replace(json.dumps(candidate)[1:-1], "[REDACTED]")
    preview = re.sub(
        r'(?i)((?:["\']?(?:authorization|(?:access[_-]?)?token|(?:api[_-]?)?key|'
        r'(?:client[_-]?)?secret|password|body|reply)["\']?(?:\s*[=:]\s*|\s+value\s*=\s*)))'
        r'(?:"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[^\s,}>]+)',
        r"\1[REDACTED]",
        preview,
    )
    preview = preview[:1_000]
    log.debug(
        "Redacted HTTP response preview",
        extra={"body_chars": len(body), "secret_count": len(secrets), "preview_chars": len(preview)},
    )
    return preview


def _graphql_parse_error(
    stdout: str,
    response_bytes: int,
    error: json.JSONDecodeError,
    variables: Mapping[str, Any],
) -> str:
    """Format safe diagnostics for a retryable successful HTTP response parse failure."""
    headers, body, status = split_http_response(stdout)
    request_id = next(
        (
            headers[key]
            for key in ("x-github-request-id", "x-request-id", "x-correlation-id", "request-id")
            if key in headers
        ),
        "unavailable",
    )
    secrets = [v for v in variables.values() if isinstance(v, str)]
    preview = redact_response_preview(body, secrets)
    diagnostic = (
        "Retryable GraphQL response parse failure: endpoint=graphql method=POST "
        f"status={status} content_type={headers.get('content-type', 'unknown')} "
        f"response_bytes={response_bytes} request_id={request_id}; "
        f"body_preview={preview!r}; parser_error={error}; "
        f"parser_stack={traceback.format_exc().strip()}"
    )
    log.warning("%s", diagnostic)
    return diagnostic


def run_graphql_raw(
    query: str,
    variables: Mapping[str, Any],
    *,
    timeout: int = 120,
) -> tuple[bool, dict[str, Any] | None, str]:
    """Run a GraphQL query via ``gh api graphql --include --input -``.

    Returns ``(transport_ok, parsed_json, error_msg)``.

    Preserves partial ``data`` when ``gh`` exits nonzero due to GraphQL-level
    errors (e.g. a combined mutation where reply succeeded and resolve failed),
    and returns bounded, redacted diagnostics on parse failures.
    """
    payload = {"query": query, "variables": dict(variables)}
    cmd = ["gh", "api", "graphql", "--include", "--input", "-"]
    log.debug("Running GraphQL request", extra={"variable_count": len(variables)})

    try:
        result = subprocess.run(
            cmd,
            input=json.dumps(payload).encode(),
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        log.error("gh CLI binary not found for GraphQL request")
        return False, None, "gh CLI not found. Install from https://cli.github.com/"
    except subprocess.TimeoutExpired:
        log.warning("GraphQL query timed out after %ds", timeout)
        return False, None, f"GraphQL query timed out after {timeout} seconds"
    except OSError as exc:
        log.error("GraphQL subprocess failed: %s", exc)
        return False, None, f"GraphQL query failed: {exc}"

    # Preserve raw bytes for exact response-length diagnostics; decode only for parsing/display.
    stdout_bytes = getattr(result, "stdout", b"") or b""
    stderr_bytes = getattr(result, "stderr", b"") or b""
    if isinstance(stdout_bytes, str):  # Compatibility for test doubles.
        stdout_bytes = stdout_bytes.encode()
    elif not isinstance(stdout_bytes, bytes):
        stdout_bytes = b""
    if isinstance(stderr_bytes, str):
        stderr_bytes = stderr_bytes.encode()
    elif not isinstance(stderr_bytes, bytes):
        stderr_bytes = b""

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    _, body, _ = split_http_response(stdout)
    secrets = [v for v in variables.values() if isinstance(v, str)]
    safe_body = redact_response_preview(body, secrets).strip()
    safe_stderr = redact_response_preview(stderr, secrets).strip()
    error_output = "\n".join(part for part in (safe_body, safe_stderr) if part)

    if result.returncode != 0:
        # `gh api graphql` exits nonzero on GraphQL errors even when partial `data`
        # is present in stdout (e.g. reply succeeded, resolve failed). Preserve the
        # JSON payload when usable `data` exists so callers can inspect mutations.
        try:
            partial = json.loads(body)
        except json.JSONDecodeError:
            partial = None
        if isinstance(partial, dict) and isinstance(partial.get("data"), dict):
            log.warning(
                "GraphQL request exited nonzero with partial data",
                extra={"returncode": result.returncode, "response_bytes": len(stdout_bytes)},
            )
            return True, partial, error_output
        log.error(
            "GraphQL request failed",
            extra={
                "returncode": result.returncode,
                "response_bytes": len(stdout_bytes),
                "stderr_bytes": len(stderr_bytes),
            },
        )
        return False, None, error_output

    log.debug(
        "GraphQL request completed",
        extra={"returncode": result.returncode, "response_bytes": len(stdout_bytes), "stderr_bytes": len(stderr_bytes)},
    )

    # Validate JSON response - parse the body only, not --include headers.
    try:
        data = json.loads(body)
    except json.JSONDecodeError as error:
        return False, None, _graphql_parse_error(stdout, len(response_body_bytes(stdout_bytes)), error, variables)

    if not isinstance(data, dict):
        log.warning("Unexpected non-object GraphQL JSON response type: %s", type(data).__name__)
        return False, None, f"Unexpected GraphQL JSON response type: {type(data).__name__}"

    return True, data, ""


def run_graphql(
    query: str,
    variables: Mapping[str, Any],
    *,
    timeout: int = 120,
) -> tuple[bool, dict[str, Any] | str]:
    """Run a GraphQL query via ``gh api graphql``.

    Returns ``(success, result)`` where ``result`` is parsed JSON on success or
    an error string on failure (including GraphQL-level ``errors``).
    """
    ok, data, error_msg = run_graphql_raw(query, variables, timeout=timeout)
    if not ok or data is None:
        return False, error_msg

    errors = data.get("errors")
    if isinstance(errors, list) and len(errors) > 0:
        first = errors[0]
        error_msg = first.get("message", "Unknown error") if isinstance(first, dict) else str(first)
        return False, error_msg

    log.debug("GraphQL response parsed", extra={"has_errors": False})
    return True, data


def run_gh_graphql(
    query: str,
    variables: Mapping[str, Any],
    *,
    timeout: int = 120,
) -> dict[str, Any] | None:
    """Run a GraphQL query via ``gh api graphql`` and return parsed JSON or ``None``.

    Preserves GraphQL-level ``errors`` in the returned dict (matching callers
    that inspect page-level errors themselves) while logging transport/parse
    failures to stderr.
    """
    ok, data, error_msg = run_graphql_raw(query, variables, timeout=timeout)
    if not ok or data is None:
        if "timed out" in error_msg.lower():
            _print_stderr(f"Error: {error_msg}")
        elif error_msg:
            _print_stderr(f"Warning: GraphQL query failed: {error_msg}")
        return None
    return data
