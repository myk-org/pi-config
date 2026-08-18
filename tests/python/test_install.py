"""Regression tests for installer Vertex git source and settings detection."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from install_sources import (  # noqa: E402
    PI_VERTEX_GIT,
    PI_VERTEX_SETTINGS_MARKER,
    RETIRED_VERTEX_GIT,
    create_logger,
    entrypoint_registers_vertex_via_settings,
    is_pi_pkg_installed,
    vertex_pi_cmd,
)

REPO = Path(__file__).resolve().parents[2]


def test_vertex_git_source_is_monorepo_not_retired_repo() -> None:
    assert PI_VERTEX_GIT == "git:github.com/myk-org/pi-config/packages/pi-vertex-claude"
    assert RETIRED_VERTEX_GIT not in PI_VERTEX_GIT
    assert PI_VERTEX_SETTINGS_MARKER in PI_VERTEX_GIT


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


def test_vertex_install_cmd_uses_monorepo_source() -> None:
    assert vertex_pi_cmd(False) == f"pi install {PI_VERTEX_GIT}"
    assert vertex_pi_cmd(True) == f"pi update {PI_VERTEX_GIT}"
    assert RETIRED_VERTEX_GIT not in vertex_pi_cmd(False)


def test_entrypoint_registers_vertex_via_settings_not_sibling_clone() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert entrypoint_registers_vertex_via_settings(text) is True


def test_create_logger_returns_named_logger() -> None:
    logger = create_logger("install")
    assert logger.name == "install"
    logger.info("vertex detection probe")
