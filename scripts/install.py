#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["questionary"]
# ///
"""
pi-config Installer
====================
Interactive CLI installer for pi-config and related tooling.

Usage:
    uv run scripts/install.py
    uvx scripts/install.py

Options:
    --all     Install everything non-interactively (no prompts)
    --help    Show help message
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import questionary
from questionary import Choice

try:
    from install_sources import (
        BASEDPYRIGHT_INSTALL_CMD,
        GOPLS_INSTALL_CMD,
        MYK_PI_TOOLS_INSTALL_CMD,
        PI_CONFIG_NPM,
        PI_VERTEX_NPM,
        TS_LSP_INSTALL_CMD,
        TS_LSP_NPM_PACKAGES,
        create_logger,
        is_pi_pkg_installed,
        pi_config_pi_cmd,
        should_migrate_pi_config_to_npm,
        should_migrate_vertex_to_npm,
        vertex_pi_cmd,
    )
except ModuleNotFoundError:
    _PI_CONFIG_GIT = "git:github.com/myk-org/pi-config"
    _PI_VERTEX_GIT = "git:github.com/myk-org/pi-config/packages/pi-vertex-claude"
    PI_VERTEX_NPM = "npm:@myk-org/pi-vertex-claude"
    PI_CONFIG_NPM = "npm:pi-orchestrator-config"
    MYK_PI_TOOLS_INSTALL_CMD = "uv tool install --python 3.14 --upgrade myk-pi-tools"
    BASEDPYRIGHT_INSTALL_CMD = "uv tool install --upgrade basedpyright"
    TS_LSP_NPM_PACKAGES = ("typescript", "typescript-language-server")
    TS_LSP_INSTALL_CMD = "npm install -g typescript typescript-language-server"
    GOPLS_INSTALL_CMD = "go install golang.org/x/tools/gopls@latest"

    def create_logger(name: str = "install") -> logging.Logger:
        return logging.getLogger(name)

    def is_pi_pkg_installed(settings_text: str, name: str) -> bool:
        return bool(name) and name in settings_text

    def should_migrate_vertex_to_npm(settings_text: str) -> bool:
        return is_pi_pkg_installed(settings_text, _PI_VERTEX_GIT)

    def vertex_pi_cmd(installed: bool, settings_text: str = "") -> str:
        if should_migrate_vertex_to_npm(settings_text):
            parts = [f"pi uninstall {_PI_VERTEX_GIT}"]
            if not is_pi_pkg_installed(settings_text, PI_VERTEX_NPM):
                parts.append(f"pi install {PI_VERTEX_NPM}")
            return " && ".join(parts)
        return f"pi {'update' if installed else 'install'} {PI_VERTEX_NPM}"

    def should_migrate_pi_config_to_npm(settings_text: str) -> bool:
        return f'"{_PI_CONFIG_GIT}"' in settings_text

    def pi_config_pi_cmd(installed: bool, settings_text: str = "") -> str:
        if should_migrate_pi_config_to_npm(settings_text):
            parts = [f"pi uninstall {_PI_CONFIG_GIT}"]
            if not is_pi_pkg_installed(settings_text, PI_CONFIG_NPM):
                parts.append(f"pi install {PI_CONFIG_NPM}")
            return " && ".join(parts)
        return f"pi {'update' if installed else 'install'} {PI_CONFIG_NPM}"


log = create_logger("install")
if not log.handlers:
    # Prevent Python's logging.lastResort from printing raw warnings onto active spinner lines.
    log.addHandler(logging.NullHandler())

# ── Constants ──────────────────────────────────────────────────────────────

SYSTEM = platform.system()
ARCH = platform.machine()
ARCH_DL = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(ARCH, ARCH)
OS_LOWER = SYSTEM.lower()
HOME = Path.home()
TOTAL_STEPS = 6


GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[90m"
BOLD = "\033[1m"
CYAN = "\033[36m"
RESET = "\033[0m"

ALL_MODE = False
_NPM_GLOBAL_BIN_NOTICE: Path | None = None
_PATH_NOTICE_DIRS: list[Path] = []


class _CommandFailedError(RuntimeError):
    """Raised by install_fn helpers when a subprocess fails with captured output."""

    def __init__(self, message: str, output: str = "") -> None:
        super().__init__(message)
        self.output = output


# ── Data Models ────────────────────────────────────────────────────────────


@dataclass
class Tool:
    name: str
    description: str
    installed: bool
    disabled: str  # "" if enabled, "requires X" if disabled
    install_cmd: str = ""
    install_fn: Any = None  # optional callable, used instead of install_cmd
    installed_label: str = "installed"


@dataclass
class Step:
    icon: str
    title: str
    description: str
    tools: list[Tool] = field(default_factory=list)


# ── Helpers ────────────────────────────────────────────────────────────────


def _run_quiet(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def _gitignore_path() -> str:
    path = ""
    if shutil.which("git"):
        path = _run_quiet(["git", "config", "--global", "core.excludesfile"])
    if not path:
        path = str(HOME / ".config/git/ignore")
    return path.replace("~", str(HOME))


def _meaningful_error_lines(text: str, limit: int = 5) -> list[str]:
    """Return up to the last ``limit`` non-empty error lines, skipping npm log-path boilerplate."""
    lines: list[str] = []
    skip_next_log_path = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if "A complete log of this run can be found in:" in line:
            skip_next_log_path = line.endswith(":")
            continue
        if skip_next_log_path:
            skip_next_log_path = False
            if "_logs" in line or line.endswith(".log"):
                continue
        lines.append(line)
    return lines[-limit:]


def _validate_npm_prefix(raw: str) -> tuple[Path, bool]:
    """Validate an npm global prefix path; return ``(resolved_path, is_writable)``."""
    prefix = Path(raw)
    if not raw or not prefix.is_absolute():
        log.warning("trail unsafe npm global prefix rejected value=%r", raw)
        raise RuntimeError("npm prefix -g must return a safe absolute path")
    resolved = prefix.resolve()
    cwd = Path.cwd().resolve()
    writable_parent = resolved
    while not writable_parent.exists():
        writable_parent = writable_parent.parent
    if (
        resolved == Path(resolved.anchor)
        or resolved == cwd
        or (resolved.exists() and not resolved.is_dir())
        or not writable_parent.is_dir()
    ):
        log.warning("trail unsafe npm global prefix rejected value=%r", raw)
        raise RuntimeError("npm prefix -g must return a safe absolute path")
    return resolved, os.access(writable_parent, os.W_OK)


def _prepend_to_path(bin_dir: Path) -> None:
    global _NPM_GLOBAL_BIN_NOTICE
    bin_str = str(bin_dir)
    current = os.environ.get("PATH", "")
    parts = current.split(os.pathsep) if current else []
    if bin_str not in parts:
        os.environ["PATH"] = f"{bin_str}{os.pathsep}{current}" if current else bin_str
        _NPM_GLOBAL_BIN_NOTICE = bin_dir
        if bin_dir not in _PATH_NOTICE_DIRS:
            _PATH_NOTICE_DIRS.append(bin_dir)


def _ensure_writable_npm_prefix() -> Path:
    """Return a safe, user-writable global npm prefix, switching to ``~/.npm-global`` if root-owned."""
    result = subprocess.run(["npm", "prefix", "-g"], capture_output=True, text=True, timeout=5, check=True)
    resolved, writable = _validate_npm_prefix(result.stdout.strip())
    if writable:
        return resolved
    fallback = HOME / ".npm-global"
    (fallback / "bin").mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["npm", "config", "set", "prefix", str(fallback)],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    fallback_resolved, fallback_writable = _validate_npm_prefix(str(fallback))
    if not fallback_writable:
        raise RuntimeError("npm prefix -g must return a safe absolute path")
    _prepend_to_path(fallback_resolved / "bin")
    log.info("configured user-writable npm prefix=%s", fallback_resolved)
    return fallback_resolved


@contextmanager
def _publication_lock(lock_path: Path) -> Generator[None]:
    lock_id = hashlib.sha256(os.fsencode(lock_path)).hexdigest()[:12]
    with lock_path.open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"\0")
            lock.flush()
        lock.seek(0)
        log.debug("trail publication lock event=acquire platform=%s lock_id=%s", SYSTEM, lock_id)
        try:
            if SYSTEM == "Windows":
                import msvcrt

                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)  # type: ignore[attr-defined]
            else:
                import fcntl

                fcntl.flock(lock, fcntl.LOCK_EX)
        except Exception:
            log.error("trail publication lock event=failure phase=acquire platform=%s lock_id=%s", SYSTEM, lock_id)
            raise
        log.debug("trail publication lock event=acquired platform=%s lock_id=%s", SYSTEM, lock_id)
        try:
            yield
        finally:
            log.debug("trail publication lock event=release platform=%s lock_id=%s", SYSTEM, lock_id)
            try:
                if SYSTEM == "Windows":
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)  # type: ignore[attr-defined]
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)
            except Exception:
                log.error("trail publication lock event=failure phase=release platform=%s lock_id=%s", SYSTEM, lock_id)
                raise


def _publish_trail(stage: Path, trail_prefix: Path, trail_bin: Path, lock_path: Path) -> None:
    backup = stage.with_name(f"{stage.name}.previous")
    link = trail_bin.with_name(f".{stage.name}-trail")
    with _publication_lock(lock_path):
        log.debug("trail publication lock acquired")
        had_previous = trail_prefix.exists()
        published = False
        try:
            if had_previous:
                os.replace(trail_prefix, backup)
            os.replace(stage, trail_prefix)
            published = True
            link.symlink_to("../lib/trail-prefix/bin/trail")
            os.replace(link, trail_bin)
        except Exception:
            link.unlink(missing_ok=True)
            if published:
                shutil.rmtree(trail_prefix)
            if had_previous:
                os.replace(backup, trail_prefix)
            raise
        if had_previous:
            shutil.rmtree(backup)


# ── Install Command Builders ──────────────────────────────────────────────


def _install_script_packages_python(package_dir: Path, install_root: Path) -> list[str]:
    """Fallback recursive package.json walk when install.py runs standalone without repo scripts."""
    seen: set[Path] = set()
    allowed: set[str] = set()

    def inspect(path: Path) -> None:
        real = path.resolve()
        if real in seen:
            return
        seen.add(real)
        manifest = json.loads((real / "package.json").read_text())
        scripts = manifest.get("scripts", {})
        lifecycle_hook = {"preinstall", "install", "postinstall"} & scripts.keys()
        default_node_gyp_hook = "install" not in scripts and (real / "binding.gyp").is_file()
        if lifecycle_hook or default_node_gyp_hook:
            allowed.add(manifest["name"])
        optional = manifest.get("optionalDependencies", {})
        dependencies = manifest.get("dependencies", {}) | optional
        for name in dependencies:
            child = next(
                (
                    candidate
                    for candidate in (
                        real / "node_modules" / name,
                        *(parent / "node_modules" / name for parent in real.parents),
                        install_root / name,
                    )
                    if candidate.exists() and (candidate == install_root / name or install_root in candidate.parents)
                ),
                None,
            )
            if child is None:
                if name in optional:
                    log.debug("trail optional dependency omitted package=%s", name)
                    continue
                raise FileNotFoundError(f"required Trail dependency is not installed: {name}")
            inspect(child)

    inspect(package_dir)
    log.debug("trail install-script audit (python fallback) packages=%s", len(allowed))
    return sorted(allowed)


def _install_script_packages(package_dir: Path, install_root: Path) -> list[str]:
    script_dir = Path(__file__).resolve().parent
    auditor = script_dir / "trail-allow-scripts.mjs"
    auditor_logger = script_dir.parent / "extensions/shared/install-logger.mjs"
    if auditor.is_file() and auditor_logger.is_file() and shutil.which("node"):
        result = subprocess.run(
            ["node", str(auditor), str(package_dir), str(install_root)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip()
            if "required Trail dependency is not installed:" in err:
                raise FileNotFoundError(err)
            raise RuntimeError(f"Trail dependency audit failed: {err}")
        output = result.stdout.strip()
        allowed = [pkg for pkg in output.split(",") if pkg]
        log.debug("trail install-script audit packages=%s", len(allowed))
        return allowed
    log.debug("trail auditor sibling unavailable; falling back to Python package walk")
    return _install_script_packages_python(package_dir, install_root)


def _linux_build_tools_cmd() -> list[str] | None:
    if SYSTEM != "Linux":
        return None
    if shutil.which("dnf"):
        return ["dnf", "install", "-y", "make", "gcc-c++"]
    if shutil.which("apt-get"):
        return ["apt-get", "install", "-y", "build-essential"]
    return None


def _ensure_trail_prerequisites() -> None:
    missing = [tool for tool in ("npm", "node", "python3", "make", "g++") if not shutil.which(tool)]
    if not missing:
        return
    pkg_cmd = _linux_build_tools_cmd() if set(missing) <= {"make", "g++"} else None
    auto_install_error: str | None = None
    if pkg_cmd:
        can_install = False
        full_cmd = pkg_cmd
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            can_install = True
        elif shutil.which("sudo"):
            try:
                probe = subprocess.run(["sudo", "-n", "true"], capture_output=True, text=True, timeout=5)
                can_install = probe.returncode == 0
                full_cmd = ["sudo", "-n", *pkg_cmd]
            except OSError:
                can_install = False
        if can_install:
            log.info("installing missing node-gyp prerequisites via %s", pkg_cmd[0])
            env = os.environ | ({"DEBIAN_FRONTEND": "noninteractive"} if pkg_cmd[0] == "apt-get" else {})
            try:
                subprocess.run(full_cmd, capture_output=True, text=True, timeout=300, check=True, env=env)
            except subprocess.CalledProcessError as exc:
                err_text = (exc.stderr or "") or (exc.output or "")
                detail_lines = _meaningful_error_lines(err_text, limit=2) if isinstance(err_text, str) else []
                auto_install_error = "; ".join(detail_lines) if detail_lines else str(exc)
                log.warning("auto-install of node-gyp prerequisites failed error=%s", auto_install_error)
            except (OSError, subprocess.TimeoutExpired) as exc:
                auto_install_error = str(exc)
                log.warning("auto-install of node-gyp prerequisites failed error=%s", exc)
            missing = [tool for tool in ("npm", "node", "python3", "make", "g++") if not shutil.which(tool)]
            if not missing:
                return
    log.warning("trail prerequisites missing=%s", ",".join(missing))
    hint = f" (install with: sudo {' '.join(pkg_cmd)})" if pkg_cmd else ""
    reason = f"; auto-install failed: {auto_install_error}" if auto_install_error else ""
    raise RuntimeError(f"Trail requires node-gyp prerequisites: {', '.join(missing)}{hint}{reason}")


def install_agent_browser() -> None:
    prefix = _ensure_writable_npm_prefix()
    _prepend_to_path(prefix / "bin")
    result = subprocess.run(
        ["npm", "install", "-g", "agent-browser"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise _CommandFailedError("npm install -g agent-browser failed", result.stderr or result.stdout)


def _is_chromium_installed() -> bool:
    """Return True only when a launchable Chrome/Chromium binary exists in agent-browser or Playwright caches."""
    binary_names = {"chrome", "chromium", "chrome.exe", "Google Chrome for Testing", "Chromium"}
    search_globs = (
        HOME / ".agent-browser/browsers/chrome-*",
        HOME / ".cache/ms-playwright/chromium-*",
    )
    for pattern in search_globs:
        for base in glob.glob(str(pattern)):
            for root, _dirs, files in os.walk(base):
                for fname in files:
                    if fname in binary_names:
                        candidate = Path(root) / fname
                        if candidate.is_file() and os.access(candidate, os.X_OK):
                            try:
                                probe = subprocess.run(
                                    [str(candidate), "--version"],
                                    capture_output=True,
                                    text=True,
                                    timeout=5,
                                )
                            except (OSError, subprocess.TimeoutExpired):
                                continue
                            if probe.returncode == 0:
                                return True
    return False


def _find_npm_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    candidates: list[Path] = []
    if shutil.which("npm"):
        prefix = _run_quiet(["npm", "prefix", "-g"])
        if prefix:
            candidates.append(Path(prefix) / "bin" / name)
    candidates.append(HOME / ".npm-global/bin" / name)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _find_agent_browser() -> str | None:
    return _find_npm_bin("agent-browser")


def _find_uv_tool_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    candidates: list[Path] = []
    env_bin_dir = os.environ.get("UV_TOOL_BIN_DIR", "").strip()
    if env_bin_dir:
        candidates.append(Path(env_bin_dir) / name)
    if shutil.which("uv"):
        uv_bin_dir = _run_quiet(["uv", "tool", "dir", "--bin"])
        if uv_bin_dir:
            candidates.append(Path(uv_bin_dir) / name)
    candidates.append(HOME / ".local/bin" / name)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _find_go_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    candidates: list[Path] = []
    if shutil.which("go"):
        gopath = _run_quiet(["go", "env", "GOPATH"])
        if gopath:
            for root in gopath.split(os.pathsep):
                if root:
                    candidates.append(Path(root) / "bin" / name)
    candidates.append(HOME / "go/bin" / name)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def install_typescript_lsp() -> None:
    prefix = _ensure_writable_npm_prefix()
    _prepend_to_path(prefix / "bin")
    result = subprocess.run(
        ["npm", "install", "-g", *TS_LSP_NPM_PACKAGES],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise _CommandFailedError(f"{TS_LSP_INSTALL_CMD} failed", result.stderr or result.stdout)
    log.info("typescript-language-server installation verified prefix=%s", prefix)


def install_basedpyright() -> None:
    if not shutil.which("uv"):
        raise RuntimeError("uv not found on PATH")
    result = subprocess.run(
        ["uv", "tool", "install", "--upgrade", "basedpyright"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise _CommandFailedError(f"{BASEDPYRIGHT_INSTALL_CMD} failed", result.stderr or result.stdout)
    found = _find_uv_tool_bin("basedpyright-langserver")
    uv_bin = Path(found).parent if found else HOME / ".local/bin"
    if uv_bin.is_dir():
        _prepend_to_path(uv_bin)
    log.info("basedpyright installation verified bin_dir=%s", uv_bin)


def install_gopls() -> None:
    if not shutil.which("go"):
        raise RuntimeError("go not found on PATH")
    result = subprocess.run(
        ["go", "install", "golang.org/x/tools/gopls@latest"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise _CommandFailedError(f"{GOPLS_INSTALL_CMD} failed", result.stderr or result.stdout)
    gopath = _run_quiet(["go", "env", "GOPATH"])
    go_bin = Path(gopath.split(os.pathsep)[0]) / "bin" if gopath else HOME / "go/bin"
    if go_bin.is_dir():
        _prepend_to_path(go_bin)
    log.info("gopls installation verified")


def install_browser() -> None:
    agent_browser = _find_agent_browser()
    if not agent_browser:
        install_agent_browser()
        agent_browser = _find_agent_browser()
    if not agent_browser:
        raise RuntimeError("agent-browser not found on PATH; install agent-browser first")
    result = subprocess.run(
        [agent_browser, "install", "--with-deps"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise _CommandFailedError("agent-browser install --with-deps failed", result.stderr or result.stdout)


def install_trail() -> None:
    _ensure_trail_prerequisites()
    npm_version = _run_quiet(["npm", "--version"])
    try:
        npm_major = int(npm_version.split(".", 1)[0])
    except ValueError as exc:
        log.warning("trail unable to parse npm version=%r", npm_version)
        raise RuntimeError(f"Unable to determine npm version: {npm_version!r}") from exc
    if npm_major < 10:
        log.warning("trail secure install unsupported npm-major=%s", npm_major)
        raise RuntimeError("Trail secure installation requires npm 10+")
    env = os.environ | {"DO_NOT_TRACK": "1"}
    global_prefix = _ensure_writable_npm_prefix()
    trail_prefix = global_prefix / "lib/trail-prefix"
    trail_bin = global_prefix / "bin/trail"
    trail_prefix.parent.mkdir(parents=True, exist_ok=True)
    trail_bin.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="pi-trail-audit-") as audit_raw:
        audit = Path(audit_raw)
        subprocess.run(
            ["npm", "install", "-g", "--prefix", str(audit), "@trailhq/trail-code@latest", "--ignore-scripts"],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
        npm_root = audit / "lib/node_modules"
        allowed_pkgs = _install_script_packages(npm_root / "@trailhq/trail-code", npm_root)
        if not allowed_pkgs:
            raise RuntimeError("Trail dependency audit found no install scripts")

    with tempfile.TemporaryDirectory(prefix=".trail-prefix-", dir=trail_prefix.parent) as stage_raw:
        stage = Path(stage_raw)
        (stage / "lib").mkdir()
        if npm_major >= 12:
            allowed = ",".join(allowed_pkgs)
            subprocess.run(
                [
                    "npm",
                    "install",
                    "-g",
                    "--prefix",
                    str(stage),
                    "@trailhq/trail-code@latest",
                    f"--allow-scripts={allowed}",
                    "--strict-allow-scripts",
                ],
                check=True,
                capture_output=True,
                text=True,
                env=env,
            )
        else:
            subprocess.run(
                ["npm", "install", "-g", "--prefix", str(stage), "@trailhq/trail-code@latest", "--ignore-scripts"],
                check=True,
                capture_output=True,
                text=True,
                env=env,
            )
            subprocess.run(
                ["npm", "rebuild", "-g", "--prefix", str(stage), *allowed_pkgs],
                check=True,
                capture_output=True,
                text=True,
                env=env,
            )
        subprocess.run([str(stage / "bin/trail"), "--version"], check=True, capture_output=True, text=True, env=env)

        _publish_trail(stage, trail_prefix, trail_bin, global_prefix / ".trail-install.lock")
    log.info("trail installation verified")


# ── Prerequisites ──────────────────────────────────────────────────────────


def check_prereqs() -> dict[str, bool]:
    prereqs: dict[str, bool] = {}

    # Node.js >= 22
    node_path = shutil.which("node")
    if node_path:
        ver = _run_quiet(["node", "--version"]).lstrip("v")
        try:
            prereqs["node"] = int(ver.split(".")[0]) >= 22
        except ValueError:
            prereqs["node"] = False
    else:
        prereqs["node"] = False

    prereqs["git"] = shutil.which("git") is not None
    prereqs["pi"] = shutil.which("pi") is not None
    prereqs["uv"] = shutil.which("uv") is not None

    # Display results
    print()
    print("  Prerequisites:")

    hints = {
        "node": "Install: https://nodejs.org or nvm install 22",
        "git": "Install: apt install git / brew install git",
        "pi": "Install: npm install -g @earendil-works/pi-coding-agent",
        "uv": "Install: curl -LsSf https://astral.sh/uv/install.sh | sh",
    }

    for name, present in prereqs.items():
        icon = "✓" if present else "✗"
        color = GREEN if present else RED
        hint = f"  ({hints[name]})" if not present else ""
        print(f"  {color}  {icon}{RESET} {name}{hint}")

    # pi is the only hard requirement — nothing works without it
    if not prereqs["pi"]:
        print()
        print(f"  {RED}{BOLD}Cannot continue without pi.{RESET}")
        print("  Install: npm install -g @earendil-works/pi-coding-agent")
        sys.exit(1)

    # node, uv, git are soft — warn and continue with limited features
    if not all(prereqs.values()):
        print()
        answer = questionary.confirm("Some prerequisites missing. Continue with limited features?").ask()
        if answer is None or not answer:
            sys.exit(1)

    return prereqs


# ── Step Definitions ───────────────────────────────────────────────────────


def build_steps(prereqs: dict[str, bool]) -> list[Step]:
    has = prereqs

    # ── Step 1: Pi Packages ──────────────────────────────────────────────
    pi_dis = "" if has["pi"] else "requires pi"

    try:
        settings_text = (HOME / ".pi/agent/settings.json").read_text()
    except (FileNotFoundError, OSError, UnicodeDecodeError, ValueError):
        settings_text = ""

    pi_cfg = is_pi_pkg_installed(settings_text, PI_CONFIG_NPM) and not should_migrate_pi_config_to_npm(settings_text)
    pi_vtx = is_pi_pkg_installed(settings_text, PI_VERTEX_NPM) and not should_migrate_vertex_to_npm(settings_text)
    pi_web = is_pi_pkg_installed(settings_text, "pi-web-access")
    log.debug(
        "pi package detection pi-config-ready=%s vertex-ready=%s web=%s pi-config-migrate=%s vertex-migrate=%s",
        pi_cfg,
        pi_vtx,
        pi_web,
        should_migrate_pi_config_to_npm(settings_text),
        should_migrate_vertex_to_npm(settings_text),
    )

    step1 = Step(
        "📦",
        "Pi Packages",
        "Core pi extensions — orchestrator, agents, and model providers",
        [
            Tool(
                "pi-config",
                "Orchestrator + 24 agents + prompts",
                installed=pi_cfg,
                disabled=pi_dis,
                install_cmd=pi_config_pi_cmd(pi_cfg, settings_text),
            ),
            Tool(
                "pi-vertex-claude",
                "Claude via Google Cloud Vertex AI",
                installed=pi_vtx,
                disabled=pi_dis,
                install_cmd=vertex_pi_cmd(pi_vtx, settings_text),
            ),
            Tool(
                "pi-web-access",
                "Web search · fetch · librarian skills",
                installed=pi_web,
                disabled=pi_dis,
                install_cmd="pi install npm:pi-web-access",
            ),
            Tool(
                "myk-pi-tools",
                "CLI utilities for pi-config (reviews, releases, memory)",
                installed=bool(shutil.which("myk-pi-tools")),
                disabled="requires uv" if not has["uv"] else pi_dis,
                install_cmd=MYK_PI_TOOLS_INSTALL_CMD,
            ),
        ],
    )

    # ── Step 2: Python Tools ─────────────────────────────────────────────
    uv_dis = "" if has["uv"] else "requires uv"
    step2 = Step(
        "🐍",
        "Python Tools",
        "CLI utilities used by pi-config workflows",
        [
            Tool(
                "prek",
                "Fast Git hook manager (pre-commit alternative)",
                installed=bool(shutil.which("prek")),
                disabled=uv_dis,
                install_cmd="uv tool install prek",
            ),
        ],
    )

    # ── Step 3: npm Packages ─────────────────────────────────────────────
    nd = "" if has["node"] else "requires Node.js"
    step3 = Step(
        "📦",
        "npm Packages",
        "Node.js tools for agent capabilities",
        [
            Tool(
                "agent-browser",
                "Browser automation for web testing",
                installed=bool(shutil.which("agent-browser")),
                disabled=nd,
                install_cmd="npm install -g agent-browser",
                install_fn=install_agent_browser,
            ),
            Tool(
                "trail",
                "Local repository code graph for the optional Trail extension",
                installed=bool(shutil.which("trail")),
                disabled=nd,
                install_fn=install_trail,
            ),
        ],
    )

    # ── Step 4: Browser Automation ───────────────────────────────────────
    step4 = Step(
        "🌐",
        "Browser Automation",
        "Headless browser for agent-browser web automation",
        [
            Tool(
                "agent-browser Chromium",
                "Headless Chromium browser engine",
                installed=_is_chromium_installed(),
                disabled=nd,
                install_cmd="agent-browser install --with-deps",
                install_fn=install_browser,
            ),
        ],
    )

    # ── Step 6: Environment Setup ────────────────────────────────────────
    gd = "" if has["git"] else "requires git"
    gi = _gitignore_path()
    pi_inst = wt_inst = False
    try:
        content = Path(gi).read_text()
        # Exact line match — ".pi/memory/" should not count as ".pi/" being present
        lines = content.splitlines()
        pi_inst = ".pi/" in lines
        wt_inst = ".worktrees/" in lines
    except Exception:
        pass

    def _add_to_gitignore(entry: str) -> None:
        """Add an entry to the global gitignore using Python (no shell)."""
        gi_path = Path(gi)
        gi_path.parent.mkdir(parents=True, exist_ok=True)
        gi_path.touch(exist_ok=True)
        subprocess.run(
            ["git", "config", "--global", "core.excludesfile", str(gi_path)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        content = gi_path.read_text()
        if entry not in content.splitlines():
            prefix = "\n" if content and not content.endswith("\n") else ""
            with gi_path.open("a") as f:
                f.write(f"{prefix}{entry}\n")

    step5 = Step(
        "⚙️",
        "Environment Setup",
        "Git configuration for pi-config",
        [
            Tool(
                ".pi/ in gitignore",
                "Prevent pi data files from being committed",
                installed=pi_inst,
                disabled=gd,
                install_fn=lambda: _add_to_gitignore(".pi/"),
                installed_label="configured",
            ),
            Tool(
                ".worktrees/ in gitignore",
                "Prevent git worktree dirs from being committed",
                installed=wt_inst,
                disabled=gd,
                install_fn=lambda: _add_to_gitignore(".worktrees/"),
                installed_label="configured",
            ),
        ],
    )

    # ── Step 6: Language Servers (LSP) ───────────────────────────────────
    has_go = shutil.which("go") is not None
    step6 = Step(
        "🧠",
        "Language Servers (LSP)",
        "Optional language servers for opt-in write/edit LSP diagnostics",
        [
            Tool(
                "typescript-language-server",
                "TypeScript/JavaScript LSP (typescript + typescript-language-server)",
                installed=bool(_find_npm_bin("typescript-language-server")),
                disabled=nd,
                install_cmd=TS_LSP_INSTALL_CMD,
                install_fn=install_typescript_lsp,
            ),
            Tool(
                "basedpyright",
                "Python LSP server (basedpyright-langserver)",
                installed=bool(_find_uv_tool_bin("basedpyright-langserver")),
                disabled=uv_dis,
                install_cmd=BASEDPYRIGHT_INSTALL_CMD,
                install_fn=install_basedpyright,
            ),
            Tool(
                "gopls",
                "Go language server (skipped if go is not installed)",
                installed=bool(_find_go_bin("gopls")),
                disabled="" if has_go else "requires go",
                install_cmd=GOPLS_INSTALL_CMD,
                install_fn=install_gopls,
            ),
        ],
    )

    return [step1, step2, step3, step4, step5, step6]


# ── Step UI ────────────────────────────────────────────────────────────────


def print_step_header(num: int, icon: str, title: str, description: str) -> None:
    os.system("clear" if os.name != "nt" else "cls")
    print()
    print("  ╭─────────────────────────────────────────╮")
    print(f"  │  Step {num} of {TOTAL_STEPS} — {icon} {title:<25s}  │")
    print("  ╰─────────────────────────────────────────╯")
    print(f"  {description}")
    print()


def run_step(step_idx: int, step: Step) -> list[Tool]:
    """Run one interactive step, return list of selected tools to install."""
    print_step_header(step_idx + 1, step.icon, step.title, step.description)

    choices: list[Choice] = []
    for tool in step.tools:
        label = f"{tool.name} — {tool.description}"

        if tool.disabled:
            choices.append(Choice(label, checked=False, disabled=tool.disabled))
        elif tool.installed:
            choices.append(Choice(label, checked=True, disabled=tool.installed_label))
        else:
            choices.append(Choice(label, checked=True))

    # If all choices are disabled (all installed/disabled), skip the prompt
    has_selectable = any(not tool.installed and not tool.disabled for tool in step.tools)
    if not has_selectable:
        # Just show status, no prompt needed
        for tool in step.tools:
            if tool.installed:
                print(f"  {GREEN}✓{RESET} {tool.name} — {tool.description} {DIM}({tool.installed_label}){RESET}")
            elif tool.disabled:
                print(f"  {DIM}⊘ {tool.name} — {tool.description} ({tool.disabled}){RESET}")
        print()
        return []

    result = questionary.checkbox(
        "Select tools:",
        choices=choices,
        style=questionary.Style([
            ("highlighted", "noinherit"),
            ("selected", "noinherit"),
            ("pointer", "noinherit bold"),
            ("answer", "noinherit"),
        ]),
    ).ask()

    if result is None:
        # Ctrl+C or Escape
        print()
        print(f"  {DIM}Cancelled.{RESET}")
        sys.exit(1)

    # Map selected labels back to Tool objects (skip already installed/disabled)
    selected: list[Tool] = []
    for tool in step.tools:
        if tool.installed or tool.disabled:
            continue
        label = f"{tool.name} — {tool.description}"

        if label in result:
            selected.append(tool)

    return selected


def auto_select_all(steps: list[Step]) -> list[Tool]:
    """Auto-select everything not installed and not disabled."""
    selected: list[Tool] = []
    for step in steps:
        for tool in step.tools:
            if not tool.disabled and not tool.installed:
                selected.append(tool)
    return selected


# ── Plan ───────────────────────────────────────────────────────────────────


def show_plan(selections: list[Tool]) -> None:
    print()
    print("  ╭─────────────────────────────────────────╮")
    print("  │         Installation Plan                │")
    print("  ╰─────────────────────────────────────────╯")
    print()
    for tool in selections:
        print(f"    • {tool.name} — {tool.description}")
    print()
    print(f"  Total: {len(selections)} tool(s)")
    print()


# ── Installation ───────────────────────────────────────────────────────────


def install_all(selections: list[Tool]) -> tuple[int, int, list[Tool]]:
    print()
    print("  Installing...")
    print()

    installed = 0
    failed = 0
    failed_tools: list[Tool] = []

    for tool in selections:
        print(f"  ⏳ {tool.name}...", end="", flush=True)
        try:
            if tool.install_fn:
                tool.install_fn()
                print(f"\r\033[2K  {GREEN}✓{RESET} {tool.name}")
                installed += 1
                continue
            result = subprocess.run(
                tool.install_cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode == 0:
                print(f"\r\033[2K  {GREEN}✓{RESET} {tool.name}")
                installed += 1
            else:
                print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — failed")
                for line in _meaningful_error_lines(result.stderr or result.stdout):
                    print(f"    {DIM}{line}{RESET}")
                failed += 1
                failed_tools.append(tool)
        except subprocess.TimeoutExpired:
            print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — timed out (5m)")
            failed += 1
            failed_tools.append(tool)
        except _CommandFailedError as exc:
            print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — failed")
            for line in _meaningful_error_lines(exc.output):
                print(f"    {DIM}{line}{RESET}")
            failed += 1
            failed_tools.append(tool)
        except subprocess.CalledProcessError as exc:
            print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — failed")
            err_text = (exc.stderr or "") or (exc.output or "")
            lines = _meaningful_error_lines(err_text) if isinstance(err_text, str) else []
            if lines:
                for line in lines:
                    print(f"    {DIM}{line}{RESET}")
            else:
                print(f"    {DIM}{exc}{RESET}")
            failed += 1
            failed_tools.append(tool)
        except Exception as exc:
            print(f"\r\033[2K  {RED}✗{RESET} {tool.name} — {exc}")
            failed += 1
            failed_tools.append(tool)

    return installed, failed, failed_tools


# ── Update ─────────────────────────────────────────────────────────────────


def update_pi(prereqs: dict[str, bool]) -> bool:
    """Run pi update --extensions to update pi itself and all installed packages."""
    if not prereqs.get("pi"):
        return True

    print()
    print("  ⏳ Updating pi and packages...", end="", flush=True)
    try:
        result = subprocess.run(
            ["pi", "update", "--extensions"],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode == 0:
            print(f"\r\033[2K  {GREEN}✓{RESET} pi and packages updated")
            return True
        print(f"\r\033[2K  {RED}✗{RESET} pi update failed")
        for line in _meaningful_error_lines(result.stderr or result.stdout):
            print(f"    {DIM}{line}{RESET}")
        return False
    except subprocess.TimeoutExpired:
        print(f"\r\033[2K  {RED}✗{RESET} pi update timed out (5m)")
        return False
    except Exception as exc:
        print(f"\r\033[2K  {RED}✗{RESET} pi update — {exc}")
        return False


# ── Summary ────────────────────────────────────────────────────────────────


def show_summary(installed: int, failed: int, skipped: int, failed_tools: list[Tool] | None = None) -> None:
    print()
    print("  ╭─────────────────────────────────────────╮")
    print("  │           Install Complete               │")
    print("  ╰─────────────────────────────────────────╯")
    print()
    print(f"  {GREEN}✓{RESET} Installed: {installed}")
    print(f"  {DIM}—{RESET} Skipped:   {skipped}")
    if failed:
        print(f"  {RED}✗{RESET} Failed:    {failed}")
    if failed_tools:
        print()
        print(f"  {BOLD}To install failed tools manually:{RESET}")
        for tool in failed_tools:
            if tool.install_cmd:
                print(f"    {DIM}${RESET} {tool.install_cmd}")
            else:
                print(f"    {DIM}-{RESET} {tool.name} (re-run the installer to retry)")
    notice_dirs = list(_PATH_NOTICE_DIRS)
    if _NPM_GLOBAL_BIN_NOTICE is not None and _NPM_GLOBAL_BIN_NOTICE not in notice_dirs:
        notice_dirs.append(_NPM_GLOBAL_BIN_NOTICE)
    if notice_dirs:
        joined = os.pathsep.join(str(d) for d in notice_dirs)
        print()
        print(f"  {BOLD}Add newly installed tool bin directories to your shell PATH:{RESET}")
        print(f'    export PATH="{joined}:$PATH"')
    print()
    print("  Run 'pi' to start a session!")
    print()


# ── Main ───────────────────────────────────────────────────────────────────


def main() -> None:
    global ALL_MODE

    parser = argparse.ArgumentParser(
        description="pi-config Installer — interactive CLI for pi-config and related tooling",
    )
    parser.add_argument("--all", action="store_true", help="Install everything non-interactively (no prompts)")
    args = parser.parse_args()
    ALL_MODE = args.all

    print()
    print(f"  {BOLD}{CYAN}pi-config Installer{RESET}")
    print(f"  {DIM}{'─' * 37}{RESET}")

    # Prerequisites
    if ALL_MODE:
        prereqs = check_prereqs_quiet()
    else:
        prereqs = check_prereqs()

    # Build steps
    steps = build_steps(prereqs)

    # Collect selections
    selections: list[Tool] = []
    if ALL_MODE:
        selections = auto_select_all(steps)
        print()
        print(f"  {DIM}--all mode: auto-selecting {len(selections)} tool(s){RESET}")
    else:
        for i, step in enumerate(steps):
            selected = run_step(i, step)
            selections.extend(selected)

    if not selections:
        print()
        print("  Nothing to install.")
        # Still update pi and existing packages
        update_ok = update_pi(prereqs)
        print()
        if not update_ok:
            sys.exit(1)
        return

    # Show plan
    show_plan(selections)

    # Confirm
    if not ALL_MODE:
        answer = questionary.confirm("Proceed with installation?").ask()
        if answer is None or not answer:
            print()
            print(f"  {DIM}Cancelled.{RESET}")
            sys.exit(1)

    # Install
    total_tools = sum(len(step.tools) for step in steps)
    installed, failed, failed_tools = install_all(selections)

    # Update pi and all packages
    update_ok = update_pi(prereqs)

    # Adjust skipped to account for failures
    skipped = total_tools - installed - failed

    # Summary
    show_summary(installed, failed, skipped, failed_tools)

    if failed > 0 or not update_ok:
        sys.exit(1)


def check_prereqs_quiet() -> dict[str, bool]:
    """Check prerequisites without interactive prompts (for --all mode)."""
    prereqs: dict[str, bool] = {}

    node_path = shutil.which("node")
    if node_path:
        ver = _run_quiet(["node", "--version"]).lstrip("v")
        try:
            prereqs["node"] = int(ver.split(".")[0]) >= 22
        except ValueError:
            prereqs["node"] = False
    else:
        prereqs["node"] = False

    prereqs["git"] = shutil.which("git") is not None
    prereqs["pi"] = shutil.which("pi") is not None
    prereqs["uv"] = shutil.which("uv") is not None

    hints = {
        "node": "Install: https://nodejs.org or nvm install 22",
        "git": "Install: apt install git / brew install git",
        "pi": "Install: npm install -g @earendil-works/pi-coding-agent",
        "uv": "Install: curl -LsSf https://astral.sh/uv/install.sh | sh",
    }

    print()
    print("  Prerequisites:")
    for name, present in prereqs.items():
        icon = "✓" if present else "✗"
        color = GREEN if present else RED
        hint = f"  ({hints[name]})" if not present else ""
        print(f"  {color}  {icon}{RESET} {name}{hint}")

    if not prereqs["pi"]:
        print()
        print(f"  {RED}{BOLD}Cannot continue without pi.{RESET}")
        print("  Install: npm install -g @earendil-works/pi-coding-agent")
        sys.exit(1)

    if not all(prereqs.values()):
        print()
        print(f"  {DIM}⚠  Some prerequisites missing. Dependent tools will be skipped.{RESET}")

    return prereqs


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Aborted.")
        sys.exit(130)
