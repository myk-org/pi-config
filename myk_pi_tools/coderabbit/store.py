"""Store local CodeRabbit review sessions to SQLite."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    cycle INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    severity TEXT NOT NULL,
    file_name TEXT NOT NULL,
    codegen_instructions TEXT,
    action TEXT NOT NULL,
    skip_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_branch ON sessions(branch);
"""


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _get_project_root() -> Path:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            _log(f"Error: git rev-parse failed: {result.stderr.strip()}")
            sys.exit(1)
        return Path(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        _log(f"Error: {e}")
        sys.exit(1)


def _get_current_branch() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except (subprocess.SubprocessError, OSError):
        return "unknown"


def _get_current_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except (subprocess.SubprocessError, OSError):
        return "unknown"


def _get_db_path() -> Path:
    root = _get_project_root()
    db_path = root / ".pi" / "data" / "coderabbit-local.db"
    db_dir = db_path.parent
    if not db_dir.exists():
        db_dir.mkdir(parents=True, mode=0o700)
    return db_path


def _open_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def run_store(json_path: str) -> int:
    """Store a review cycle from JSON to SQLite.

    JSON format:
    {
        "cycle": 1,
        "findings": [
            {
                "severity": "major",
                "fileName": "foo.py",
                "codegenInstructions": "...",
                "action": "fixed",
                "skipReason": ""
            }
        ]
    }
    """
    path = Path(json_path).resolve()
    if not path.exists():
        print(f"Error: file not found: {json_path}")
        return 1

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Error: invalid JSON: {e}")
        return 1

    try:
        cycle = int(data.get("cycle", 1))
    except (ValueError, TypeError):
        print("Error: 'cycle' must be an integer")
        return 1
    if cycle < 1:
        print("Error: 'cycle' must be >= 1")
        return 1
    findings: list[dict[str, Any]] = data.get("findings", [])
    branch = _get_current_branch()
    commit_sha = _get_current_commit()

    db_path = _get_db_path()
    _log(f"Storing cycle {cycle} for branch '{branch}' ({len(findings)} findings) -> {db_path}")

    conn = _open_db(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO sessions (branch, commit_sha, cycle, created_at) VALUES (?, ?, ?, ?)",
            (branch, commit_sha, cycle, datetime.now(UTC).isoformat()),
        )
        session_id = cur.lastrowid
        for finding in findings:
            cur.execute(
                "INSERT INTO findings (session_id, severity, file_name, codegen_instructions, action, skip_reason) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    finding.get("severity", ""),
                    finding.get("fileName", ""),
                    finding.get("codegenInstructions", ""),
                    finding.get("action", "fixed"),
                    finding.get("skipReason", ""),
                ),
            )
        conn.commit()
        fixed = sum(1 for finding in findings if finding.get("action") == "fixed")
        skipped = sum(1 for finding in findings if finding.get("action") == "skipped")
        _log(f"Stored session id={session_id}: {fixed} fixed, {skipped} skipped")
    except sqlite3.Error as e:
        conn.rollback()
        print(f"Error: database error: {e}")
        return 1
    finally:
        conn.close()

    # Delete JSON file after successful storage
    try:
        path.unlink()
        _log(f"Deleted JSON file: {path}")
    except OSError as e:
        _log(f"Warning: Could not delete JSON file: {e}")

    return 0


def run_history(branch: str | None = None, limit: int = 20) -> int:
    """Show history of local CodeRabbit review sessions."""
    db_path = _get_db_path()
    if not db_path.exists():
        print("No history found.")
        return 0

    conn = _open_db(db_path)
    try:
        if branch:
            rows = conn.execute(
                "SELECT id, branch, commit_sha, cycle, created_at FROM sessions "
                "WHERE branch = ? ORDER BY id DESC LIMIT ?",
                (branch, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, branch, commit_sha, cycle, created_at FROM sessions ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()

        if not rows:
            print("No history found.")
            return 0

        for session_id, br, commit, cycle, created_at in rows:
            print(f"\n[{created_at}] branch={br} commit={commit[:7]} cycle={cycle}")
            findings = conn.execute(
                "SELECT severity, file_name, action, skip_reason FROM findings WHERE session_id = ?",
                (session_id,),
            ).fetchall()
            for severity, file_name, action, skip_reason in findings:
                skip = f" (reason: {skip_reason})" if skip_reason else ""
                print(f"  [{severity}] {file_name} -> {action}{skip}")
    finally:
        conn.close()

    return 0
