"""Regression tests for installer Vertex sources and settings detection."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from install_sources import (  # noqa: E402
    PI_CONFIG_GIT,
    PI_CONFIG_NPM,
    PI_SRC_DIR_MARKER,
    PI_VERTEX_GIT,
    PI_VERTEX_NPM,
    PI_VERTEX_SETTINGS_MARKER,
    RETIRED_VERTEX_GIT,
    create_logger,
    entrypoint_has_single_registration_mechanism,
    entrypoint_installs_myk_pi_tools_from_pypi,
    entrypoint_registers_pi_config_via_npm,
    entrypoint_registers_vertex_via_settings,
    entrypoint_source_clone_under_home_not_dotpi,
    is_pi_pkg_installed,
    is_vertex_registered,
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
    assert should_migrate_vertex_to_npm(both) is False
    assert should_migrate_vertex_to_npm(neither) is False


def test_vertex_cmd_uses_npm_registry_source() -> None:
    assert vertex_pi_cmd(False) == f"pi install {PI_VERTEX_NPM}"
    assert vertex_pi_cmd(True) == f"pi update {PI_VERTEX_NPM}"
    assert RETIRED_VERTEX_GIT not in vertex_pi_cmd(False)
    # Legacy git-subdir source must never reappear in generated commands — it
    # races the parent pi-config updater over the same working tree.
    assert PI_VERTEX_GIT not in vertex_pi_cmd(False)


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


def test_source_clone_marker_lives_under_home_not_dotpi() -> None:
    assert PI_SRC_DIR_MARKER == "$HOME/pi-config-src"
    assert ".pi" not in PI_SRC_DIR_MARKER


def test_entrypoint_registers_pi_config_via_npm_not_git_clone() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_registers_pi_config_via_npm(text) is True
    assert PI_CONFIG_GIT not in text
    assert ".pi/agent/git/github.com" not in text


def test_entrypoint_installs_myk_pi_tools_from_pypi_not_source() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_installs_myk_pi_tools_from_pypi(text) is True


def test_entrypoint_source_clone_under_home_not_dotpi() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_source_clone_under_home_not_dotpi(text) is True


def test_entrypoint_has_single_registration_mechanism() -> None:
    """register_pi_pkg must be the only install-if-missing code path — no
    duplicate hand-rolled grep+install blocks next to it."""
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_has_single_registration_mechanism(text) is True


def test_create_logger_returns_named_logger() -> None:
    logger = create_logger("install")
    assert logger.name == "install"
    logger.info("vertex detection probe")
