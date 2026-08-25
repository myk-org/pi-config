"""Regression tests for installer Vertex sources and settings detection."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from install_sources import (  # noqa: E402
    PI_VERTEX_GIT,
    PI_VERTEX_NPM,
    PI_VERTEX_SETTINGS_MARKER,
    RETIRED_VERTEX_GIT,
    create_logger,
    entrypoint_registers_vertex_via_settings,
    is_pi_pkg_installed,
    is_vertex_registered,
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


def test_entrypoint_prefers_npm_and_tolerates_legacy_git_marker() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    # Install command pulls from npm…
    assert "pi install npm:@myk-org/pi-vertex-claude" in text
    # …while the registration check still honors legacy git-marker installs.
    assert "pi-config/packages/pi-vertex-claude" in text
    # The retired standalone repo must stay out.
    assert "git:github.com/myk-org/pi-vertex-claude" not in text


def test_create_logger_returns_named_logger() -> None:
    logger = create_logger("install")
    assert logger.name == "install"
    logger.info("vertex detection probe")
