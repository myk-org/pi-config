"""Tests for myk_pi_tools.settings.commands."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from myk_pi_tools.settings.commands import (
    ENV_BY_KEY,
    SETTINGS_KEYS,
    _parse_review_loop_max_cycles,
    get_setting,
    get_settings,
    parse_agent_name_list,
)

_KEYS_FILE = Path(__file__).resolve().parent.parent.parent / "settings-keys.json"


@pytest.fixture
def _isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate settings resolution from real project/global files and env."""
    repo = tmp_path / "repo"
    home = tmp_path / "home"
    repo.mkdir()
    home.mkdir()
    monkeypatch.setattr(
        "myk_pi_tools.settings.commands._resolve_repo_root",
        lambda _cwd=None: repo,
    )
    monkeypatch.setattr(Path, "home", lambda: home)
    for env_name in ENV_BY_KEY.values():
        monkeypatch.delenv(env_name, raising=False)
    return repo


def test_get_settings_all_keys_return_values(_isolated_settings: Path) -> None:
    result = get_settings(())
    assert set(result.keys()) == set(SETTINGS_KEYS.keys())
    assert all(v is not None for v in result.values())


def test_get_settings_specific_keys(_isolated_settings: Path) -> None:
    result = get_settings(("dco", "commit_trailer"))
    assert result == {"dco": False, "commit_trailer": False}


def test_get_settings_unknown_key_raises(_isolated_settings: Path) -> None:
    with pytest.raises(ValueError, match="Unknown settings key"):
        get_settings(("nonexistent",))


def test_get_settings_defaults_match_keys_file(_isolated_settings: Path) -> None:
    expected = json.loads(_KEYS_FILE.read_text(encoding="utf-8"))
    result = get_settings(())
    for key, meta in expected.items():
        assert result[key] == meta["default"], f"default mismatch for {key}"


def test_get_setting_unknown_key_raises(_isolated_settings: Path) -> None:
    with pytest.raises(ValueError, match="Unknown settings key"):
        get_setting("nonexistent")


@pytest.mark.parametrize(
    "raw",
    ["01", "1e1", "10.0", "0", "11"],
)
def test_parse_review_loop_max_cycles_rejects(raw: str) -> None:
    assert _parse_review_loop_max_cycles(raw) is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (1, 1),
        (3, 3),
        (10, 10),
        ("1", 1),
        ("10", 10),
    ],
)
def test_parse_review_loop_max_cycles_accepts(raw: int | str, expected: int) -> None:
    assert _parse_review_loop_max_cycles(raw) == expected


def test_parse_agent_name_list_comma_separated() -> None:
    assert parse_agent_name_list("Git-Expert, Scout, ts-expert") == [
        "git-expert",
        "scout",
        "ts-expert",
    ]


def test_parse_agent_name_list_deduplicates() -> None:
    assert parse_agent_name_list("scout, Scout, scout") == ["scout"]


def test_parse_agent_name_list_filters_invalid() -> None:
    assert parse_agent_name_list("scout, Bad Name!, ok_agent, @bad") == [
        "scout",
        "ok_agent",
    ]


def test_parse_agent_name_list_from_list() -> None:
    assert parse_agent_name_list(["Scout", "git-expert", "Scout"]) == [
        "scout",
        "git-expert",
    ]


def test_parse_agent_name_list_none() -> None:
    assert parse_agent_name_list(None) == []


def test_jsonc_settings_file_parses_correctly(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / "pi-config-settings.jsonc").write_text(
        """{
  // project comment
  "image_model": "https://example.com/model", // trailing
  "coms_max_hops": 7
}
""",
        encoding="utf-8",
    )
    assert get_setting("image_model", cwd=_isolated_settings) == "https://example.com/model"
    assert get_setting("coms_max_hops", cwd=_isolated_settings) == 7


def test_find_settings_file_prefers_jsonc_over_json(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / "pi-config-settings.jsonc").write_text(
        json.dumps({"image_model": "from-jsonc"}),
        encoding="utf-8",
    )
    (pi_dir / "pi-config-settings.json").write_text(
        json.dumps({"image_model": "from-json"}),
        encoding="utf-8",
    )
    assert get_setting("image_model", cwd=_isolated_settings) == "from-jsonc"


def test_int_env_strict_parsing_rejects_malformed(
    _isolated_settings: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PI_COMS_MAX_HOPS", "10abc")
    assert get_setting("coms_max_hops", cwd=_isolated_settings) == 5


def test_int_env_accepts_valid_integer(
    _isolated_settings: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PI_COMS_MAX_HOPS", "15")
    assert get_setting("coms_max_hops", cwd=_isolated_settings) == 15


def test_port_0_accepted(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / "pi-config-settings.json").write_text(
        json.dumps({"coms_net_port": 0}),
        encoding="utf-8",
    )
    assert get_setting("coms_net_port", cwd=_isolated_settings) == 0


def test_empty_string_stored_for_string_settings(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / "pi-config-settings.json").write_text(
        json.dumps({"enforcement_allowed_commands": ""}),
        encoding="utf-8",
    )
    assert get_setting("enforcement_allowed_commands", cwd=_isolated_settings) == ""


def test_pidash_port_0_falls_through_to_default(_isolated_settings: Path) -> None:
    """pidash_port has min=1; stored 0 is invalid → default 19190."""
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / "pi-config-settings.json").write_text(
        json.dumps({"pidash_port": 0}),
        encoding="utf-8",
    )
    assert get_setting("pidash_port", cwd=_isolated_settings) == 19190
