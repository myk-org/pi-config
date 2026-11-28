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
MYK_PI_TOOLS_INSTALL_CMD = "uv tool install --python 3.14 --upgrade myk-pi-tools"
BASEDPYRIGHT_INSTALL_CMD = "uv tool install --upgrade basedpyright"
# Dedicated prefix isolates typescript@6 (needed by typescript-language-server because
# typescript@7+ removed lib/tsserver.js) without downgrading the user's global `tsc`.
TS_LSP_NPM_PACKAGES = ("typescript@6", "typescript-language-server")
TS_LSP_PREFIX_REL = ".pi/lsp/ts-lsp"
TS_LSP_BIN_DIR_REL = ".pi/lsp/bin"
TS_LSP_INSTALL_CMD = "npm install --prefix ~/.pi/lsp/ts-lsp typescript@6 typescript-language-server"
GOPLS_INSTALL_CMD = "go install golang.org/x/tools/gopls@latest"
# Live npm install tree (pi unpacks packages here — not a git clone).
PI_NPM_PKG_DIR = "$HOME/.pi/agent/npm/node_modules/pi-orchestrator-config"
# Explicit paths — directory globs like extensions/pidash/ pack nested
# node_modules (files[] overrides gitignore). Same for scripts/ (__pycache__).
NPM_FILES_REQUIRED = (
    "scripts/pidash-server.ts",
    "scripts/pidiff-server.ts",
    "scripts/pidiff-git-diff.ts",
    "scripts/pidiff-git-ignore.ts",
    "scripts/daemon-shared.ts",
    "scripts/serve-ui.ts",
    "scripts/pidash-discord.ts",
    "scripts/httpd.py",
    "extensions/pidash/pidash-ui/src/",
    "extensions/pidiff/pidiff-ui/src/",
    "extensions/pidash/pidash-ui/dist/",
    "extensions/pidiff/pidiff-ui/dist/",
)
# Whole-tree entries swallow node_modules / __pycache__ into the tarball.
NPM_FILES_FORBIDDEN_TREES = (
    "extensions/pidash/",
    "extensions/pidiff/",
    "scripts/",
)
NPM_PACK_REQUIRED_PATHS = (
    "scripts/pidash-server.ts",
    "scripts/pidiff-server.ts",
    "scripts/pidiff-git-diff.ts",
    "scripts/pidiff-git-ignore.ts",
    "scripts/daemon-shared.ts",
    "scripts/serve-ui.ts",
    "scripts/pidash-discord.ts",
    "scripts/httpd.py",
    "extensions/pidash/pidash.ts",
    "extensions/pidiff/pidiff.ts",
    "extensions/pidash/pidash-ui/package.json",
    "extensions/pidiff/pidiff-ui/package.json",
    "extensions/shared/logger-core.mjs",
    "extensions/shared/install-logger.mjs",
)
NPM_PACK_FORBIDDEN_SUBSTRINGS = (
    "pidash-ui/node_modules",
    "pidiff-ui/node_modules",
)


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
    migrate = has_legacy
    log.debug("vertex migration needed=%s legacy=%s npm=%s", migrate, has_legacy, has_npm)
    return migrate


def vertex_pi_cmd(installed: bool, settings_text: str = "") -> str:
    """Install or update Vertex Claude from npm; drop leftover git-subdir source."""
    if should_migrate_vertex_to_npm(settings_text):
        parts = [f"pi uninstall {PI_VERTEX_GIT}"]
        if not is_pi_pkg_installed(settings_text, PI_VERTEX_NPM):
            parts.append(f"pi install {PI_VERTEX_NPM}")
        cmd = " && ".join(parts)
        log.debug("vertex migrate-to-npm cmd=%s", cmd)
        return cmd
    action = "update" if installed else "install"
    cmd = f"pi {action} {PI_VERTEX_NPM}"
    log.debug("vertex npm source installed=%s cmd=%s", installed, cmd)
    return cmd


def is_quoted_package_source(settings_text: str, source: str) -> bool:
    """True when settings.json lists ``source`` as a JSON string (quoted).

    Quoted match keeps ``git:…/pi-config`` from colliding with
    ``git:…/pi-config/packages/pi-vertex-claude``.
    """
    token = f'"{source}"'
    found = token in settings_text
    log.debug("quoted package source=%s found=%s", source, found)
    return found


def should_migrate_pi_config_to_npm(settings_text: str) -> bool:
    """True when the root git package is registered and npm is not."""
    has_npm = is_pi_pkg_installed(settings_text, PI_CONFIG_NPM)
    has_legacy = is_quoted_package_source(settings_text, PI_CONFIG_GIT)
    migrate = has_legacy
    log.debug("pi-config migration needed=%s legacy=%s npm=%s", migrate, has_legacy, has_npm)
    return migrate


def pi_config_pi_cmd(installed: bool, settings_text: str = "") -> str:
    """Install or update pi-config from npm; drop leftover root git source."""
    if should_migrate_pi_config_to_npm(settings_text):
        parts = [f"pi uninstall {PI_CONFIG_GIT}"]
        if not is_pi_pkg_installed(settings_text, PI_CONFIG_NPM):
            parts.append(f"pi install {PI_CONFIG_NPM}")
        cmd = " && ".join(parts)
        log.debug("pi-config migrate-to-npm cmd=%s", cmd)
        return cmd
    action = "update" if installed else "install"
    cmd = f"pi {action} {PI_CONFIG_NPM}"
    log.debug("pi-config npm source installed=%s cmd=%s", installed, cmd)
    return cmd


def npm_files_field_ships_pidash_pidiff(files: list[str]) -> bool:
    """Root package.json files must list daemon scripts and full pidash/pidiff
    trees (plus explicit dist/ so gitignored UI builds still pack).
    """
    missing = [entry for entry in NPM_FILES_REQUIRED if entry not in files]
    forbidden = [entry for entry in NPM_FILES_FORBIDDEN_TREES if entry in files]
    ok = not missing and not forbidden
    log.debug(
        "npm files-field pidash/pidiff ok=%s missing=%s forbidden_trees=%s",
        ok,
        missing,
        forbidden,
    )
    return ok


def npm_pack_paths_include_pidash_pidiff_runtime(paths: list[str]) -> bool:
    """Packed tarball must contain daemon entrypoints and UI package manifests,
    and must not ship UI node_modules.
    """
    missing = [p for p in NPM_PACK_REQUIRED_PATHS if p not in paths]
    leaked = [s for s in NPM_PACK_FORBIDDEN_SUBSTRINGS if any(s in p for p in paths)]
    ok = not missing and not leaked
    log.debug("npm pack pidash/pidiff runtime ok=%s missing=%s leaked=%s", ok, missing, leaked)
    return ok


def npm_pack_paths_include_ui_dist(paths: list[str]) -> bool:
    """Packed tarball must include built pidash/pidiff dashboard index.html."""
    required = (
        "extensions/pidash/pidash-ui/dist/index.html",
        "extensions/pidiff/pidiff-ui/dist/index.html",
    )
    missing = [p for p in required if p not in paths]
    ok = not missing
    log.debug("npm pack ui-dist check ok=%s missing=%s", ok, missing)
    return ok
