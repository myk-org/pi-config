"""Git sources and package-detection helpers for the native installer."""

from __future__ import annotations

import logging

PI_CONFIG_GIT = "git:github.com/myk-org/pi-config"
PI_VERTEX_GIT = "git:github.com/myk-org/pi-config/packages/pi-vertex-claude"
PI_VERTEX_SETTINGS_MARKER = "pi-config/packages/pi-vertex-claude"
RETIRED_VERTEX_GIT = "git:github.com/myk-org/pi-vertex-claude"
# Preferred source since 4.3.5 — npm ships the aligned version set.
PI_VERTEX_NPM = "npm:@myk-org/pi-vertex-claude"
# Preferred source since 4.3.7 — pi-config itself installs from npm, not a
# git clone under ~/.pi (that tree is package-managed, not a scratch checkout).
PI_CONFIG_NPM = "npm:pi-orchestrator-config"
# Throwaway source clone (agents/, symlink script — files npm doesn't ship)
# lives under $HOME, never under .pi.
PI_SRC_DIR_MARKER = "$HOME/pi-config-src"


def create_logger(name: str = "install") -> logging.Logger:
    """Python analogue of extension ``createLogger`` — stdlib logger, no secrets."""
    return logging.getLogger(name)


log = create_logger("install")


def is_pi_pkg_installed(settings_text: str, name: str) -> bool:
    """True when ``name`` appears in pi ``settings.json`` text."""
    found = bool(name) and name in settings_text
    log.debug("pi package marker=%s found=%s", name, found)
    return found


def is_vertex_registered(settings_text: str) -> bool:
    """True when vertex is registered via the legacy git source or the npm package."""
    registered = is_pi_pkg_installed(settings_text, PI_VERTEX_GIT) or is_pi_pkg_installed(settings_text, PI_VERTEX_NPM)
    log.debug("vertex registered (git or npm marker)=%s", registered)
    return registered


def should_migrate_vertex_to_npm(settings_text: str) -> bool:
    """True when the legacy git-subdir source is present and must be actively
    replaced (pi uninstall + pi install npm:...) rather than left in place.
    Leaving it in place is the bug this guards against: it lets the
    git-subdir source keep racing the parent pi-config updater forever.
    """
    has_npm = is_pi_pkg_installed(settings_text, PI_VERTEX_NPM)
    has_legacy = is_pi_pkg_installed(settings_text, PI_VERTEX_GIT)
    migrate = has_legacy and not has_npm
    log.debug("vertex migration needed=%s legacy=%s npm=%s", migrate, has_legacy, has_npm)
    return migrate


def vertex_pi_cmd(installed: bool) -> str:
    """Install or update command for Vertex Claude from the npm registry."""
    action = "update" if installed else "install"
    cmd = f"pi {action} {PI_VERTEX_NPM}"
    log.debug("vertex npm source installed=%s cmd=%s", installed, cmd)
    return cmd


def entrypoint_registers_vertex_via_settings(entrypoint_text: str) -> bool:
    """Container entrypoint must grep settings, not a sibling clone directory,
    and must actively migrate (uninstall) a stale legacy source — not skip
    registration just because the old entry is present.
    """
    uses_marker = PI_VERTEX_GIT in entrypoint_text
    uses_retired_dir = "PI_PKG_DIR/myk-org/pi-vertex-claude" in entrypoint_text  # pragma: allowlist secret
    uses_retired_git = RETIRED_VERTEX_GIT in entrypoint_text
    migrates_legacy = "pi uninstall" in entrypoint_text
    ok = uses_marker and migrates_legacy and not uses_retired_dir and not uses_retired_git
    log.debug(
        "entrypoint vertex settings-check ok=%s marker=%s migrates=%s retired_dir=%s retired_git=%s",
        ok,
        uses_marker,
        migrates_legacy,
        uses_retired_dir,
        uses_retired_git,
    )
    return ok


def entrypoint_registers_pi_config_via_npm(entrypoint_text: str) -> bool:
    """pi-config itself must install from npm (via the shared register_pi_pkg
    helper), never clone into .pi."""
    uses_npm_call_site = "register_pi_pkg pi-orchestrator-config" in entrypoint_text
    uses_git_clone = PI_CONFIG_GIT in entrypoint_text
    uses_dotpi_dir = ".pi/agent/git/github.com" in entrypoint_text
    ok = uses_npm_call_site and not uses_git_clone and not uses_dotpi_dir
    log.debug(
        "entrypoint pi-config npm-check ok=%s call_site=%s git_clone=%s dotpi_dir=%s",
        ok,
        uses_npm_call_site,
        uses_git_clone,
        uses_dotpi_dir,
    )
    return ok


def entrypoint_installs_myk_pi_tools_from_pypi(entrypoint_text: str) -> bool:
    """myk-pi-tools must install from PyPI, never a local source clone."""
    has_install = "uv tool install --force myk-pi-tools" in entrypoint_text
    uses_from_flag = "myk-pi-tools --from" in entrypoint_text
    ok = has_install and not uses_from_flag
    log.debug("entrypoint myk-pi-tools pypi-check ok=%s from_flag=%s", ok, uses_from_flag)
    return ok


def entrypoint_source_clone_under_home_not_dotpi(entrypoint_text: str) -> bool:
    """The agents/symlink source clone must live under $HOME, not .pi."""
    uses_home_src = PI_SRC_DIR_MARKER in entrypoint_text
    uses_dotpi_dir = ".pi/agent/git/github.com" in entrypoint_text
    ok = uses_home_src and not uses_dotpi_dir
    log.debug(
        "entrypoint source-clone location-check ok=%s home_src=%s dotpi_dir=%s", ok, uses_home_src, uses_dotpi_dir
    )
    return ok


def entrypoint_has_single_registration_mechanism(entrypoint_text: str) -> bool:
    """Every package must register through register_pi_pkg — no duplicate
    hand-rolled grep+install blocks bypassing the shared helper.

    The helper's own body contains exactly one ``pi install`` call; every
    package (pi-config, vertex, pi-web-access, …) reuses it via a
    ``register_pi_pkg <args>`` call site instead of repeating the
    grep-then-install pattern inline.
    """
    has_helper = "register_pi_pkg()" in entrypoint_text
    install_calls_outside_helper = entrypoint_text.count("pi install") - 1  # 1 = the helper's own call
    uninstall_calls_outside_helper = entrypoint_text.count("pi uninstall") - 1  # 1 = the helper's own migration call
    call_sites = entrypoint_text.count("register_pi_pkg ")
    ok = has_helper and install_calls_outside_helper == 0 and uninstall_calls_outside_helper == 0 and call_sites >= 1
    log.debug(
        "entrypoint single-mechanism-check ok=%s helper=%s stray_installs=%d stray_uninstalls=%d call_sites=%d",
        ok,
        has_helper,
        install_calls_outside_helper,
        uninstall_calls_outside_helper,
        call_sites,
    )
    return ok
