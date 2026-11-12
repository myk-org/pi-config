"""Tests for myk_pi_tools.settings.commands."""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path

import pytest

from myk_pi_tools.settings import commands as settings_commands
from myk_pi_tools.settings.commands import (
    ENV_BY_KEY,
    LEGACY_MIGRATED_SUFFIX,
    LEGACY_SETTINGS_FILENAME,
    SETTINGS_FILENAMES,
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


def test_settings_file_with_comments_still_parses(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / "pi-config-settings.json").write_text(
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


def test_legacy_jsonc_settings_file_is_ignored(_isolated_settings: Path) -> None:
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
    assert get_setting("image_model", cwd=_isolated_settings) == "from-json"


def _git_track(repo: Path, *paths: Path) -> None:
    """Create a git repo at `repo` that tracks `paths` (already on disk)."""
    subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
    # -f: a developer's global gitignore commonly ignores `.pi`.
    subprocess.run(
        ["git", "-C", str(repo), "add", "-f", "--", *(str(p) for p in paths)],
        check=True,
        capture_output=True,
    )


def _migrated_path(pi_dir: Path) -> Path:
    return pi_dir / (LEGACY_SETTINGS_FILENAME + LEGACY_MIGRATED_SUFFIX)


def test_legacy_jsonc_migrates_to_json(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    content = '{\n  // legacy comment\n  "image_model": "from-jsonc", /* inline */\n  "coms_max_hops": 7\n}\n'
    legacy.write_text(content, encoding="utf-8")

    assert get_setting("image_model", cwd=_isolated_settings) == "from-jsonc"

    target = pi_dir / SETTINGS_FILENAMES[0]
    assert not legacy.exists()
    assert _migrated_path(pi_dir).exists()
    assert json.loads(target.read_text(encoding="utf-8")) == {
        "image_model": "from-jsonc",
        "coms_max_hops": 7,
    }


def test_migrated_file_is_resolved_afterwards(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / LEGACY_SETTINGS_FILENAME).write_text(json.dumps({"image_model": "from-jsonc"}), encoding="utf-8")

    assert get_setting("image_model", cwd=_isolated_settings) == "from-jsonc"
    # Second read resolves the migrated `.json` (the legacy file is gone).
    assert get_setting("image_model", cwd=_isolated_settings) == "from-jsonc"
    assert not (pi_dir / LEGACY_SETTINGS_FILENAME).exists()


def test_existing_json_wins_and_legacy_is_untouched(
    _isolated_settings: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "from-jsonc"}), encoding="utf-8")
    target = pi_dir / SETTINGS_FILENAMES[0]
    target.write_text(json.dumps({"image_model": "from-json"}), encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) == "from-json"

    assert legacy.exists()
    assert not _migrated_path(pi_dir).exists()
    assert json.loads(target.read_text(encoding="utf-8")) == {"image_model": "from-json"}
    assert "settings_legacy_jsonc_ignored" in caplog.text


def test_corrupt_legacy_is_refused(
    _isolated_settings: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    broken = '{"image_model": "secret-value", '
    legacy.write_text(broken, encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "secret-value"

    assert legacy.read_text(encoding="utf-8") == broken
    assert not (pi_dir / SETTINGS_FILENAMES[0]).exists()
    assert not _migrated_path(pi_dir).exists()
    assert "settings_legacy_jsonc_corrupt" in caplog.text
    assert "secret-value" not in caplog.text


def test_tracked_legacy_refused_in_project_scope(
    _isolated_settings: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "from-jsonc"}), encoding="utf-8")
    _git_track(_isolated_settings, legacy)

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "from-jsonc"

    assert legacy.exists()
    assert not (pi_dir / SETTINGS_FILENAMES[0]).exists()
    assert not _migrated_path(pi_dir).exists()
    assert "settings_legacy_jsonc_tracked_refused" in caplog.text


def test_tracked_legacy_migrates_in_global_scope(_isolated_settings: Path) -> None:
    home_pi = Path.home() / ".pi"
    home_pi.mkdir()
    legacy = home_pi / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "from-global-jsonc"}), encoding="utf-8")
    _git_track(Path.home(), legacy)

    assert get_setting("image_model", cwd=_isolated_settings) == "from-global-jsonc"

    assert not legacy.exists()
    assert _migrated_path(home_pi).exists()
    assert (home_pi / SETTINGS_FILENAMES[0]).exists()


def test_symlinked_legacy_is_refused(
    _isolated_settings: Path,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    outside = tmp_path / "outside-settings"
    outside.write_text(json.dumps({"image_model": "from-outside"}), encoding="utf-8")
    (pi_dir / LEGACY_SETTINGS_FILENAME).symlink_to(outside)

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "from-outside"

    assert (pi_dir / LEGACY_SETTINGS_FILENAME).is_symlink()
    assert not (pi_dir / SETTINGS_FILENAMES[0]).exists()
    assert "settings_legacy_jsonc_symlink_refused" in caplog.text


def test_symlinked_legacy_refused_when_swapped_in_after_the_check(
    _isolated_settings: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The lstat pre-check can be raced; O_NOFOLLOW on the open is what actually refuses."""
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    outside = tmp_path / "outside-settings"
    outside.write_text(json.dumps({"image_model": "from-outside"}), encoding="utf-8")
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    legacy.symlink_to(outside)
    # A racing process replaced the file after the pre-check saw a regular file.
    monkeypatch.setattr(Path, "is_symlink", lambda _self: False)

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "from-outside"

    assert os.path.islink(legacy)
    assert not (pi_dir / SETTINGS_FILENAMES[0]).exists()
    assert "settings_legacy_jsonc_symlink_refused" in caplog.text


def test_symlinked_pi_dir_refused_in_project_scope(
    _isolated_settings: Path,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    outside_pi = tmp_path / "outside-pi"
    outside_pi.mkdir()
    legacy = outside_pi / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "from-outside"}), encoding="utf-8")
    (Path(_isolated_settings) / ".pi").symlink_to(outside_pi, target_is_directory=True)

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "from-outside"

    assert legacy.exists()
    assert not (outside_pi / SETTINGS_FILENAMES[0]).exists()
    assert not _migrated_path(outside_pi).exists()
    assert "settings_legacy_jsonc_dir_symlink_refused" in caplog.text


def test_symlinked_pi_dir_migrates_in_global_scope(
    _isolated_settings: Path,
    tmp_path: Path,
) -> None:
    # A dotfiles-managed `~/.pi` that links into a repo is the intended layout, not an attack.
    dotfiles_pi = tmp_path / "dotfiles-pi"
    dotfiles_pi.mkdir()
    legacy = dotfiles_pi / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "from-global-jsonc"}), encoding="utf-8")
    (Path.home() / ".pi").symlink_to(dotfiles_pi, target_is_directory=True)

    assert get_setting("image_model", cwd=_isolated_settings) == "from-global-jsonc"

    assert not legacy.exists()
    assert _migrated_path(dotfiles_pi).exists()
    assert (dotfiles_pi / SETTINGS_FILENAMES[0]).exists()


def test_deeply_nested_legacy_is_refused_not_raised(
    _isolated_settings: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    nested = '{"image_model": ' * 2000 + '"deep"' + "}" * 2000
    legacy.write_text(nested, encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "deep"

    assert legacy.exists()
    assert not (pi_dir / SETTINGS_FILENAMES[0]).exists()
    assert "settings_legacy_jsonc_corrupt" in caplog.text


def test_non_finite_number_is_refused_not_published(
    _isolated_settings: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """`1e400` parses to inf, which dumps to `Infinity` — output Node cannot parse."""
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    legacy.write_text('{"image_model": "from-jsonc", "pidash_port": 1e400}', encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) != "from-jsonc"

    assert legacy.exists()
    assert not (pi_dir / SETTINGS_FILENAMES[0]).exists()
    assert not _migrated_path(pi_dir).exists()
    assert "settings_legacy_jsonc_corrupt" in caplog.text


def test_second_migration_keeps_the_first_backup(_isolated_settings: Path) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    first = _migrated_path(pi_dir)
    first.write_text('{"image_model": "first"}', encoding="utf-8")
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "second"}), encoding="utf-8")

    assert get_setting("image_model", cwd=_isolated_settings) == "second"

    assert first.read_text(encoding="utf-8") == '{"image_model": "first"}'
    assert legacy.with_name(first.name + ".1").exists()


def test_legacy_changed_during_migration_is_left_in_place(
    _isolated_settings: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    legacy = pi_dir / LEGACY_SETTINGS_FILENAME
    legacy.write_text(json.dumps({"image_model": "first"}), encoding="utf-8")

    real_read = settings_commands._read_legacy_bytes
    calls = {"n": 0}

    def racing_read(path: Path) -> bytes | None:
        calls["n"] += 1
        if calls["n"] == 2:
            # Another process edits the legacy file between our read and the rename.
            path.write_text(json.dumps({"image_model": "edited"}), encoding="utf-8")
        return real_read(path)

    monkeypatch.setattr(settings_commands, "_read_legacy_bytes", racing_read)

    with caplog.at_level(logging.WARNING, logger="myk_pi_tools.settings.commands"):
        get_setting("image_model", cwd=_isolated_settings)

    assert legacy.exists()
    assert json.loads(legacy.read_text(encoding="utf-8")) == {"image_model": "edited"}
    assert not _migrated_path(pi_dir).exists()
    assert json.loads((pi_dir / SETTINGS_FILENAMES[0]).read_text(encoding="utf-8")) == {"image_model": "first"}
    assert "settings_legacy_jsonc_changed_during_migration" in caplog.text


def test_successful_migration_is_logged_at_info(
    _isolated_settings: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pi_dir = _isolated_settings / ".pi"
    pi_dir.mkdir()
    (pi_dir / LEGACY_SETTINGS_FILENAME).write_text(json.dumps({"image_model": "from-jsonc"}), encoding="utf-8")

    with caplog.at_level(logging.INFO, logger="myk_pi_tools.settings.commands"):
        assert get_setting("image_model", cwd=_isolated_settings) == "from-jsonc"

    records = [r for r in caplog.records if "settings_legacy_jsonc_migrated" in r.getMessage()]
    assert records, caplog.text
    assert all(r.levelno == logging.INFO for r in records)


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
