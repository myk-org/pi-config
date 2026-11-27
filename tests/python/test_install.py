"""Regression tests for installer Vertex sources and settings detection."""

from __future__ import annotations

import importlib
import json
import multiprocessing
import os
import subprocess
import sys
import tempfile
import threading
import time
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


def _publish_trail_worker(
    prefix_raw: str,
    marker: str,
    inside: Any,
    release: Any,
    results: Any,
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = Path(prefix_raw)
    trail_prefix = prefix / "lib/trail-prefix"
    trail_bin = prefix / "bin/trail"
    stage = trail_prefix.parent / f".trail-prefix-{marker}"
    stage.mkdir()
    (stage / "marker").write_text(marker)
    (stage / "bin").mkdir()
    (stage / "bin/trail").write_text(marker)
    replace = install.os.replace

    def controlled_replace(source: Path, destination: Path) -> None:
        if Path(source) == stage:
            inside.set()
            if release is not None and not release.wait(5):
                raise TimeoutError("publication pause timed out")
        replace(source, destination)

    install.os.replace = controlled_replace
    try:
        install._publish_trail(stage, trail_prefix, trail_bin, prefix / ".trail-install.lock")
        results.put((marker, None))
    except BaseException as exc:
        results.put((marker, repr(exc)))


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
    assert MYK_PI_TOOLS_INSTALL_CMD == "uv tool install --python 3.14 --upgrade myk-pi-tools"
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
    assert r'"\"${legacy_marker}\""' in text


def test_install_py_has_no_pi_config_git_commands() -> None:
    text = (REPO / "scripts/install.py").read_text()
    assert f"pi install {PI_CONFIG_GIT}" not in text
    assert f"pi install {PI_VERTEX_GIT}" not in text
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


def test_trail_native_install_uses_audited_strict_npm12_installer(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = _tool(monkeypatch, "trail")
    assert tool.install_fn
    assert not tool.install_cmd


def test_show_summary_does_not_print_unaudited_npm_install_for_failed_trail(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    tool = _tool(monkeypatch, "trail")
    install = importlib.import_module("install")
    install.show_summary(0, 1, 0, [tool])
    out = capsys.readouterr().out
    assert "re-run the installer to retry" in out
    assert "npm install -g @trailhq/trail-code" not in out


def test_user_facing_myk_pi_tools_hints_specify_python_314() -> None:
    for rel in (
        "extensions/orchestrator/session-validation.ts",
        "docs/cli-reference.md",
        "README.md",
        "docs/quickstart.md",
    ):
        assert MYK_PI_TOOLS_INSTALL_CMD in (REPO / rel).read_text(), rel


def _write_package(path: Path, manifest: dict[str, Any]) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "package.json").write_text(json.dumps(manifest))


def test_trail_script_audit_includes_only_reachable_lifecycle_packages(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native-dependency": "1"}})
    _write_package(
        root / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )
    _write_package(root / "node_modules/unrelated", {"name": "unrelated", "scripts": {"install": "bad"}})

    assert install._install_script_packages(root, tmp_path / "node_modules") == ["native-dependency"]


def test_trail_script_audit_finds_fully_hoisted_required_dependency(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    assert install._install_script_packages(root, tmp_path / "node_modules") == ["native-dependency"]


def test_trail_script_audit_ignores_omitted_optional_dependency(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "optionalDependencies": {"other-platform": "1"}})

    assert install._install_script_packages(root, tmp_path / "node_modules") == []


def test_trail_script_audit_rejects_missing_required_dependency(tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"required": "1"}})

    with pytest.raises(FileNotFoundError, match="required"):
        install._install_script_packages(root, tmp_path / "node_modules")


def test_trail_script_audit_standalone_fallback_without_sibling_auditor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    standalone_script = tmp_path / "standalone/install.py"
    standalone_script.parent.mkdir(parents=True)
    standalone_script.write_text("# standalone\n")
    monkeypatch.setattr(install, "__file__", str(standalone_script))

    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    assert install._install_script_packages(root, tmp_path / "node_modules") == ["native-dependency"]


def _run_trail_auditor(root: Path, *, debug: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ | {
        "HOME": str(root.parents[2]),
        "PI_LOG_TRAIL_INSTALL": "debug" if debug else "off",
    }
    return subprocess.run(
        ["node", str(REPO / "scripts/trail-allow-scripts.mjs"), str(root), str(root.parents[1])],
        capture_output=True,
        text=True,
        env=env,
    )


def _trail_auditor_log(root: Path) -> str:
    return (root.parents[2] / ".pi/logs/trail-install/install.log").read_text()


def test_docker_trail_auditor_finds_fully_hoisted_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    result = _run_trail_auditor(root)
    assert result.returncode == 0
    assert result.stdout == "native-dependency"
    assert result.stderr == ""


def test_docker_trail_auditor_logs_resolved_dependency_when_debug_enabled(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native-dependency": "1"}})
    _write_package(
        tmp_path / "node_modules/native-dependency",
        {"name": "native-dependency", "scripts": {"install": "build"}},
    )

    _run_trail_auditor(root)
    log = _trail_auditor_log(root)
    assert "[debug] [trail-install]" in log
    assert '"event":"dependency_resolved"' in log
    assert '"dependency":"native-dependency"' in log


def test_docker_trail_auditor_redacts_paths_from_debug_log(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"dependency": "1"}})
    _write_package(root / "node_modules/dependency", {"name": "dependency"})

    _run_trail_auditor(root)
    assert str(tmp_path) not in _trail_auditor_log(root)


def test_docker_trail_auditor_debug_logging_is_disabled_by_default(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"dependency": "1"}})
    _write_package(root / "node_modules/dependency", {"name": "dependency"})

    result = _run_trail_auditor(root, debug=False)
    assert result.returncode == 0
    assert result.stderr == ""
    assert not (root.parents[2] / ".pi/logs/trail-install/install.log").exists()


def test_docker_trail_auditor_ignores_omitted_optional_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "optionalDependencies": {"other-platform": "1"}})

    result = _run_trail_auditor(root)
    assert result.returncode == 0


def test_docker_trail_auditor_rejects_missing_required_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"required": "1"}})

    result = _run_trail_auditor(root)
    assert result.returncode != 0
    assert "required Trail dependency is not installed: required" in result.stderr


def test_docker_trail_auditor_logs_unresolved_dependency(tmp_path: Path) -> None:
    root = tmp_path / "node_modules/@trailhq/trail-code"
    _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"required": "1"}})

    _run_trail_auditor(root)
    log = _trail_auditor_log(root)
    assert '"event":"dependency_unresolved"' in log
    assert '"dependency":"required"' in log


def _successful_trail_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, list[list[str]], list[Path], set[str]]:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    calls: list[list[str]] = []
    stages: list[Path] = []
    observations: set[str] = set()
    real_run = subprocess.run

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if cmd == ["npm", "prefix", "-g"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=str(prefix))
        if len(cmd) >= 2 and cmd[0] == "node" and cmd[1].endswith("trail-allow-scripts.mjs"):
            return real_run(cmd, **kwargs)
        if cmd[:3] == ["npm", "install", "-g"]:
            stage = Path(cmd[cmd.index("--prefix") + 1])
            stages.append(stage)
            if len(stages) == 2:
                if not stages[0].exists():
                    observations.add("audit-cleaned")
                if (stage / "lib").is_dir():
                    observations.add("stage-prepared")
            root = stage / "lib/node_modules/@trailhq/trail-code"
            _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native": "1"}})
            _write_package(stage / "lib/node_modules/native", {"name": "native", "scripts": {"install": "build"}})
            (stage / "bin").mkdir()
            (stage / "bin/trail").write_text("#!/bin/sh\n")
        elif cmd[-1:] == ["--version"] and not (prefix / "lib/trail-prefix").exists():
            observations.add("verified-before-publication")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "12.0.2")
    monkeypatch.setattr(install.subprocess, "run", run)
    install.install_trail()
    return prefix, calls, stages, observations


def test_trail_native_install_uses_two_fresh_prefixes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _prefix, _calls, stages, observations = _successful_trail_install(tmp_path, monkeypatch)
    assert stages[0] != stages[1]
    assert not stages[0].exists()
    assert {"audit-cleaned", "stage-prepared"} <= observations


def test_trail_native_install_preserves_secure_npm_commands(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _prefix, calls, stages, _observations = _successful_trail_install(tmp_path, monkeypatch)
    assert calls[0] == ["npm", "prefix", "-g"]
    audit_cmd, auditor_cmd, install_cmd = calls[1:4]
    assert audit_cmd[5:] == ["@trailhq/trail-code@latest", "--ignore-scripts"]
    assert auditor_cmd[0] == "node"
    assert auditor_cmd[1].endswith("trail-allow-scripts.mjs")
    assert install_cmd == [
        "npm",
        "install",
        "-g",
        "--prefix",
        str(stages[1]),
        "@trailhq/trail-code@latest",
        "--allow-scripts=native",
        "--strict-allow-scripts",
    ]


def test_trail_native_install_publishes_verified_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    prefix, calls, stages, observations = _successful_trail_install(tmp_path, monkeypatch)
    published = prefix / "lib/trail-prefix"
    assert (published / "lib/node_modules/@trailhq/trail-code/package.json").is_file()
    assert (prefix / "bin/trail").readlink() == Path("../lib/trail-prefix/bin/trail")
    assert calls[4] == [str(stages[1] / "bin/trail"), "--version"]
    assert "verified-before-publication" in observations


def _failed_second_trail_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, list[Path]]:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    completed = prefix / "lib/trail-prefix"
    completed.mkdir(parents=True)
    (completed / "marker").write_text("old")
    trail_bin = prefix / "bin/trail"
    trail_bin.parent.mkdir(parents=True)
    trail_bin.symlink_to("../lib/trail-prefix/bin/trail")
    stages: list[Path] = []
    real_run = subprocess.run

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if cmd == ["npm", "prefix", "-g"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=str(prefix))
        if len(cmd) >= 2 and cmd[0] == "node" and cmd[1].endswith("trail-allow-scripts.mjs"):
            return real_run(cmd, **kwargs)
        if cmd[:3] == ["npm", "install", "-g"]:
            stage = Path(cmd[cmd.index("--prefix") + 1])
            stages.append(stage)
            if len(stages) == 2:
                raise subprocess.CalledProcessError(1, cmd)
            root = stage / "lib/node_modules/@trailhq/trail-code"
            _write_package(root, {"name": "@trailhq/trail-code", "scripts": {"install": "build"}})
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "12.0.2")
    monkeypatch.setattr(install.subprocess, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        install.install_trail()
    return completed, trail_bin, stages


def test_trail_native_install_cleans_stages_when_second_install_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _completed, _trail_bin, stages = _failed_second_trail_install(tmp_path, monkeypatch)
    assert len(stages) == 2
    assert all(not stage.exists() for stage in stages)


def test_trail_native_install_keeps_published_install_when_second_install_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    completed, trail_bin, _stages = _failed_second_trail_install(tmp_path, monkeypatch)
    assert (completed / "marker").read_text() == "old"
    assert trail_bin.readlink() == Path("../lib/trail-prefix/bin/trail")


@pytest.mark.parametrize("prefix_output", ["", ".", "relative/prefix", "/"])
def test_trail_native_install_rejects_unsafe_npm_prefix(
    prefix_output: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.chdir(tmp_path)
    completed = tmp_path / "lib/trail-prefix"
    completed.mkdir(parents=True)
    (completed / "marker").write_text("old")
    trail_bin = tmp_path / "bin/trail"
    trail_bin.parent.mkdir(parents=True)
    trail_bin.symlink_to("../lib/trail-prefix/bin/trail")

    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "12.0.2")
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=prefix_output),
    )

    with pytest.raises(RuntimeError, match="safe absolute path"):
        install.install_trail()

    assert (completed / "marker").read_text() == "old"
    assert trail_bin.readlink() == Path("../lib/trail-prefix/bin/trail")


def test_dead_npm_global_prefix_helper_is_removed() -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    assert not hasattr(install, "_npm_global_prefix")


def test_npm_prefix_validation_rejects_empty_output_before_resolving(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=""),
    )
    monkeypatch.setattr(Path, "resolve", lambda _path: pytest.fail("empty prefix was resolved"))

    with pytest.raises(RuntimeError, match="safe absolute path"):
        install._ensure_writable_npm_prefix()


def test_npm_prefix_validation_accepts_writable_home_descendant(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    prefix = home / ".npm-global"
    home.mkdir()
    monkeypatch.chdir(home)
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=str(prefix)),
    )

    assert install._ensure_writable_npm_prefix() == prefix


@pytest.mark.parametrize("name", ["temporary", "custom"])
def test_npm_prefix_validation_accepts_absolute_writable_prefix(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / name
    prefix.mkdir()
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=str(prefix)),
    )

    assert install._ensure_writable_npm_prefix() == prefix


def test_npm_prefix_validation_rejects_current_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=str(tmp_path)),
    )

    with pytest.raises(RuntimeError, match="safe absolute path"):
        install._ensure_writable_npm_prefix()


def test_npm_prefix_validation_rejects_regular_file_ancestor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    ancestor = tmp_path / "file"
    ancestor.write_text("not a directory")
    prefix = ancestor / "child"
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=str(prefix)),
    )

    with pytest.raises(RuntimeError, match="safe absolute path"):
        install._ensure_writable_npm_prefix()


def test_npm_prefix_validation_reports_unwritable_prefix_and_rejects_unwritable_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    home.mkdir()
    prefix = tmp_path / "custom"
    monkeypatch.setattr(install, "HOME", home)
    monkeypatch.setattr(install.os, "access", lambda _path, _mode: False)

    resolved, writable = install._validate_npm_prefix(str(prefix))
    assert resolved == prefix.resolve()
    assert writable is False

    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0, stdout=str(prefix)),
    )
    with pytest.raises(RuntimeError, match="safe absolute path"):
        install._ensure_writable_npm_prefix()


def test_trail_native_install_checks_npm_prefix_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "12.0.2")

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        assert cmd == ["npm", "prefix", "-g"]
        assert kwargs["check"] is True
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(install.subprocess, "run", run)

    with pytest.raises(subprocess.CalledProcessError):
        install.install_trail()

    assert not (tmp_path / "lib/trail-prefix").exists()


def test_trail_publication_restores_previous_install_when_link_replace_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    trail_prefix = prefix / "lib/trail-prefix"
    trail_bin = prefix / "bin/trail"
    trail_prefix.mkdir(parents=True)
    (trail_prefix / "marker").write_text("old")
    trail_bin.parent.mkdir(parents=True)
    trail_bin.symlink_to("../lib/trail-prefix/bin/trail")
    stage = Path(tempfile.mkdtemp(prefix=".trail-prefix-", dir=trail_prefix.parent))
    (stage / "marker").write_text("new")
    replace = install.os.replace

    def fail_link_replace(source: Path, destination: Path) -> None:
        if destination == trail_bin:
            raise OSError("link publication failed")
        replace(source, destination)

    monkeypatch.setattr(install.os, "replace", fail_link_replace)

    with pytest.raises(OSError, match="link publication failed"):
        install._publish_trail(stage, trail_prefix, trail_bin, prefix / ".trail-install.lock")

    assert (trail_prefix / "marker").read_text() == "old"
    assert trail_bin.readlink() == Path("../lib/trail-prefix/bin/trail")
    artifacts = (
        stage,
        stage.with_name(f"{stage.name}.previous"),
        trail_bin.with_name(f".{stage.name}-trail"),
    )
    assert all(not artifact.exists() and not artifact.is_symlink() for artifact in artifacts)
    assert list(trail_prefix.parent.glob(".trail-prefix-*.previous")) == []


def test_trail_publication_serializes_overlapping_attempts(tmp_path: Path) -> None:
    _stub_questionary()
    prefix = tmp_path / "global"
    trail_prefix = prefix / "lib/trail-prefix"
    trail_bin = prefix / "bin/trail"
    trail_prefix.parent.mkdir(parents=True)
    trail_bin.parent.mkdir(parents=True)
    context = multiprocessing.get_context("spawn")
    first_inside = context.Event()
    release_first = context.Event()
    second_inside = context.Event()
    results = context.Queue()

    first = context.Process(
        target=_publish_trail_worker,
        args=(str(prefix), "first", first_inside, release_first, results),
    )
    second = context.Process(
        target=_publish_trail_worker,
        args=(str(prefix), "second", second_inside, None, results),
    )
    first.start()
    assert first_inside.wait(5)
    second.start()
    second_inspected_shared_state = second_inside.wait(1)
    release_first.set()
    first.join(5)
    second.join(5)

    assert not second_inspected_shared_state
    assert first.exitcode == second.exitcode == 0
    assert sorted(results.get(timeout=1) for _ in range(2)) == [("first", None), ("second", None)]
    assert (trail_prefix / "marker").read_text() == "second"
    assert trail_bin.readlink() == Path("../lib/trail-prefix/bin/trail")
    assert trail_bin.resolve().read_text() == "second"
    assert list(trail_prefix.parent.glob(".trail-prefix-*")) == []


def test_publication_lock_emits_structured_lifecycle_diagnostics(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    caplog.set_level("DEBUG", logger="install")
    lock_path = tmp_path / "secret-lock-path"

    with install._publication_lock(lock_path):
        pass

    messages = [record.getMessage() for record in caplog.records]
    assert [
        f"event={event}" in message for event, message in zip(("acquire", "acquired", "release"), messages, strict=True)
    ] == [
        True,
        True,
        True,
    ]
    assert all(f"platform={install.SYSTEM}" in message and "lock_id=" in message for message in messages)
    assert all(str(lock_path) not in message for message in messages)


def test_publication_lock_emits_structured_failure_diagnostic(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")

    class Fcntl:
        LOCK_EX = 1
        LOCK_UN = 2

        @staticmethod
        def flock(_lock: Any, _mode: int) -> None:
            raise OSError("lock failed")

    monkeypatch.setitem(sys.modules, "fcntl", Fcntl)
    monkeypatch.setattr(install, "SYSTEM", "Linux")
    caplog.set_level("DEBUG", logger="install")
    lock_path = tmp_path / "secret-lock-path"

    with pytest.raises(OSError, match="lock failed"), install._publication_lock(lock_path):
        pass

    message = caplog.records[-1].getMessage()
    assert "event=failure" in message
    assert "phase=acquire" in message
    assert "platform=Linux" in message
    assert "lock_id=" in message
    assert str(lock_path) not in message


def test_windows_lock_serializes_contention(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    locked = threading.Lock()

    class Msvcrt:
        LK_LOCK = 1
        LK_UNLCK = 2

        @staticmethod
        def locking(_fd: int, mode: int, _size: int) -> None:
            (locked.acquire if mode == Msvcrt.LK_LOCK else locked.release)()

    monkeypatch.setitem(sys.modules, "msvcrt", Msvcrt)
    monkeypatch.setattr(install, "SYSTEM", "Windows")
    first_inside = threading.Event()
    release_first = threading.Event()
    second_inside = threading.Event()

    def hold(inside: threading.Event, release: threading.Event | None) -> None:
        with install._publication_lock(tmp_path / "lock"):
            inside.set()
            if release is not None:
                assert release.wait(5)

    first = threading.Thread(target=hold, args=(first_inside, release_first))
    second = threading.Thread(target=hold, args=(second_inside, None))
    first.start()
    assert first_inside.wait(5)
    second.start()
    time.sleep(0.1)
    assert not second_inside.is_set()
    release_first.set()
    first.join(5)
    second.join(5)

    assert second_inside.is_set()


def test_windows_lock_releases_acquired_lock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    calls: list[int] = []

    class Msvcrt:
        LK_LOCK = 1
        LK_UNLCK = 2

        @staticmethod
        def locking(_fd: int, mode: int, _size: int) -> None:
            calls.append(mode)

    monkeypatch.setitem(sys.modules, "msvcrt", Msvcrt)
    monkeypatch.setattr(install, "SYSTEM", "Windows")

    with install._publication_lock(tmp_path / "lock"):
        pass

    assert calls == [Msvcrt.LK_LOCK, Msvcrt.LK_UNLCK]


def test_trail_publication_rolls_back_with_windows_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    trail_prefix = prefix / "lib/trail-prefix"
    trail_bin = prefix / "bin/trail"
    trail_prefix.mkdir(parents=True)
    (trail_prefix / "marker").write_text("old")
    trail_bin.parent.mkdir(parents=True)
    monkeypatch.setattr(Path, "symlink_to", lambda _self, _target: None)
    stage = trail_prefix.parent / ".trail-prefix-new"
    stage.mkdir()
    (stage / "marker").write_text("new")
    replace = install.os.replace

    class Msvcrt:
        LK_LOCK = 1
        LK_UNLCK = 2

        @staticmethod
        def locking(_fd: int, _mode: int, _size: int) -> None:
            pass

    def fail_link_replace(source: Path, destination: Path) -> None:
        if destination == trail_bin:
            raise OSError("link publication failed")
        replace(source, destination)

    monkeypatch.setitem(sys.modules, "msvcrt", Msvcrt)
    monkeypatch.setattr(install, "SYSTEM", "Windows")
    monkeypatch.setattr(install.os, "replace", fail_link_replace)

    with pytest.raises(OSError, match="link publication failed"):
        install._publish_trail(stage, trail_prefix, trail_bin, prefix / ".trail-install.lock")

    assert (trail_prefix / "marker").read_text() == "old"
    assert not stage.exists()
    assert not stage.with_name(f"{stage.name}.previous").exists()


def test_trail_native_install_checks_node_gyp_prerequisites(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(install, "SYSTEM", "Linux")
    monkeypatch.setattr(install.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(install.shutil, "which", lambda name: None if name == "make" else f"/usr/bin/{name}")
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 1),
    )
    with pytest.raises(RuntimeError, match=r"make.*sudo dnf install -y make gcc-c\+\+"):
        install.install_trail()


def test_install_py_runs_standalone_without_install_sources(tmp_path: Path) -> None:
    standalone_dir = tmp_path / "standalone"
    standalone_dir.mkdir()
    standalone_script = standalone_dir / "install.py"
    standalone_script.write_text((REPO / "scripts/install.py").read_text())

    # Stub questionary in a separate dir so standalone import runs without scripts/ on sys.path.
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    (stub_dir / "questionary.py").write_text(
        "class Choice:\n    def __init__(self, *a, **kw): pass\n"
        "def Style(*a, **kw): return None\n"
        "def confirm(*a, **kw): return None\n"
        "def checkbox(*a, **kw): return None\n"
    )

    env = os.environ | {"PYTHONPATH": str(stub_dir)}
    help_proc = subprocess.run(
        [sys.executable, str(standalone_script), "--help"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=env,
    )
    assert help_proc.returncode == 0
    assert "--all" in help_proc.stdout

    # Verify standalone fallback constants & helpers stay 100% in sync with install_sources.py.
    legacy_cfg = '{"packages":["git:github.com/myk-org/pi-config"]}'
    legacy_vtx = '{"packages":["git:github.com/myk-org/pi-config/packages/pi-vertex-claude"]}'
    probe = "\n".join([
        "import importlib.util, json, sys",
        f"spec = importlib.util.spec_from_file_location('standalone_install', {str(standalone_script)!r})",
        "mod = importlib.util.module_from_spec(spec)",
        "sys.modules[spec.name] = mod",
        "spec.loader.exec_module(mod)",
        f"legacy_cfg = {legacy_cfg!r}",
        f"legacy_vtx = {legacy_vtx!r}",
        "print(json.dumps({",
        "  'MYK_PI_TOOLS_INSTALL_CMD': mod.MYK_PI_TOOLS_INSTALL_CMD,",
        "  'PI_CONFIG_NPM': mod.PI_CONFIG_NPM,",
        "  'PI_VERTEX_NPM': mod.PI_VERTEX_NPM,",
        "  'cfg_migrate': mod.should_migrate_pi_config_to_npm(legacy_cfg),",
        "  'cfg_not_vtx': mod.should_migrate_pi_config_to_npm(legacy_vtx),",
        "  'cfg_cmd': mod.pi_config_pi_cmd(False, legacy_cfg),",
        "  'vtx_migrate': mod.should_migrate_vertex_to_npm(legacy_vtx),",
        "  'vtx_cmd': mod.vertex_pi_cmd(False, legacy_vtx),",
        "}))",
    ])
    sync_proc = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=env,
    )
    assert sync_proc.returncode == 0, sync_proc.stderr
    data = json.loads(sync_proc.stdout)
    assert data == {
        "MYK_PI_TOOLS_INSTALL_CMD": MYK_PI_TOOLS_INSTALL_CMD,
        "PI_CONFIG_NPM": PI_CONFIG_NPM,
        "PI_VERTEX_NPM": PI_VERTEX_NPM,
        "cfg_migrate": should_migrate_pi_config_to_npm(legacy_cfg),
        "cfg_not_vtx": should_migrate_pi_config_to_npm(legacy_vtx),
        "cfg_cmd": pi_config_pi_cmd(False, legacy_cfg),
        "vtx_migrate": should_migrate_vertex_to_npm(legacy_vtx),
        "vtx_cmd": vertex_pi_cmd(False, legacy_vtx),
    }


def test_ensure_writable_npm_prefix_falls_back_to_user_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    home.mkdir()
    ro_prefix = tmp_path / "usr-local"
    ro_prefix.mkdir()
    calls: list[list[str]] = []

    def run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if cmd == ["npm", "prefix", "-g"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=str(ro_prefix))
        return subprocess.CompletedProcess(cmd, 0, stdout="")

    real_access = os.access
    monkeypatch.setattr(install, "HOME", home)
    monkeypatch.setattr(install, "_NPM_GLOBAL_BIN_NOTICE", None)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr(install.subprocess, "run", run)
    monkeypatch.setattr(
        install.os,
        "access",
        lambda path, mode: False if Path(path).resolve() == ro_prefix.resolve() else real_access(path, mode),
    )

    result = install._ensure_writable_npm_prefix()
    expected = (home / ".npm-global").resolve()
    assert result == expected
    assert (expected / "bin").is_dir()
    assert ["npm", "config", "set", "prefix", str(home / ".npm-global")] in calls
    assert os.environ["PATH"].split(os.pathsep)[0] == str(expected / "bin")
    assert install._NPM_GLOBAL_BIN_NOTICE == expected / "bin"

    install.show_summary(1, 0, 0)
    out = capsys.readouterr().out
    assert str(expected / "bin") in out


def test_step4_uses_agent_browser_chromium_and_binary_detection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(install, "HOME", home)
    # Empty broken dirs must NOT trigger false-positive installed status.
    (home / ".cache/ms-playwright/chromium-1234").mkdir(parents=True)
    (home / ".agent-browser/browsers/chrome-134").mkdir(parents=True)
    assert install._is_chromium_installed() is False

    # Step 4 must be enabled when Node is present even before agent-browser is installed.
    monkeypatch.setattr(install.shutil, "which", lambda _name: None)
    steps = install.build_steps(_prereqs(node=True))
    browser_tool = steps[3].tools[0]
    assert browser_tool.install_cmd == "agent-browser install --with-deps"
    assert browser_tool.install_fn is install.install_browser
    assert browser_tool.disabled == ""
    assert browser_tool.installed is False

    # An actual executable Chrome binary inside agent-browser cache must be detected.
    chrome_bin = home / ".agent-browser/browsers/chrome-134/chrome-linux64/chrome"
    chrome_bin.parent.mkdir(parents=True)
    chrome_bin.write_text("#!/bin/sh\n")
    chrome_bin.chmod(0o755)
    assert install._is_chromium_installed() is True


def test_is_chromium_installed_rejects_broken_binary_exiting_127(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    broken = home / ".cache/ms-playwright/chromium-1234/chrome-linux/chrome"
    broken.parent.mkdir(parents=True)
    broken.write_text("#!/bin/sh\nexit 127\n")
    broken.chmod(0o755)
    monkeypatch.setattr(install, "HOME", home)
    assert install._is_chromium_installed() is False


def test_install_browser_runs_agent_browser_with_deps_from_npm_global_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    ab = home / ".npm-global/bin/agent-browser"
    ab.parent.mkdir(parents=True)
    ab.write_text("#!/bin/sh\n")
    ab.chmod(0o755)
    monkeypatch.setattr(install, "HOME", home)
    monkeypatch.setattr(install.shutil, "which", lambda _name: None)
    seen: list[list[str]] = []

    def run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(install.subprocess, "run", run)
    install.install_browser()
    assert seen == [[str(ab), "install", "--with-deps"]]


def test_install_browser_resolves_configured_npm_prefix_not_on_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    home.mkdir()
    custom_prefix = tmp_path / "custom-npm"
    ab = custom_prefix / "bin/agent-browser"
    ab.parent.mkdir(parents=True)
    ab.write_text("#!/bin/sh\n")
    ab.chmod(0o755)
    monkeypatch.setattr(install, "HOME", home)
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/npm" if name == "npm" else None)
    monkeypatch.setattr(install, "_run_quiet", lambda cmd: str(custom_prefix) if cmd == ["npm", "prefix", "-g"] else "")
    seen: list[list[str]] = []

    def run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(install.subprocess, "run", run)
    install.install_browser()
    assert seen == [[str(ab), "install", "--with-deps"]]


def test_install_browser_auto_installs_agent_browser_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    home = tmp_path / "home"
    home.mkdir()
    installed_bin = home / ".npm-global/bin/agent-browser"
    monkeypatch.setattr(install, "HOME", home)
    monkeypatch.setattr(install.shutil, "which", lambda _name: None)
    events: list[Any] = []

    def fake_install_agent_browser() -> None:
        events.append("install_agent_browser")
        installed_bin.parent.mkdir(parents=True, exist_ok=True)
        installed_bin.write_text("#!/bin/sh\n")
        installed_bin.chmod(0o755)

    def fake_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        events.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(install, "install_agent_browser", fake_install_agent_browser)
    monkeypatch.setattr(install.subprocess, "run", fake_run)
    install.install_browser()
    assert events == ["install_agent_browser", [str(installed_bin), "install", "--with-deps"]]


def test_trail_native_install_npm10_uses_ignore_scripts_and_scoped_rebuild(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    prefix = tmp_path / "global"
    calls: list[list[str]] = []
    stages: list[Path] = []
    real_run = subprocess.run

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if cmd == ["npm", "prefix", "-g"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=str(prefix))
        if len(cmd) >= 2 and cmd[0] == "node" and cmd[1].endswith("trail-allow-scripts.mjs"):
            return real_run(cmd, **kwargs)
        if cmd[:3] == ["npm", "install", "-g"]:
            stage = Path(cmd[cmd.index("--prefix") + 1])
            stages.append(stage)
            root = stage / "lib/node_modules/@trailhq/trail-code"
            _write_package(root, {"name": "@trailhq/trail-code", "dependencies": {"native": "1"}})
            _write_package(stage / "lib/node_modules/native", {"name": "native", "scripts": {"install": "build"}})
            (stage / "bin").mkdir()
            (stage / "bin/trail").write_text("#!/bin/sh\n")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "10.9.4")
    monkeypatch.setattr(install.subprocess, "run", run)
    install.install_trail()

    assert calls[0] == ["npm", "prefix", "-g"]
    assert calls[1][5:] == ["@trailhq/trail-code@latest", "--ignore-scripts"]
    assert calls[3] == [
        "npm",
        "install",
        "-g",
        "--prefix",
        str(stages[1]),
        "@trailhq/trail-code@latest",
        "--ignore-scripts",
    ]
    assert calls[4] == ["npm", "rebuild", "-g", "--prefix", str(stages[1]), "native"]
    assert calls[5] == [str(stages[1] / "bin/trail"), "--version"]
    assert (prefix / "bin/trail").readlink() == Path("../lib/trail-prefix/bin/trail")


def test_trail_native_install_rejects_npm_below_10(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(install.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "9.8.1")
    with pytest.raises(RuntimeError, match="npm 10\\+"):
        install.install_trail()


def test_trail_prereqs_auto_installs_build_tools_with_passwordless_sudo(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    installed_build_tools = {"ok": False}
    calls: list[list[str]] = []

    def fake_which(name: str) -> str | None:
        if name in {"make", "g++"} and not installed_build_tools["ok"]:
            return None
        if name == "apt-get":
            return None
        return f"/usr/bin/{name}"

    def fake_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if cmd == ["sudo", "-n", "dnf", "install", "-y", "make", "gcc-c++"]:
            installed_build_tools["ok"] = True
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(install, "SYSTEM", "Linux")
    monkeypatch.setattr(install.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(install.shutil, "which", fake_which)
    monkeypatch.setattr(install.subprocess, "run", fake_run)

    install._ensure_trail_prerequisites()
    assert calls == [
        ["sudo", "-n", "true"],
        ["sudo", "-n", "dnf", "install", "-y", "make", "gcc-c++"],
    ]


def test_trail_prereqs_surfaces_auto_install_failure_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")

    def fake_which(name: str) -> str | None:
        if name in {"make", "g++", "apt-get"}:
            return None
        return f"/usr/bin/{name}"

    def fake_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if cmd == ["sudo", "-n", "true"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise subprocess.CalledProcessError(1, cmd, stderr="Error: Unable to find a match: gcc-c++\n")

    monkeypatch.setattr(install, "SYSTEM", "Linux")
    monkeypatch.setattr(install.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(install.shutil, "which", fake_which)
    monkeypatch.setattr(install.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="auto-install failed: Error: Unable to find a match: gcc-c\\+\\+"):
        install._ensure_trail_prerequisites()


def test_add_to_gitignore_uses_exact_line_match(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    gi = tmp_path / "ignore"
    gi.write_text(".pi/memory/")  # substring of ".pi/" and no trailing newline
    monkeypatch.setattr(install, "_gitignore_path", lambda: str(gi))
    monkeypatch.setattr(install.shutil, "which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 0),
    )

    steps = install.build_steps(_prereqs())
    pi_tool = next(t for t in steps[4].tools if t.name == ".pi/ in gitignore")
    assert pi_tool.installed is False
    pi_tool.install_fn()
    lines = gi.read_text().splitlines()
    assert lines == [".pi/memory/", ".pi/"]


def test_update_pi_runs_with_extensions_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    seen: list[Any] = []

    def run(cmd: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(install.subprocess, "run", run)
    assert install.update_pi({"pi": True}) is True
    assert seen == [["pi", "update", "--extensions"]]


def test_update_pi_returns_false_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(
        install.subprocess,
        "run",
        lambda cmd, **_kwargs: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="network error"),
    )
    assert install.update_pi({"pi": True}) is False


def test_check_prereqs_quiet_exits_nonzero_when_pi_missing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    monkeypatch.setattr(install.shutil, "which", lambda name: None if name == "pi" else f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_run_quiet", lambda _cmd: "v22.22.0")

    with pytest.raises(SystemExit) as exc_info:
        install.check_prereqs_quiet()

    assert exc_info.value.code == 1
    assert "Cannot continue without pi." in capsys.readouterr().out


def test_main_exits_nonzero_when_tool_install_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    failing_tool = install.Tool(
        "demo",
        "Demo tool",
        installed=False,
        disabled="",
        install_cmd="false",
        install_fn=lambda: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    monkeypatch.setattr(sys, "argv", ["install.py", "--all"])
    monkeypatch.setattr(install, "check_prereqs_quiet", lambda: _prereqs())
    monkeypatch.setattr(install, "build_steps", lambda _p: [install.Step("x", "S", "D", [failing_tool])])
    monkeypatch.setattr(install, "update_pi", lambda _p: True)

    with pytest.raises(SystemExit) as exc_info:
        install.main()

    assert exc_info.value.code == 1
    out = capsys.readouterr().out
    assert "Failed:    1" in out


def test_main_exits_nonzero_when_update_pi_fails_after_tool_installs(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    ok_tool = install.Tool("demo", "Demo tool", installed=False, disabled="", install_fn=lambda: None)
    monkeypatch.setattr(sys, "argv", ["install.py", "--all"])
    monkeypatch.setattr(install, "check_prereqs_quiet", lambda: _prereqs())
    monkeypatch.setattr(install, "build_steps", lambda _p: [install.Step("x", "S", "D", [ok_tool])])
    monkeypatch.setattr(install, "update_pi", lambda _p: False)

    with pytest.raises(SystemExit) as exc_info:
        install.main()

    assert exc_info.value.code == 1


def test_main_exits_nonzero_when_update_pi_fails_with_no_selections(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    done_tool = install.Tool("demo", "Demo tool", installed=True, disabled="")
    monkeypatch.setattr(sys, "argv", ["install.py", "--all"])
    monkeypatch.setattr(install, "check_prereqs_quiet", lambda: _prereqs())
    monkeypatch.setattr(install, "build_steps", lambda _p: [install.Step("x", "S", "D", [done_tool])])
    monkeypatch.setattr(install, "update_pi", lambda _p: False)

    with pytest.raises(SystemExit) as exc_info:
        install.main()

    assert exc_info.value.code == 1


def test_meaningful_error_lines_filters_npm_boilerplate_and_caps_at_five() -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    stderr = "\n".join([
        "npm error line 1",
        "npm error line 2",
        "npm error code EACCES",
        "npm error syscall mkdir",
        "npm error path /usr/local/lib/node_modules",
        "npm error errno -13",
        "npm error permission denied",
        "npm error A complete log of this run can be found in:",
        "npm error     /home/user/.npm/_logs/2026-04-01-debug-0.log",
        "",
    ])
    lines = install._meaningful_error_lines(stderr)
    assert lines == [
        "npm error code EACCES",
        "npm error syscall mkdir",
        "npm error path /usr/local/lib/node_modules",
        "npm error errno -13",
        "npm error permission denied",
    ]


def test_install_logger_suppresses_last_resort_while_propagating() -> None:
    _stub_questionary()
    install = importlib.import_module("install")
    import logging

    assert any(isinstance(h, logging.NullHandler) for h in install.log.handlers)
    assert install.log.propagate is True


def test_entrypoint_does_not_install_mcpc() -> None:
    """MCP is pi's builtin:mcp — no external mcpc binary (see #848)."""
    text = (REPO / "entrypoint.sh").read_text()
    assert "@apify/mcpc" not in text
    assert "npm install -g @apify/mcpc" not in text


def test_entrypoint_installs_required_npm_packages() -> None:
    """pi stays required; a failure aborts container start."""
    text = (REPO / "entrypoint.sh").read_text()
    assert "npm install -g @earendil-works/pi-coding-agent" in text
    assert "npm install -g acpx" not in text
