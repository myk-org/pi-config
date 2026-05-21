"""CodeRabbit CLI local review wrapper with rate limit handling.

Runs `cr review --agent [args]`, parses NDJSON output,
handles rate_limit errors by waiting and retrying automatically.

stdout: ONLY findings (NDJSON) or {"coderabbit":"approved"} or {"type":"error",...}
stderr: all logs for monitoring
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

_WAIT_TIME_RE = re.compile(
    r"(\d+)\s*(second|minute|hour)s?",
    re.IGNORECASE,
)


def _log(msg: str) -> None:
    """Print to stderr for monitoring."""
    print(msg, file=sys.stderr, flush=True)


def _out(data: dict) -> None:
    """Print to stdout — what the main AI reads."""
    print(json.dumps(data), flush=True)


def _parse_wait_seconds(wait_time_str: str) -> int:
    """Parse waitTime string like '19 seconds', '2 minutes', '1 hour' into seconds."""
    total = 0
    for match in _WAIT_TIME_RE.finditer(wait_time_str):
        value = int(match.group(1))
        unit = match.group(2).lower()
        if unit == "second":
            total += value
        elif unit == "minute":
            total += value * 60
        elif unit == "hour":
            total += value * 3600
    return total if total > 0 else 60  # fallback 60s


def run_review(extra_args: list[str]) -> int:
    """Run cr review --agent with rate limit handling.

    Args:
        extra_args: Extra flags to pass to cr review (e.g. ['--base', 'main'])

    Returns:
        Exit code (0 = success, 1 = error)
    """
    config_args: list[str] = []
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        repo_root = Path(result.stdout.strip())
        config_path = repo_root / ".coderabbit.yaml"
        if config_path.is_file():
            config_args = ["-c", str(config_path)]
            _log(f"[cr-review] using config: {config_path}")
    except (subprocess.CalledProcessError, OSError):
        pass

    cmd = ["cr", "review", "--agent"] + config_args + extra_args
    attempt = 0

    while True:
        attempt += 1
        findings: list[dict] = []  # each entry is finding dict without 'type' key
        rate_limited = False
        wait_seconds = 60

        _log(f"[cr-review] attempt {attempt}: {' '.join(cmd)}")

        try:
            with subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ) as proc:
                if proc.stdout is None:
                    _log("[cr-review] ERROR: failed to capture cr stdout")
                    _out({"type": "error", "message": "Failed to capture cr stdout"})
                    return 1

                stderr_lines: list[str] = []

                def _drain_stderr(lines: list[str] = stderr_lines) -> None:
                    if proc.stderr:
                        for line in proc.stderr:
                            lines.append(line.rstrip("\n"))

                stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
                stderr_thread.start()

                for raw_line in proc.stdout:
                    line = raw_line.rstrip("\n")
                    if not line:
                        continue

                    _log(f"[cr-review] {line}")  # log every line from cr

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    event_type = event.get("type", "")

                    if event_type == "finding":
                        finding = {k: v for k, v in event.items() if k != "type"}
                        findings.append(finding)

                    elif event_type == "error":
                        if event.get("errorType") == "rate_limit":
                            rate_limited = True
                            metadata = event.get("metadata", {})
                            wait_str = metadata.get("waitTime", "60 seconds")
                            wait_seconds = _parse_wait_seconds(wait_str) + 30  # +30s buffer
                            policy = metadata.get("policyGuidance", "")
                            _log(f"[cr-review] rate limited — waiting {wait_seconds}s. {policy}")
                        else:
                            _log(f"[cr-review] ERROR: {event.get('message', 'unknown error')}")
                            _out({"type": "error", "message": event.get("message", "Unknown error")})
                            proc.kill()
                            return 1

                proc.wait()

                stderr_thread.join(timeout=5)
                if stderr_lines:
                    for line in stderr_lines:
                        _log(f"[cr-review] stderr: {line}")

                rc = proc.returncode
                _log(f"[cr-review] cr exited rc={rc}")

                if rate_limited:
                    _log(f"[cr-review] sleeping {wait_seconds}s before retry...")
                    time.sleep(wait_seconds)
                    _log("[cr-review] retrying now...")
                    continue

                if rc != 0 and not findings:
                    _log(f"[cr-review] cr failed with exit code {rc}")
                    _out({"type": "error", "message": f"cr exited with code {rc}"})
                    return rc

                # Output to stdout — what the main AI reads
                if findings:
                    _log(f"[cr-review] {len(findings)} finding(s)")
                    _out({"findings": findings})
                else:
                    _log("[cr-review] approved — no findings")
                    _out({"coderabbit": "approved"})

                return rc
        except OSError as e:
            _log(f"[cr-review] ERROR: Failed to start cr: {e}")
            _out({"type": "error", "errorType": "cli_not_found", "message": f"Failed to start cr: {e}"})
            return 1
