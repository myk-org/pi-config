"""Regression tests for installer Vertex sources and settings detection."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from install_sources import (  # noqa: E402
    MYK_PI_TOOLS_INSTALL_CMD,
    NPM_FILES_FORBIDDEN_TREES,
    NPM_FILES_REQUIRED,
    NPM_PACK_REQUIRED_PATHS,
    PI_CONFIG_GIT,
    PI_CONFIG_NPM,
    PI_NPM_PKG_DIR,
    PI_VERTEX_GIT,
    PI_VERTEX_NPM,
    PI_VERTEX_SETTINGS_MARKER,
    RETIRED_VERTEX_GIT,
    create_logger,
    entrypoint_has_no_pi_config_git_clone,
    entrypoint_has_single_registration_mechanism,
    entrypoint_installs_myk_pi_tools_from_pypi,
    entrypoint_registers_pi_config_via_npm,
    entrypoint_registers_vertex_via_settings,
    is_pi_pkg_installed,
    is_quoted_package_source,
    is_vertex_registered,
    npm_files_field_ships_pidash_pidiff,
    npm_pack_paths_include_pidash_pidiff_runtime,
    npm_pack_paths_include_ui_dist,
    pi_config_pi_cmd,
    should_migrate_pi_config_to_npm,
    should_migrate_vertex_to_npm,
    vertex_pi_cmd,
)

REPO = Path(__file__).resolve().parents[2]


def test_vertex_legacy_git_source_is_monorepo_not_retired_repo() -> None:
    assert PI_VERTEX_GIT == "git:github.com/myk-org/pi-config/packages/pi-vertex-claude"
    assert RETIRED_VERTEX_GIT not in PI_VERTEX_GIT
    assert PI_VERTEX_SETTINGS_MARKER in PI_VERTEX_GIT


def test_vertex_npm_source_matches_published_package() -> None:
    """Since 4.3.5 vertex ships via npm — the registry is the preferred source."""
    assert PI_VERTEX_NPM == "npm:@myk-org/pi-vertex-claude"


def test_settings_detection_uses_nested_marker_not_retired_source() -> None:
    nested = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    retired = '{"packages":["git:github.com/myk-org/pi-vertex-claude"]}'
    empty = "{}"
    assert is_pi_pkg_installed(nested, PI_VERTEX_SETTINGS_MARKER) is True
    assert is_pi_pkg_installed(retired, PI_VERTEX_SETTINGS_MARKER) is False
    assert is_pi_pkg_installed(empty, PI_VERTEX_SETTINGS_MARKER) is False


def test_directory_presence_is_not_enough_without_settings_marker() -> None:
    """Clone already contains packages/pi-vertex-claude; settings text is the source of truth."""
    settings_without_registration = '{"packages":["git:github.com/myk-org/pi-config"]}'
    assert is_pi_pkg_installed(settings_without_registration, PI_VERTEX_SETTINGS_MARKER) is False


def test_is_vertex_registered_accepts_git_and_npm_markers() -> None:
    git_registered = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    npm_registered = '{"packages":["npm:@myk-org/pi-vertex-claude"]}'
    unregistered = '{"packages":["git:github.com/myk-org/pi-config","npm:pi-web-access"]}'
    assert is_vertex_registered(git_registered) is True
    assert is_vertex_registered(npm_registered) is True
    assert is_vertex_registered(unregistered) is False


def test_should_migrate_vertex_to_npm_actively_replaces_stale_legacy_source() -> None:
    """A stale legacy entry must trigger migration, not be silently tolerated
    forever — that was the bug: skip-if-present let the racing git-subdir
    source live on indefinitely.
    """
    legacy_only = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    npm_only = '{"packages":["npm:@myk-org/pi-vertex-claude"]}'
    both = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude","npm:@myk-org/pi-vertex-claude"]}'
    neither = '{"packages":["npm:pi-web-access"]}'
    assert should_migrate_vertex_to_npm(legacy_only) is True
    assert should_migrate_vertex_to_npm(npm_only) is False
    assert should_migrate_vertex_to_npm(both) is True
    assert should_migrate_vertex_to_npm(neither) is False


def test_vertex_cmd_uses_npm_registry_source() -> None:
    assert vertex_pi_cmd(False) == f"pi install {PI_VERTEX_NPM}"
    assert vertex_pi_cmd(True) == f"pi update {PI_VERTEX_NPM}"
    assert RETIRED_VERTEX_GIT not in vertex_pi_cmd(False)
    # Legacy git-subdir source must never reappear as the *install* target —
    # it races the parent pi-config updater over the same working tree.
    assert f"pi install {PI_VERTEX_GIT}" not in vertex_pi_cmd(False)
    legacy = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    migrate = vertex_pi_cmd(False, legacy)
    assert f"pi uninstall {PI_VERTEX_GIT}" in migrate
    assert f"pi install {PI_VERTEX_NPM}" in migrate


def test_entrypoint_registers_vertex_via_settings_not_sibling_clone() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_registers_vertex_via_settings(text) is True


def test_entrypoint_prefers_npm_and_migrates_legacy_git_marker() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    # Registration call site names the npm source…
    assert 'register_pi_pkg "@myk-org/pi-vertex-claude"' in text
    # …and passes the full legacy git source as the migration marker so a
    # stale entry gets actively uninstalled, not just detected.
    assert PI_VERTEX_GIT in text
    assert "pi uninstall" in text
    # The retired standalone repo must stay out.
    assert "git:github.com/myk-org/pi-vertex-claude" not in text


def test_pi_config_npm_source_matches_published_package() -> None:
    """Since 4.3.7 pi-config itself installs from npm — not a git clone under .pi."""
    assert PI_CONFIG_NPM == "npm:pi-orchestrator-config"


def test_quoted_package_source_does_not_match_vertex_subdir() -> None:
    root = '{"packages":["git:github.com/myk-org/pi-config"]}'
    nested = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    assert is_quoted_package_source(root, PI_CONFIG_GIT) is True
    assert is_quoted_package_source(nested, PI_CONFIG_GIT) is False


def test_should_migrate_pi_config_to_npm() -> None:
    git_only = '{"packages":["git:github.com/myk-org/pi-config"]}'
    npm_only = '{"packages":["npm:pi-orchestrator-config"]}'
    both = '{"packages":["git:github.com/myk-org/pi-config","npm:pi-orchestrator-config"]}'
    vertex_git = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    assert should_migrate_pi_config_to_npm(git_only) is True
    assert should_migrate_pi_config_to_npm(npm_only) is False
    assert should_migrate_pi_config_to_npm(both) is True
    assert should_migrate_pi_config_to_npm(vertex_git) is False


def test_pi_config_cmd_uses_npm() -> None:
    assert pi_config_pi_cmd(False) == f"pi install {PI_CONFIG_NPM}"
    assert pi_config_pi_cmd(True) == f"pi update {PI_CONFIG_NPM}"


def test_pi_config_cmd_migrates_root_git() -> None:
    git_only = '{"packages":["git:github.com/myk-org/pi-config"]}'
    migrate = pi_config_pi_cmd(False, git_only)
    assert f"pi uninstall {PI_CONFIG_GIT}" in migrate
    assert f"pi install {PI_CONFIG_NPM}" in migrate
    both = '{"packages":["git:github.com/myk-org/pi-config","npm:pi-orchestrator-config"]}'
    assert pi_config_pi_cmd(True, both) == f"pi uninstall {PI_CONFIG_GIT}"


def test_myk_pi_tools_install_is_pypi() -> None:
    assert MYK_PI_TOOLS_INSTALL_CMD == "uv tool install myk-pi-tools"
    assert "git+" not in MYK_PI_TOOLS_INSTALL_CMD


def test_npm_pkg_dir_is_pi_npm_tree() -> None:
    assert PI_NPM_PKG_DIR == "$HOME/.pi/agent/npm/node_modules/pi-orchestrator-config"
    assert "git/" not in PI_NPM_PKG_DIR


def test_entrypoint_registers_pi_config_via_npm_not_git_clone() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_registers_pi_config_via_npm(text) is True
    assert f"pi install {PI_CONFIG_GIT}" not in text
    assert ".pi/agent/git/github.com" not in text
    assert 'register_pi_pkg pi-orchestrator-config "git:github.com/myk-org/pi-config"' in text


def test_entrypoint_installs_myk_pi_tools_from_pypi_not_source() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_installs_myk_pi_tools_from_pypi(text) is True


def test_entrypoint_has_no_pi_config_git_clone() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_has_no_pi_config_git_clone(text) is True
    assert "github.com/myk-org/pi-config.git" not in text
    assert "pi-config-src" not in text
    assert "node_modules/pi-orchestrator-config" in text
    assert r'"\"${legacy_marker}\""' in text


def test_install_py_has_no_pi_config_git_commands() -> None:
    text = (REPO / "scripts/install.py").read_text()
    assert "git:github.com/myk-org/pi-config" not in text
    assert "git+https://github.com/myk-org/pi-config" not in text
    assert "agent/git/github.com" not in text


def test_entrypoint_has_single_registration_mechanism() -> None:
    """register_pi_pkg must be the only install-if-missing code path — no
    duplicate hand-rolled grep+install blocks next to it."""
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_has_single_registration_mechanism(text) is True


def test_create_logger_returns_named_logger() -> None:
    logger = create_logger("install")
    assert logger.name == "install"
    logger.info("vertex detection probe")


def _package_files_field() -> list[str]:
    data = json.loads((REPO / "package.json").read_text())
    files = data["files"]
    assert isinstance(files, list)
    return files


def _npm_pack_paths() -> list[str]:
    result = subprocess.run(
        ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    listing = payload[0] if isinstance(payload, list) else payload
    return [entry["path"] if isinstance(entry, dict) else entry for entry in listing["files"]]


def test_npm_files_field_ships_pidash_pidiff_without_swallowing_node_modules() -> None:
    files = _package_files_field()
    assert npm_files_field_ships_pidash_pidiff(files) is True
    for entry in NPM_FILES_REQUIRED:
        assert entry in files
    for glob in NPM_FILES_FORBIDDEN_TREES:
        assert glob not in files


def test_npm_pack_includes_pidash_pidiff_daemons() -> None:
    paths = _npm_pack_paths()
    assert npm_pack_paths_include_pidash_pidiff_runtime(paths) is True
    for required in NPM_PACK_REQUIRED_PATHS:
        assert required in paths


def test_npm_pack_includes_ui_source() -> None:
    paths = _npm_pack_paths()
    assert "extensions/pidash/pidash-ui/package.json" in paths
    assert "extensions/pidiff/pidiff-ui/package.json" in paths


def test_npm_pack_includes_ui_dist() -> None:
    paths = _npm_pack_paths()
    assert npm_pack_paths_include_ui_dist(paths) is True


def test_package_json_prepack_builds_extension_uis() -> None:
    data = json.loads((REPO / "package.json").read_text())
    scripts = data["scripts"]
    assert "build-extension-uis.sh" in scripts["prepack"]
    assert "build-extension-uis.sh" in scripts["prepublishOnly"]
