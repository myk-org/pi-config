"""Focused tests for lazy CLI imports, fast-paths, and compact JSON outputs (#1169, #1184)."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

import click
import pytest
from click.testing import CliRunner

from myk_pi_tools.cli import cli
from myk_pi_tools.reviews.status import extract_summary
from myk_pi_tools.settings.commands import ENV_BY_KEY

EXPECTED_COMMANDS = [
    "ai-cli",
    "coderabbit",
    "db",
    "memory",
    "pr",
    "release",
    "reviews",
    "settings",
]


def _assert_compact_json(raw_output: str) -> Any:
    """Verify output is valid single-line JSON formatted with separators=(',', ':')."""
    text = raw_output.strip()
    assert "\n" not in text
    assert ": " not in text
    assert ", " not in text
    parsed = json.loads(text)
    assert text == json.dumps(parsed, separators=(",", ":"))
    return parsed


def test_importing_cli_skips_heavy_optional_modules() -> None:
    code = (
        "import sys, myk_pi_tools.cli; "
        "heavy = ('bs4', 'commentjson', 'sqlite3', 'myk_pi_tools.db.query'); "
        "print(','.join(m for m in heavy if m in sys.modules))"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=True,
    )
    assert proc.stdout.strip() == ""


def test_cli_list_commands_returns_all_eight_commands() -> None:
    with click.Context(cli) as ctx:
        assert cli.list_commands(ctx) == EXPECTED_COMMANDS


def test_cli_help_exits_zero() -> None:
    result = CliRunner().invoke(cli, ["--help"])
    assert result.exit_code == 0, result.output


def test_cli_help_lists_all_commands() -> None:
    result = CliRunner().invoke(cli, ["--help"])
    for name in EXPECTED_COMMANDS:
        assert name in result.output


def test_db_lazy_getattr_exposes_review_db() -> None:
    from myk_pi_tools.db import ReviewDB
    from myk_pi_tools.db.query import ReviewDB as DirectReviewDB

    assert ReviewDB is DirectReviewDB


def test_db_lazy_getattr_rejects_unknown_attribute() -> None:
    import myk_pi_tools.db as db_pkg

    with pytest.raises(AttributeError):
        _ = db_pkg.NonExistentSymbol


def test_extract_summary_plain_text_does_not_import_bs4(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "bs4", None)
    assert extract_summary("plain **bold** text") == "plain bold text"


def test_extract_summary_html_strips_tags() -> None:
    assert extract_summary("<p>Hello</p>") == "Hello"


def test_settings_get_outputs_compact_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = tmp_path / "repo"
    home = tmp_path / "home"
    repo.mkdir()
    home.mkdir()
    monkeypatch.setattr("myk_pi_tools.settings.commands._resolve_repo_root", lambda _cwd=None: repo)
    monkeypatch.setattr(Path, "home", lambda: home)
    for env_name in ENV_BY_KEY.values():
        monkeypatch.delenv(env_name, raising=False)

    result = CliRunner().invoke(cli, ["settings", "get", "dco", "commit_trailer"])
    assert result.exit_code == 0, result.output
    parsed = _assert_compact_json(result.stdout)
    assert parsed == {"dco": False, "commit_trailer": False}


def test_db_stats_json_outputs_compact_json(tmp_path: Path) -> None:
    db_path = tmp_path / "reviews.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE comments (source TEXT, status TEXT, type TEXT, code_diff TEXT)")
    conn.executemany(
        "INSERT INTO comments (source, status, type, code_diff) VALUES (?, ?, ?, ?)",
        [
            ("qodo", "addressed", "qodo_bug", ""),
            ("human", "not_addressed", "inline", ""),
        ],
    )
    conn.commit()
    conn.close()

    result = CliRunner().invoke(cli, ["db", "stats", "--json", "--db-path", str(db_path)])
    assert result.exit_code == 0, result.output
    parsed = _assert_compact_json(result.stdout)
    assert [row["source"] for row in parsed] == ["human", "qodo"]


def test_release_detect_versions_outputs_compact_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "package.json").write_text(json.dumps({"name": "demo", "version": "1.2.3"}), encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "demo"\nversion = "1.2.3"\n', encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(cli, ["release", "detect-versions"])
    assert result.exit_code == 0, result.output
    parsed = _assert_compact_json(result.stdout)
    assert parsed["count"] == 2


def _invoke_ai_cli_save_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.chdir(tmp_path)
    return CliRunner().invoke(
        cli,
        ["ai-cli", "save-config", "--agents", "cursor", "--peers", "claude,gemini"],
    )


def test_ai_cli_save_config_outputs_compact_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    result = _invoke_ai_cli_save_config(tmp_path, monkeypatch)
    assert result.exit_code == 0, result.output
    parsed = _assert_compact_json(result.stdout)
    assert parsed == {"lastAgents": "cursor", "lastPeers": "claude,gemini"}


def test_ai_cli_save_config_writes_indented_json_to_disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    result = _invoke_ai_cli_save_config(tmp_path, monkeypatch)
    assert result.exit_code == 0, result.output
    on_disk = (tmp_path / ".pi" / "external-ai-config.json").read_text(encoding="utf-8")
    assert on_disk == json.dumps({"lastAgents": "cursor", "lastPeers": "claude,gemini"}, indent=2) + "\n"
