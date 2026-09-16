"""Regression tests for installer Vertex sources and settings detection."""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

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


def _ensure_ui_dist_pack_fixtures() -> None:
    """Gitignored dist/ may be absent on a clean checkout. Write minimal
    index.html so ``npm pack --ignore-scripts`` still lists dashboard entrypoints.
    """
    log = create_logger("install-test")
    for rel in (
        "extensions/pidash/pidash-ui/dist/index.html",
        "extensions/pidiff/pidiff-ui/dist/index.html",
    ):
        path = REPO / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            log.debug("ui dist already present path=%s", path)
            continue
        path.write_text("<!doctype html><title>pack-fixture</title>\n", encoding="utf-8")
        log.debug("wrote ui dist pack fixture path=%s", path)


def _npm_pack_paths() -> list[str]:
    _ensure_ui_dist_pack_fixtures()
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
    assert scripts["prepack"] == "npm run build:extension-uis"
    assert "build-extension-uis.sh" in scripts["build:extension-uis"]
    assert "prepublishOnly" not in scripts


def _prereqs(*, node: bool = True, git: bool = True, pi: bool = True, uv: bool = True) -> dict[str, bool]:
    return {"node": node, "git": git, "pi": pi, "uv": uv}


def _stub_questionary() -> None:
    if "questionary" in sys.modules:
        return
    q = ModuleType("questionary")
    q.__dict__.update({
        "Choice": type("Choice", (), {}),
        "Style": lambda *_args: None,
        "confirm": lambda *_args, **_kwargs: None,
        "checkbox": lambda *_args, **_kwargs: None,
    })
    sys.modules["questionary"] = q


def _tool(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    *,
    node: bool = True,
    installed: str | None = None,
) -> Any:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(
        install.shutil,
        "which",
        lambda candidate, *_args, **_kwargs: installed if candidate == name else None,
    )
    for step in install.build_steps(_prereqs(node=node)):
        for tool in step.tools:
            if tool.name == name:
                return tool
    raise AssertionError(f"{name} tool missing from build_steps")


def _mcpc_tool(monkeypatch: pytest.MonkeyPatch, *, node: bool, which_mcpc: str | None) -> Any:
    _stub_questionary()
    install = importlib.import_module("install")

    def fake_which(name: str, *_args: object, **_kwargs: object) -> str | None:
        if name == "mcpc":
            return which_mcpc
        return None

    monkeypatch.setattr(install.shutil, "which", fake_which)
    for step in install.build_steps(_prereqs(node=node)):
        for tool in step.tools:
            if tool.name == "mcpc":
                return tool
    raise AssertionError("mcpc tool missing from build_steps")


def test_build_steps_emits_mcpc_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _mcpc_tool(monkeypatch, node=True, which_mcpc=None)
    assert tool.name == "mcpc"


def test_build_steps_mcpc_npm_install_command(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _mcpc_tool(monkeypatch, node=True, which_mcpc=None)
    assert tool.install_cmd == "npm install -g @apify/mcpc"


def test_build_steps_mcpc_installed_when_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _mcpc_tool(monkeypatch, node=True, which_mcpc="/usr/bin/mcpc")
    assert tool.installed is True


def test_build_steps_mcpc_not_installed_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _mcpc_tool(monkeypatch, node=True, which_mcpc=None)
    assert tool.installed is False


def test_build_steps_mcpc_disabled_without_node(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _mcpc_tool(monkeypatch, node=False, which_mcpc=None)
    assert tool.disabled == "requires Node.js"


def test_graft_native_install_uses_audited_strict_npm12_installer(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _tool(monkeypatch, "graft")
    assert tool.install_fn
    assert tool.install_cmd == "DO_NOT_TRACK=1 npm install -g @nanonets/graft@latest (strict dynamic script approval)"


def _write_package(path: Path, manifest: dict[str, Any]) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "package.json").write_text(json.dumps(manifest))


def test_graft_script_audit_includes_only_reachable_lifecycle_packages(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"native-dependency": "1"}})
    _write_package(
        root / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )
    _write_package(root / "node_modules/unrelated", {"name": "unrelated", "scripts": {"install": "bad"}})

    assert install._install_script_packages(root, tmp_path / "node_modules") == ["native-dependency"]


def test_graft_script_audit_finds_fully_hoisted_required_dependency(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    assert install._install_script_packages(root, tmp_path / "node_modules") == ["native-dependency"]


def test_graft_script_audit_ignores_omitted_optional_dependency(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "optionalDependencies": {"other-platform": "1"}})

    assert install._install_script_packages(root, tmp_path / "node_modules") == []


def test_graft_script_audit_rejects_missing_required_dependency(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"required": "1"}})

    with pytest.raises(FileNotFoundError, match="required"):
        install._install_script_packages(root, tmp_path / "node_modules")


def _run_graft_auditor(root: Path, *, debug: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ | {
        "HOME": str(root.parents[2]),
        "PI_LOG_GRAFT_INSTALL": "debug" if debug else "off",
    }
    return subprocess.run(
        ["node", str(REPO / "scripts/graft-allow-scripts.mjs"), str(root), str(root.parents[1])],
        capture_output=True,
        text=True,
        env=env,
    )


def _graft_auditor_log(root: Path) -> str:
    return (root.parents[2] / ".pi/logs/graft-install/install.log").read_text()


def test_docker_graft_auditor_finds_fully_hoisted_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    result = _run_graft_auditor(root)
    assert result.returncode == 0
    assert result.stdout == "native-dependency"
    assert result.stderr == ""


def test_docker_graft_auditor_logs_resolved_dependency_when_debug_enabled(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    _run_graft_auditor(root)
    log = _graft_auditor_log(root)
    assert "[debug] [graft-install]" in log
    assert '"event":"dependency_resolved"' in log
    assert '"dependency":"native-dependency"' in log


def test_docker_graft_auditor_redacts_paths_from_debug_log(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"dependency": "1"}})
    _write_package(root / "node_modules/dependency", {"name": "dependency"})

    _run_graft_auditor(root)
    assert str(tmp_path) not in _graft_auditor_log(root)


def test_docker_graft_auditor_debug_logging_is_disabled_by_default(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"dependency": "1"}})
    _write_package(root / "node_modules/dependency", {"name": "dependency"})

    result = _run_graft_auditor(root, debug=False)
    assert result.returncode == 0
    assert result.stderr == ""
    assert not (root.parents[2] / ".pi/logs/graft-install/install.log").exists()


def test_docker_graft_auditor_ignores_omitted_optional_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "optionalDependencies": {"other-platform": "1"}})

    result = _run_graft_auditor(root)
    assert result.returncode == 0


def test_docker_graft_auditor_rejects_missing_required_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"required": "1"}})

    result = _run_graft_auditor(root)
    assert result.returncode != 0
    assert "required Graft dependency is not installed: required" in result.stderr


def test_docker_graft_auditor_logs_unresolved_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@nanonets/graft"
    _write_package(root, {"name": "@nanonets/graft", "dependencies": {"required": "1"}})

    _run_graft_auditor(root)
    log = _graft_auditor_log(root)
    assert '"event":"dependency_unresolved"' in log
    assert '"dependency":"required"' in log


def test_graft_native_install_uses_two_fresh_prefixes_and_publishes_verified_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    calls: list[list[str]] = []
    stages: list[Path] = []

    def run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if cmd[:3] == ["npm", "install", "-g"]:
            stage = Path(cmd[cmd.index("--prefix") + 1])
            stages.append(stage)
            if len(stages) == 2:
                assert not stages[0].exists()
                assert (stage / "lib").is_dir()
            root = stage / "lib/node_modules/@nanonets/graft"
            _write_package(root, {"name": "@nanonets/graft", "dependencies": {"native": "1"}})
            _write_package(stage / "lib/node_modules/native", {"name": "native", "scripts": {"install": "build"}})
            (stage / "bin").mkdir()
            (stage / "bin/graft").write_text("#!/bin/sh\n")
        elif cmd[-1:] == ["--version"]:
            assert not (prefix / "lib/graft-prefix").exists()
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        install,
        "_run_quiet",
        lambda cmd: "12.0.2" if cmd == ["npm", "--version"] else str(prefix),
    )
    monkeypatch.setattr(install.subprocess, "run", run)

    install.install_graft()

    published = prefix / "lib/graft-prefix"
    assert stages[0] != stages[1]
    assert not stages[0].exists()
    assert (published / "lib/node_modules/@nanonets/graft/package.json").is_file()
    assert (prefix / "bin/graft").readlink() == Path("../lib/graft-prefix/bin/graft")
    audit_cmd, install_cmd = calls[:2]
    assert audit_cmd[5:] == ["@nanonets/graft@latest", "--ignore-scripts"]
    assert install_cmd == [
        "npm",
        "install",
        "-g",
        "--prefix",
        str(stages[1]),
        "@nanonets/graft@latest",
        "--allow-scripts=native",
        "--strict-allow-scripts",
    ]
    assert calls[2] == [str(stages[1] / "bin/graft"), "--version"]


def test_graft_native_install_cleans_stages_and_keeps_published_install_when_second_install_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    completed = prefix / "lib/graft-prefix"
    completed.mkdir(parents=True)
    (completed / "marker").write_text("old")
    graft_bin = prefix / "bin/graft"
    graft_bin.parent.mkdir(parents=True)
    graft_bin.symlink_to("../lib/graft-prefix/bin/graft")
    stages: list[Path] = []

    def run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if cmd[:3] == ["npm", "install", "-g"]:
            stage = Path(cmd[cmd.index("--prefix") + 1])
            stages.append(stage)
            if len(stages) == 2:
                assert not stages[0].exists()
                raise subprocess.CalledProcessError(1, cmd)
            root = stage / "lib/node_modules/@nanonets/graft"
            _write_package(root, {"name": "@nanonets/graft", "scripts": {"install": "build"}})
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        install,
        "_run_quiet",
        lambda cmd: "12.0.2" if cmd == ["npm", "--version"] else str(prefix),
    )
    monkeypatch.setattr(install.subprocess, "run", run)

    with pytest.raises(subprocess.CalledProcessError):
        install.install_graft()

    assert len(stages) == 2
    assert all(not stage.exists() for stage in stages)
    assert (completed / "marker").read_text() == "old"
    assert graft_bin.readlink() == Path("../lib/graft-prefix/bin/graft")


def test_graft_native_install_checks_node_gyp_prerequisites(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(install.shutil, "which", lambda name: None if name == "make" else f"/usr/bin/{name}")
    with pytest.raises(RuntimeError, match="make"):
        install.install_graft()


def test_entrypoint_reinstalls_mcpc() -> None:
    text = (REPO / "entrypoint.sh").read_text()
    assert "npm install -g @apify/mcpc" in text


def test_entrypoint_continues_when_mcpc_npm_install_fails(tmp_path: Path) -> None:
    """A failed @apify/mcpc reinstall must not abort container start."""
    log = create_logger("install-test")
    entrypoint = REPO / "entrypoint.sh"
    bin_dir = tmp_path / "bin"
    home = tmp_path / "home"
    home.mkdir()
    bin_dir.mkdir()
    npm_log = tmp_path / "npm.log"
    update_marker = tmp_path / "reached-pi-update"

    npm = bin_dir / "npm"
    npm.write_text(
        "#!/bin/sh\n"
        f'printf "%s\\n" "$*" >> "{npm_log}"\n'
        'for arg in "$@"; do\n'
        '  if [ "$arg" = "@apify/mcpc" ]; then exit 1; fi\n'
        "done\n"
        "exit 0\n"
    )
    pi = bin_dir / "pi"
    pi.write_text(f'#!/bin/sh\nif [ "$1" = "update" ]; then : > "{update_marker}"; fi\nexit 0\n')
    uv = bin_dir / "uv"
    uv.write_text("#!/bin/sh\nexit 0\n")
    git = bin_dir / "git"
    git.write_text("#!/bin/sh\nexit 0\n")
    for stub in (npm, pi, uv, git):
        stub.chmod(0o755)

    env = os.environ.copy()
    env["HOME"] = str(home)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    result = subprocess.run(
        ["bash", str(entrypoint), "survived"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        cwd=tmp_path,
        timeout=15,
    )
    log.debug(
        "entrypoint mcpc-fail-open exit=%s npm_log=%s update=%s stderr=%s",
        result.returncode,
        npm_log.exists(),
        update_marker.exists(),
        (result.stderr or "").strip()[:200],
    )
    assert result.returncode == 0, result.stderr
    assert "@apify/mcpc" in npm_log.read_text()
    assert update_marker.is_file()
