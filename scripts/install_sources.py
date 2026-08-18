"""Git sources and package-detection helpers for the native installer."""

from __future__ import annotations

import logging

PI_CONFIG_GIT = "git:github.com/myk-org/pi-config"
PI_VERTEX_GIT = "git:github.com/myk-org/pi-config/packages/pi-vertex-claude"
PI_VERTEX_SETTINGS_MARKER = "pi-config/packages/pi-vertex-claude"
RETIRED_VERTEX_GIT = "git:github.com/myk-org/pi-vertex-claude"


def create_logger(name: str = "install") -> logging.Logger:
    """Python analogue of extension ``createLogger`` — stdlib logger, no secrets."""
    return logging.getLogger(name)


log = create_logger("install")


def is_pi_pkg_installed(settings_text: str, name: str) -> bool:
    """True when ``name`` appears in pi ``settings.json`` text."""
    return bool(name) and name in settings_text


def vertex_pi_cmd(installed: bool) -> str:
    """Install or update command for Vertex Claude from the pi-config monorepo."""
    action = "update" if installed else "install"
    cmd = f"pi {action} {PI_VERTEX_GIT}"
    log.info("vertex git source installed=%s cmd=%s", installed, cmd)
    return cmd


def entrypoint_registers_vertex_via_settings(entrypoint_text: str) -> bool:
    """Container entrypoint must grep settings, not a sibling clone directory."""
    uses_marker = PI_VERTEX_SETTINGS_MARKER in entrypoint_text
    uses_retired_dir = "PI_PKG_DIR/myk-org/pi-vertex-claude" in entrypoint_text  # pragma: allowlist secret
    uses_retired_git = RETIRED_VERTEX_GIT in entrypoint_text
    return uses_marker and not uses_retired_dir and not uses_retired_git
