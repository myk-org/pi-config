"""
Version detection across package managers.

The uv-workspace case exists because it is a real release bug this repo hit:
`pi-docsite` is a uv workspace member and not an npm one, so its
pyproject.toml was invisible to detection, and a release would have published
a wheel whose metadata said 4.6.5 while everything else said 4.7.0, with no
error anywhere. These tests fail if that scan is ever removed or narrowed.
"""

import json
from pathlib import Path

import pytest

from myk_pi_tools.release.detect_versions import _find_uv_workspace_members, detect_version_files


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _pyproject_with_uv_workspace(members: str) -> str:
    return f"""[project]
name = "root"
version = "1.0.0"

[tool.uv.workspace]
members = [{members}]
"""


def test_finds_uv_workspace_member_manifest(tmp_path: Path) -> None:
    """The regression: a uv-only member must be detected."""
    _write(tmp_path / "pyproject.toml", _pyproject_with_uv_workspace('"packages/tool"'))
    _write(
        tmp_path / "packages" / "tool" / "pyproject.toml",
        '[project]\nname = "tool"\nversion = "2.3.4"\n',
    )

    found = {vf.path: vf.current_version for vf in detect_version_files(tmp_path)}

    assert found.get("packages/tool/pyproject.toml") == "2.3.4"


def test_uv_workspace_member_glob(tmp_path: Path) -> None:
    """Members may be globs, not just literal paths."""
    _write(tmp_path / "pyproject.toml", _pyproject_with_uv_workspace('"packages/*"'))
    for name in ("alpha", "beta"):
        _write(tmp_path / "packages" / name / "pyproject.toml", f'[project]\nname = "{name}"\nversion = "1.1.1"\n')

    found = {vf.path: vf.current_version for vf in detect_version_files(tmp_path)}

    assert found.get("packages/alpha/pyproject.toml") == "1.1.1"
    assert found.get("packages/beta/pyproject.toml") == "1.1.1"


def test_member_in_both_workspaces_is_reported_once(tmp_path: Path) -> None:
    """A package in both workspaces is listed once, not twice."""
    _write(tmp_path / "pyproject.toml", _pyproject_with_uv_workspace('"packages/dual"'))
    _write(tmp_path / "package.json", json.dumps({"workspaces": ["packages/*"]}))
    _write(tmp_path / "packages" / "dual" / "pyproject.toml", '[project]\nname = "dual"\nversion = "3.0.0"\n')
    _write(tmp_path / "packages" / "dual" / "package.json", json.dumps({"name": "dual", "version": "3.0.0"}))

    paths = [vf.path for vf in detect_version_files(tmp_path)]

    assert paths.count("packages/dual/pyproject.toml") == 1


def test_no_uv_workspace_section_is_not_an_error(tmp_path: Path) -> None:
    _write(tmp_path / "pyproject.toml", '[project]\nname = "root"\nversion = "1.0.0"\n')

    assert _find_uv_workspace_members(tmp_path) == []


def test_unparseable_root_manifest_does_not_raise(tmp_path: Path) -> None:
    """A malformed pyproject must not abort detection for the other scans."""
    _write(tmp_path / "pyproject.toml", "this is not [ valid toml")
    _write(tmp_path / "package.json", json.dumps({"name": "root", "version": "1.0.0"}))

    found = {vf.path for vf in detect_version_files(tmp_path)}

    assert "package.json" in found


def test_member_without_a_version_is_skipped(tmp_path: Path) -> None:
    """A member with a dynamic version has nothing to bump; it must not appear."""
    _write(tmp_path / "pyproject.toml", _pyproject_with_uv_workspace('"packages/dyn"'))
    _write(
        tmp_path / "packages" / "dyn" / "pyproject.toml",
        '[project]\nname = "dyn"\ndynamic = ["version"]\n',
    )

    found = {vf.path for vf in detect_version_files(tmp_path)}

    assert "packages/dyn/pyproject.toml" not in found


def test_missing_root_pyproject_yields_no_members(tmp_path: Path) -> None:
    assert _find_uv_workspace_members(tmp_path) == []


def test_non_string_entry_in_a_valid_list_is_ignored(tmp_path: Path) -> None:
    """The per-entry type check, which the invalid-whole-field cases never hit."""
    # Written directly: the helper wraps its argument in a list, which would
    # nest this into members = [[42, "packages/ok"]] and skip the whole entry.
    _write(
        tmp_path / "pyproject.toml",
        '[project]\nname = "r"\nversion = "1.0.0"\n\n[tool.uv.workspace]\nmembers = [42, "packages/ok"]\n',
    )
    _write(tmp_path / "packages" / "ok" / "pyproject.toml", '[project]\nname = "ok"\nversion = "5.0.0"\n')

    members = _find_uv_workspace_members(tmp_path)
    found = {vf.path for vf in detect_version_files(tmp_path)}

    # The string member still resolves; the integer one is skipped, not fatal.
    assert [m.name for m in members] == ["ok"]
    assert "packages/ok/pyproject.toml" in found


def test_scalar_tool_table_does_not_abort_detection(tmp_path: Path) -> None:
    """`tool = "value"` parses fine; chained .get() would raise AttributeError."""
    # `tool` must come BEFORE any table header: after [project] it would belong
    # to that table and the root `tool` would still be a table, so the test would
    # pass without ever reaching the code path it claims to test.
    _write(tmp_path / "pyproject.toml", 'tool = "value"\n\n[project]\nname = "r"\nversion = "1.0.0"\n')
    _write(tmp_path / "package.json", json.dumps({"name": "root", "version": "1.0.0"}))

    found = {vf.path for vf in detect_version_files(tmp_path)}

    assert "package.json" in found, "the other scans must still run"


@pytest.mark.parametrize("members", ["'not-a-list'", "42", "[]"])
def test_malformed_members_field_is_ignored(tmp_path: Path, members: str) -> None:
    _write(tmp_path / "pyproject.toml", f"[project]\nname='r'\n[tool.uv.workspace]\nmembers = {members}\n")

    assert _find_uv_workspace_members(tmp_path) == []
