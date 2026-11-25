"""Tests for WT-20 Python release and shared plumbing optimizations.

Covers:
- #1275: Parallel registry lookups, cached repo window, and batched git cat-file in ReleasePlanner
- #1281: Combined gh repo/branch query and single git rev-list --left-right --count in release info
- #1291: Quiet stderr suppression in detect_version_files and silent None members in uv workspace scan
- #1297: Deduplicated TOML section bumping, PY_VERSION_RE, and single root manifest parse
- #1299: Shared release/_common.py plumbing and find_git_root(cwd) across settings/memory
"""

from __future__ import annotations

import io
import json
import logging
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from test_release_plan import build_fixture_repo, bump_poc, commit, git, make_planner, widen_poc_peers

from myk_pi_tools.release import _common, bump_scoped, bump_version, create, detect_versions, info, plan
from myk_pi_tools.release.release_map import load_release_map
from myk_pi_tools.settings import commands as settings_commands
from myk_pi_tools.utils import find_git_root


class TestReleasePlannerPerf1275:
    """#1275: Parallel lookups, cached repo window, and batched git cat-file."""

    def test_plan_runs_registry_lookups_concurrently_preserving_map_order(self, tmp_path: Path) -> None:
        repo = build_fixture_repo(tmp_path)
        rm = load_release_map(repo)

        # 3 packages in VALID_MAP: poc (npm), tools (pypi), sidecar (npm+pypi) -> 4 lookups total.
        # All 4 must reach the barrier concurrently; serial execution would deadlock and time out.
        barrier = threading.Barrier(4, timeout=3.0)

        def concurrent_lookup(registry: str, name: str) -> str:  # noqa: ARG001
            barrier.wait()
            return "1.0.0"

        planner = plan.ReleasePlanner(repo, rm, registry_lookup=concurrent_lookup)
        plans = planner.plan()

        assert [p.name for p in plans] == [pkg.name for pkg in rm.packages]
        assert all(p.error is None for p in plans)
        assert all(not p.affected for p in plans)

    def test_repo_window_cached_across_container_rebuild_then_unmapped(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        repo = build_fixture_repo(tmp_path)
        git(repo, "tag", "v1.0.0")
        (repo / "DEVELOPMENT.md").write_text("# dev\n", encoding="utf-8")
        commit(repo, "docs: add dev", "DEVELOPMENT.md")

        git_calls: list[list[str]] = []
        real_git = plan._git

        def counting_git(repo_root: Path, args: list[str], timeout: int = 60) -> str:
            git_calls.append(list(args))
            return real_git(repo_root, args, timeout)

        monkeypatch.setattr(plan, "_git", counting_git)

        published = {
            ("npm", "poc"): "1.0.0",
            ("pypi", "tools"): "1.0.0",
            ("npm", "@org/sidecar"): "1.0.0",
            ("pypi", "sidecar-client"): "1.0.0",
        }
        planner = make_planner(repo, published)
        plans = planner.plan()
        git_calls.clear()

        container = planner.container_rebuild(plans)
        unmapped = planner.unmapped_changes()

        assert container["rebuild"] is False
        assert unmapped["files"] == ["DEVELOPMENT.md"]
        for_each_calls = [c for c in git_calls if c and c[0] == "for-each-ref"]
        diff_calls = [c for c in git_calls if c and c[0] == "diff"]
        assert len(for_each_calls) == 1
        assert len(diff_calls) == 1

    def test_repo_window_caches_errors_when_no_release_tag_exists(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        repo = build_fixture_repo(tmp_path)  # no release tags -> _last_release_tag raises
        for_each_count = 0
        real_git = plan._git

        def counting_git(repo_root: Path, args: list[str], timeout: int = 60) -> str:
            nonlocal for_each_count
            if args and args[0] == "for-each-ref":
                for_each_count += 1
            return real_git(repo_root, args, timeout)

        monkeypatch.setattr(plan, "_git", counting_git)

        published = {
            ("npm", "poc"): "1.0.0",
            ("pypi", "tools"): "1.0.0",
            ("npm", "@org/sidecar"): "1.0.0",
            ("pypi", "sidecar-client"): "1.0.0",
        }
        planner = make_planner(repo, published)
        container = planner.container_rebuild([])
        unmapped = planner.unmapped_changes()

        assert container["indeterminate"] is True
        assert unmapped["indeterminate"] is True
        assert for_each_count == 1

    def test_find_anchor_batches_blob_reads_via_single_cat_file_process(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        repo = build_fixture_repo(tmp_path)
        bump = bump_poc(repo, "2.0.0")
        # Add multiple non-version edits including UTF-8 multi-byte characters.
        for idx in range(4):
            (repo / "package.json").write_text(
                json.dumps({"name": "poc", "version": "2.0.0", "description": f"edit — #{idx} → ok"}),
                encoding="utf-8",
            )
            commit(repo, f"chore: edit {idx}", "package.json")
        widen_poc_peers(repo, "2.0.0")

        popen_cmds: list[list[str]] = []
        real_popen = subprocess.Popen

        def tracking_popen(cmd: list[str], *args: Any, **kwargs: Any) -> subprocess.Popen[Any]:
            popen_cmds.append(list(cmd))
            return real_popen(cmd, *args, **kwargs)

        monkeypatch.setattr(plan.subprocess, "Popen", tracking_popen)

        anchor = plan._find_anchor(repo, ("package.json",), "2.0.0")

        assert anchor == bump
        cat_file_cmds = [c for c in popen_cmds if "cat-file" in c and "--batch" in c]
        show_cmds = [c for c in popen_cmds if "show" in c]
        assert len(cat_file_cmds) == 1
        assert show_cmds == []

    def test_iter_file_blobs_wraps_popen_oserror(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        def failing_popen(*_args: Any, **_kwargs: Any) -> Any:
            raise FileNotFoundError("git")

        monkeypatch.setattr(plan.subprocess, "Popen", failing_popen)
        with pytest.raises(RuntimeError, match="git cat-file failed"):
            list(plan._iter_file_blobs(tmp_path, "package.json", ["deadbeef"]))

    def test_iter_file_blobs_raises_on_nonzero_git_exit(self, tmp_path: Path) -> None:
        not_a_repo = tmp_path / "empty"
        not_a_repo.mkdir()
        with pytest.raises(RuntimeError, match="git cat-file"):
            list(plan._iter_file_blobs(not_a_repo, "package.json", ["deadbeef"]))

    def test_iter_file_blobs_raises_on_unexpected_eof_mid_stream(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Simulate cat-file yielding one valid blob then abruptly closing stdout (EOF)
        # before the second commit — must raise RuntimeError rather than hiding older history.
        first_body = b'{"version": "2.0.0"}'
        stream_bytes = (
            f"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa blob {len(first_body)}\n".encode() + first_body + b"\n"
        )

        class FakeProc:
            returncode = 0

            def __init__(self) -> None:
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO(stream_bytes)

            def wait(self, timeout: float | None = None) -> int:  # noqa: ARG002
                return 0

            def kill(self) -> None:
                pass

        monkeypatch.setattr(plan.subprocess, "Popen", lambda *_a, **_k: FakeProc())
        gen = plan._iter_file_blobs(tmp_path, "package.json", ["sha1", "sha2"])
        assert next(gen) == ("sha1", '{"version": "2.0.0"}')
        with pytest.raises(RuntimeError, match="ended unexpectedly"):
            next(gen)

    def test_iter_file_blobs_enforces_streaming_timeout(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        real_popen = subprocess.Popen

        def sleeping_popen(_cmd: list[str], *args: Any, **kwargs: Any) -> subprocess.Popen[Any]:
            return real_popen([sys.executable, "-c", "import time; time.sleep(30)"], *args, **kwargs)

        monkeypatch.setattr(plan.subprocess, "Popen", sleeping_popen)
        with pytest.raises(RuntimeError, match="timed out"):
            list(plan._iter_file_blobs(tmp_path, "package.json", ["sha1"], timeout=0.05))


class TestReleaseInfoPerf1281:
    """#1281: Combined gh repo/branch query and single git rev-list --left-right --count."""

    def test_combined_gh_query_returns_repo_with_default_branch(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd: list[str], capture_stderr: bool = False, timeout: int = 60) -> tuple[int, str]:  # noqa: ARG001
            calls.append(cmd)
            return 0, json.dumps({"nameWithOwner": "myk-org/pi-config", "defaultBranchRef": {"name": "develop"}})

        monkeypatch.setattr(info, "_run_command", fake_run)

        repo, branch = info._get_repo_and_default_branch(None)
        assert repo == "myk-org/pi-config"
        assert branch == "develop"
        assert calls == [["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]]

    def test_combined_gh_query_falls_back_on_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(info, "_run_command", lambda *_a, **_k: (1, ""))
        assert info._get_repo_and_default_branch(None) == (None, "main")

        monkeypatch.setattr(info, "_run_command", lambda *_a, **_k: (0, "not-json"))
        assert info._get_repo_and_default_branch(None) == (None, "main")

    def test_explicit_repo_passed_to_gh_default_branch_lookup(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen_cmds: list[list[str]] = []

        def spy_run(cmd: list[str], capture_stderr: bool = False, timeout: int = 60) -> tuple[int, str]:  # noqa: ARG001
            seen_cmds.append(cmd)
            return 0, "trunk"

        monkeypatch.setattr(info, "_run_command", spy_run)
        assert info._get_repo_and_default_branch("org/explicit") == ("org/explicit", "trunk")
        assert seen_cmds == [
            [
                "gh",
                "repo",
                "view",
                "org/explicit",
                "--json",
                "defaultBranchRef",
                "-q",
                ".defaultBranchRef.name",
            ]
        ]

    def test_perform_validations_uses_single_left_right_rev_list(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        remote = tmp_path / "remote.git"
        local = tmp_path / "local"
        other = tmp_path / "other"

        subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
        subprocess.run(["git", "clone", str(remote), str(local)], check=True, capture_output=True)
        git(local, "config", "user.email", "test@example.com")
        git(local, "config", "user.name", "Test")
        (local / "a.txt").write_text("seed\n", encoding="utf-8")
        commit(local, "chore: seed", "a.txt")
        git(local, "push", "-u", "origin", "main")

        # Advance remote via a second clone by 2 commits (behind_remote=2).
        subprocess.run(["git", "clone", str(remote), str(other)], check=True, capture_output=True)
        git(other, "config", "user.email", "test@example.com")
        git(other, "config", "user.name", "Test")
        for idx in range(2):
            (other / f"r{idx}.txt").write_text(f"{idx}\n", encoding="utf-8")
            commit(other, f"feat: remote {idx}", f"r{idx}.txt")
        git(other, "push", "origin", "main")

        # Advance local by 3 commits (unpushed_commits=3).
        for idx in range(3):
            (local / f"l{idx}.txt").write_text(f"{idx}\n", encoding="utf-8")
            commit(local, f"fix: local {idx}", f"l{idx}.txt")

        monkeypatch.chdir(local)
        rev_list_calls: list[list[str]] = []
        real_run = info._run_command

        def spy_run(cmd: list[str], capture_stderr: bool = False, timeout: int = 60) -> tuple[int, str]:
            if len(cmd) >= 2 and cmd[0] == "git" and cmd[1] == "rev-list":
                rev_list_calls.append(cmd)
            return real_run(cmd, capture_stderr=capture_stderr, timeout=timeout)

        monkeypatch.setattr(info, "_run_command", spy_run)

        validations = info._perform_validations("main", "main")

        assert len(rev_list_calls) == 1
        assert "--left-right" in rev_list_calls[0]
        assert "--count" in rev_list_calls[0]
        assert validations.behind_remote == 2
        assert validations.unpushed_commits == 3
        assert validations.synced_with_remote is False
        assert validations.all_passed is False


class TestDetectVersionsQuietAndSingleParse1291And1297:
    """#1291 & #1297: Quiet stderr, silent None uv members, single root parse, shared bumpers."""

    def test_no_uv_workspace_emits_no_stderr_warning(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        (tmp_path / "pyproject.toml").write_text('[project]\nname = "plain"\nversion = "1.0.0"\n', encoding="utf-8")

        assert detect_versions._find_uv_workspace_members(tmp_path) == []
        assert capsys.readouterr().err == ""

    def test_malformed_uv_members_still_warns(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        (tmp_path / "pyproject.toml").write_text(
            '[project]\nname = "bad"\n[tool.uv.workspace]\nmembers = "not-a-list"\n',
            encoding="utf-8",
        )

        assert detect_versions._find_uv_workspace_members(tmp_path) == []
        assert "expected a list" in capsys.readouterr().err

    def test_detect_version_files_parses_root_manifests_once(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        (tmp_path / "pyproject.toml").write_text(
            '[project]\nname = "root"\nversion = "1.0.0"\n\n[tool.uv.workspace]\nmembers = ["packages/py"]\n',
            encoding="utf-8",
        )
        (tmp_path / "package.json").write_text(
            json.dumps({"name": "root", "version": "1.0.0", "workspaces": ["packages/js"]}),
            encoding="utf-8",
        )
        (tmp_path / "packages" / "py").mkdir(parents=True)
        (tmp_path / "packages" / "py" / "pyproject.toml").write_text(
            '[project]\nname = "py"\nversion = "2.0.0"\n', encoding="utf-8"
        )
        (tmp_path / "packages" / "js").mkdir(parents=True)
        (tmp_path / "packages" / "js" / "package.json").write_text(
            json.dumps({"name": "js", "version": "3.0.0"}), encoding="utf-8"
        )

        toml_loads = 0
        json_loads = 0
        real_toml_load = detect_versions.tomllib.load
        real_json_loads = detect_versions.json.loads

        def counting_toml_load(fh: object) -> dict[str, object]:
            nonlocal toml_loads
            if getattr(fh, "name", "") == str(tmp_path / "pyproject.toml"):
                toml_loads += 1
            return real_toml_load(fh)  # type: ignore[arg-type]

        def counting_json_loads(s: str) -> object:
            nonlocal json_loads
            parsed = real_json_loads(s)
            if isinstance(parsed, dict) and parsed.get("name") == "root":
                json_loads += 1
            return parsed

        monkeypatch.setattr(detect_versions.tomllib, "load", counting_toml_load)
        monkeypatch.setattr(detect_versions.json, "loads", counting_json_loads)

        found = detect_versions.detect_version_files(tmp_path, quiet=True)
        assert toml_loads == 1
        assert json_loads == 1
        assert {vf.path: vf.current_version for vf in found} == {
            "pyproject.toml": "1.0.0",
            "package.json": "1.0.0",
            "packages/py/pyproject.toml": "2.0.0",
            "packages/js/package.json": "3.0.0",
        }

    def test_detect_version_files_quiet_suppresses_progress_stderr(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        (tmp_path / "package.json").write_text(json.dumps({"name": "root", "version": "1.0.0"}), encoding="utf-8")

        found = detect_versions.detect_version_files(tmp_path, quiet=True)
        assert len(found) == 1
        assert capsys.readouterr().err == ""

    def test_detect_versions_run_quiet_when_not_tty(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        (tmp_path / "package.json").write_text(json.dumps({"name": "x", "version": "1.0.0"}), encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(detect_versions.sys.stderr, "isatty", lambda: False)

        detect_versions.run()
        captured = capsys.readouterr()
        assert captured.err == ""
        assert json.loads(captured.out)["count"] == 1

    def test_detect_version_files_quiet_logs_malformed_pyproject_without_stderr(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        (tmp_path / "pyproject.toml").write_text("not = [valid toml", encoding="utf-8")
        (tmp_path / "package.json").write_text(json.dumps({"name": "x", "version": "1.0.0"}), encoding="utf-8")

        with caplog.at_level(logging.WARNING, logger="myk_pi_tools.release.detect_versions"):
            found = detect_versions.detect_version_files(tmp_path, quiet=True)

        assert capsys.readouterr().err == ""
        assert [vf.path for vf in found] == ["package.json"]
        assert any("Could not read" in rec.getMessage() for rec in caplog.records)

    def test_bump_scoped_emits_no_detect_stderr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        repo = build_fixture_repo(tmp_path)
        (repo / "extensions" / "b.ts").write_text("// change\n", encoding="utf-8")
        commit(repo, "fix: change", "extensions/b.ts")
        monkeypatch.setattr(plan, "registry_version", lambda *_args: "1.0.0")

        bump_scoped.run(repo, set_versions={"poc": "1.0.1"}, as_json=True)
        captured = capsys.readouterr()
        assert "Scanning for version files" not in captured.err
        assert "Detected " not in captured.err
        assert json.loads(captured.out)["status"] == "success"

    def test_bump_toml_section_updates_pyproject_project_table(self, tmp_path: Path) -> None:
        pyproject = tmp_path / "pyproject.toml"
        pyproject.write_text(
            '[project]\nname = "a"\nversion = "1.0.0"\n\n'
            '[project.urls]\nHomepage = "x"\n\n[tool.x]\nversion = "9.9.9"\n',
            encoding="utf-8",
        )

        assert bump_version._bump_pyproject_toml(pyproject, "1.1.0") == "1.0.0"
        text = pyproject.read_text(encoding="utf-8")
        assert 'version = "1.1.0"' in text
        assert 'version = "9.9.9"' in text

    def test_bump_toml_section_updates_cargo_package_table(self, tmp_path: Path) -> None:
        cargo = tmp_path / "Cargo.toml"
        cargo.write_text(
            '[package]\nname = "b"\nversion = "0.2.0"\n\n[dependencies]\nfoo = { version = "0.1.0" }\n',
            encoding="utf-8",
        )

        assert bump_version._bump_cargo_toml(cargo, "0.3.0") == "0.2.0"
        text = cargo.read_text(encoding="utf-8")
        assert 'version = "0.3.0"' in text
        assert 'foo = { version = "0.1.0" }' in text


class TestSharedPlumbing1299:
    """#1299: Shared release/_common.py helpers and find_git_root(cwd)."""

    def test_shared_release_tag_regex_matches_semver_shapes(self) -> None:
        for valid in ("v1.2.3", "v0.0.1-rc.1", "myk-pi-tools@4.5.6", "pi-docsite@1.0.0-alpha.1"):
            assert _common.RELEASE_TAG_RE.match(valid)
            assert create._is_semver_tag(valid)
        for invalid in ("experiment", "v1.2", "1.2.3", "@1.2.3"):
            assert not _common.RELEASE_TAG_RE.match(invalid)
            assert not create._is_semver_tag(invalid)

    def test_find_git_root_resolves_nested_cwd(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        sub = repo / "nested" / "dir"
        sub.mkdir(parents=True)
        git(repo, "init")

        assert find_git_root(sub) == repo.resolve()
        assert settings_commands._resolve_repo_root(sub) == repo.resolve()

    def test_settings_resolve_repo_root_falls_back_outside_git(self, tmp_path: Path) -> None:
        plain = tmp_path / "not_a_repo"
        plain.mkdir()
        with pytest.raises(RuntimeError, match="not a git repository"):
            find_git_root(plain)
        assert settings_commands._resolve_repo_root(plain) == plain

    def test_run_git_surfaces_structured_timeout(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        def raise_timeout(*_args: Any, **_kwargs: Any) -> Any:
            raise subprocess.TimeoutExpired(cmd=["git"], timeout=1)

        monkeypatch.setattr(_common.subprocess, "run", raise_timeout)
        with pytest.raises(RuntimeError, match="git timed out"):
            _common.run_git(tmp_path, ["status"], timeout=1)

    def test_info_run_command_returns_empty_on_missing_or_timeout(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def raise_timeout(*_args: Any, **_kwargs: Any) -> Any:
            raise subprocess.TimeoutExpired(cmd=["gh"], timeout=1)

        def raise_missing(*_args: Any, **_kwargs: Any) -> Any:
            raise FileNotFoundError("gh")

        monkeypatch.setattr(_common.subprocess, "run", raise_timeout)
        assert info._run_command(["gh", "repo", "view"], capture_stderr=True, timeout=1) == (1, "")

        monkeypatch.setattr(_common.subprocess, "run", raise_missing)
        assert info._run_command(["gh", "repo", "view"], capture_stderr=True, timeout=1) == (1, "")
