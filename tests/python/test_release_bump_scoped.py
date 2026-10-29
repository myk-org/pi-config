"""Tests for `myk-pi-tools release bump-scoped` (issue #965 phase 2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_release_plan import (
    build_fixture_repo,
    commit,
    git,
    write_map,
)

from myk_pi_tools.release.bump_scoped import run as bump_scoped_run


@pytest.fixture()
def scoped_repo(tmp_path: Path) -> Path:
    """The release-plan fixture repo, under a non-shadowing name."""
    return build_fixture_repo(tmp_path)


VALID_MAP = """\
[release]
mode = "scoped"
exclude-paths = ["tests/", "packages/*/tests/"]

[[package]]
name = "poc"
registry = "npm"
version-files = ["package.json"]
paths = ["extensions/"]

[[package]]
name = "tools"
registry = "pypi"
version-files = ["pyproject.toml", "myk_pi_tools/__init__.py"]
paths = ["myk_pi_tools/"]

[[package]]
name = "sidecar"
registry = "npm+pypi"
npm-name = "@org/sidecar"
pypi-name = "sidecar-client"
version-files = ["packages/sidecar/package.json"]
paths = ["packages/sidecar/"]

[container]
rebuild-paths = ["Dockerfile"]
"""


def read_version(repo: Path, rel: str) -> str:
    path = repo / rel
    if rel.endswith("package.json"):
        return json.loads(path.read_text(encoding="utf-8"))["version"]
    if rel.endswith("__init__.py"):
        import re

        m = re.search(r'__version__\s*=\s*["\']([^"\']+)', path.read_text(encoding="utf-8"))
        assert m
        return m.group(1)
    import re

    m = re.search(r'version\s*=\s*["\']([^"\']+)', path.read_text(encoding="utf-8"))
    assert m
    return m.group(1)


class TestBumpScoped:
    def test_bumps_only_affected_at_per_package_versions(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")
        (scoped_repo / "myk_pi_tools" / "new2.py").write_text("y = 2\n", encoding="utf-8")
        commit(scoped_repo, "fix: thing", "myk_pi_tools/new2.py")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(
            scoped_repo,
            set_versions={"poc": "1.1.0", "tools": "1.0.1"},
            as_json=True,
        )
        payload = json.loads(capsys.readouterr().out)

        # Versions are ALWAYS explicit (--set from the /release decision).
        assert {p["name"]: p["version"] for p in payload["packages"]} == {
            "poc": "1.1.0",
            "tools": "1.0.1",
        }
        # Only the affected packages' version files were written.
        assert read_version(scoped_repo, "package.json") == "1.1.0"
        assert read_version(scoped_repo, "pyproject.toml") == "1.0.1"
        assert read_version(scoped_repo, "myk_pi_tools/__init__.py") == "1.0.1"

    def test_per_package_tags(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Tags are per-package (name@version) — no global repo tag."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")
        (scoped_repo / "myk_pi_tools" / "new2.py").write_text("y = 2\n", encoding="utf-8")
        commit(scoped_repo, "fix: thing", "myk_pi_tools/new2.py")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(
            scoped_repo,
            set_versions={"poc": "1.1.0", "tools": "1.0.1"},
            as_json=True,
        )
        payload = json.loads(capsys.readouterr().out)
        assert "tag" not in payload  # no global repo tag in scoped mode
        assert {p["name"]: p["tag"] for p in payload["packages"]} == {
            "poc": "poc@1.1.0",
            "tools": "tools@1.0.1",
        }

    def test_quiet_scoped_bump_prints_no_per_file_progress(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """quiet=True suppresses the banner AND per-file Updated/Skipped
        stderr prints — the scoped caller prints its own single summary
        (Qodo PR #970 round 2: the flag previously guarded only the
        banner, and nothing tested either)."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        import myk_pi_tools.release.plan as plan_mod

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(scoped_repo, set_versions={"poc": "1.1.0"})
        err = capsys.readouterr().err
        assert "Bumping version to" not in err
        assert "Updated:" not in err
        assert "Skipped:" not in err

    def test_quiet_flag_direct(self, scoped_repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
        """Direct unit: quiet=True silences stderr; the CLI default stays
        loud so lockstep keeps its progress output."""
        from myk_pi_tools.release.bump_version import bump_version_files

        result = bump_version_files(new_version="1.2.0", files=["package.json"], root=scoped_repo, quiet=True)
        assert result.status == "success"
        err = capsys.readouterr().err
        assert "Bumping version to" not in err
        assert "Updated:" not in err

        loud = bump_version_files(new_version="1.3.0", files=["package.json"], root=scoped_repo, quiet=False)
        assert loud.status == "success"
        err = capsys.readouterr().err
        assert "Bumping version to 1.3.0..." in err
        assert "Updated: package.json" in err

    def test_untouched_package_files_stay_untouched(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(scoped_repo, set_versions={"poc": "1.1.0"}, as_json=True)
        payload = json.loads(capsys.readouterr().out)
        # sidecar untouched.
        assert read_version(scoped_repo, "packages/sidecar/package.json") == "1.0.0"
        updated_paths = {u["path"] for u in payload["updated"]}
        assert "packages/sidecar/package.json" not in updated_paths

    def test_nothing_affected_is_a_clean_no_op(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(scoped_repo, as_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert payload["status"] == "nothing-to-bump"
        assert payload["packages"] == []
        # No file changed.
        assert read_version(scoped_repo, "package.json") == "1.0.0"

    def test_errored_package_aborts_before_any_write(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            # poc published a version that never existed in git → errored.
            return {
                ("npm", "poc"): "9.9.9",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(scoped_repo, set_versions={"poc": "1.0.1"})
        assert excinfo.value.code == 1
        # Nothing was written even though poc is affected.
        assert read_version(scoped_repo, "package.json") == "1.0.0"

    def test_version_override_applies_to_all_affected(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(scoped_repo, version_override="3.2.1", as_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert {p["name"]: p["tag"] for p in payload["packages"]} == {"poc": "poc@3.2.1"}
        assert read_version(scoped_repo, "package.json") == "3.2.1"

    def test_without_map_refuses_and_exits_one(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        repo = tmp_path / "plain"
        repo.mkdir()
        git(repo, "init")
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(repo)
        assert excinfo.value.code == 1
        assert "lockstep" in capsys.readouterr().err

    def test_force_package_bumps_unaffected_package(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # Declare the npm workspace so packages/sidecar/package.json is a
        # DETECTED version file (bump_version_files only writes detected
        # files). This commit also marks poc affected: the anchor is the commit
        # that introduced 1.0.0, so this version-file edit is inside poc's
        # window (issue #983).
        (scoped_repo / "package.json").write_text(
            json.dumps({"name": "poc", "version": "1.0.0", "workspaces": ["packages/*"]}),
            encoding="utf-8",
        )
        commit(scoped_repo, "chore: declare workspaces", "package.json")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(
            scoped_repo,
            force_packages=("sidecar",),
            set_versions={"sidecar": "1.0.1", "poc": "1.0.1"},
            as_json=True,
        )
        payload = json.loads(capsys.readouterr().out)
        # sidecar has no changed files of its own — only --force-package can
        # put it here.
        assert {p["name"]: p["version"] for p in payload["packages"]} == {
            "sidecar": "1.0.1",
            "poc": "1.0.1",
        }
        assert read_version(scoped_repo, "packages/sidecar/package.json") == "1.0.1"

    def test_unknown_version_file_aborts_before_writes(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # Point poc at a version file OUTSIDE detection (not a root scanner
        # target, not in any workspace) but WITH git history at 1.0.0, so
        # the plan succeeds and only the pre-write validation catches it.
        legacy = scoped_repo / "packages" / "legacy"
        legacy.mkdir(parents=True, exist_ok=True)
        (legacy / "pyproject.toml").write_text('[project]\nname = "legacy"\nversion = "1.0.0"\n', encoding="utf-8")
        commit(scoped_repo, "chore: add legacy", "packages/legacy/pyproject.toml")
        bad = VALID_MAP.replace(
            'version-files = ["package.json"]\npaths = ["extensions/"]',
            'version-files = ["packages/legacy/pyproject.toml"]\npaths = ["extensions/"]',
        )
        write_map(scoped_repo, bad)
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts", "release-map.toml")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(scoped_repo, set_versions={"poc": "1.0.1"})
        assert excinfo.value.code == 1
        assert "not detected" in capsys.readouterr().err


class TestBumpScopedCli:
    def test_cli_lockstep_repo_exits_one(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from myk_pi_tools.release.commands import release

        result = CliRunner().invoke(release, ["bump-scoped", "--repo", str(tmp_path)])
        assert result.exit_code == 1

    def test_cli_json_nothing_to_bump(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        from click.testing import CliRunner

        from myk_pi_tools.release.commands import release

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        runner = CliRunner()
        result = runner.invoke(release, ["bump-scoped", "--repo", str(scoped_repo), "--json"])
        assert result.exit_code == 0
        assert json.loads(result.output)["status"] == "nothing-to-bump"


class TestBumpScopedSetVersions:
    """--set NAME=VERSION: the /release flow's explicit per-package versions."""

    def _publish_all_at_1_0_0(self) -> dict[tuple[str, str], str]:
        return {
            ("npm", "poc"): "1.0.0",
            ("pypi", "tools"): "1.0.0",
            ("npm", "@org/sidecar"): "1.0.0",
            ("pypi", "sidecar-client"): "1.0.0",
        }

    def test_set_versions_override_mechanical_proposal(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # feat commit would mechanically propose 1.1.0; the LLM/user
        # decided 2.0.0 — the explicit decision wins.
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lambda r, n: self._publish_all_at_1_0_0()[(r, n)])
        bump_scoped_run(scoped_repo, set_versions={"poc": "2.0.0"}, as_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert payload["packages"] == [
            {"name": "poc", "version": "2.0.0", "tag": "poc@2.0.0", "files": ["package.json"]}
        ]
        assert read_version(scoped_repo, "package.json") == "2.0.0"

    def test_set_for_unaffected_package_errors(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lambda r, n: self._publish_all_at_1_0_0()[(r, n)])
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(scoped_repo, set_versions={"sidecar": "1.0.1"})
        assert excinfo.value.code == 1

    def test_set_with_force_package_bumps_unaffected(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # poc is affected too: the anchor is the commit that introduced 1.0.0,
        # so this version-file edit is inside poc's window (issue #983).
        (scoped_repo / "package.json").write_text(
            json.dumps({"name": "poc", "version": "1.0.0", "workspaces": ["packages/*"]}),
            encoding="utf-8",
        )
        commit(scoped_repo, "chore: declare workspaces", "package.json")

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lambda r, n: self._publish_all_at_1_0_0()[(r, n)])
        bump_scoped_run(
            scoped_repo,
            force_packages=("sidecar",),
            set_versions={"sidecar": "1.5.0", "poc": "1.0.1"},
            as_json=True,
        )
        payload = json.loads(capsys.readouterr().out)
        # sidecar has no changed files of its own — only --force-package can
        # put it here.
        assert {p["name"]: p["version"] for p in payload["packages"]} == {
            "sidecar": "1.5.0",
            "poc": "1.0.1",
        }
        assert read_version(scoped_repo, "packages/sidecar/package.json") == "1.5.0"
        assert read_version(scoped_repo, "package.json") == "1.0.1"

    def test_parse_set_values(self) -> None:
        from myk_pi_tools.release.bump_scoped import _parse_set_values

        assert _parse_set_values(("a=1.0.0", "b=2.0.0")) == {"a": "1.0.0", "b": "2.0.0"}
        with pytest.raises(SystemExit):
            _parse_set_values(("no-equals-sign",))
        with pytest.raises(SystemExit):
            _parse_set_values(("=1.0.0",))

    def test_missing_set_versions_errors(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """No mechanical fallback: without --set/--version there is no version."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(scoped_repo)
        assert excinfo.value.code == 1
        assert read_version(scoped_repo, "package.json") == "1.0.0"

    def test_downgrade_version_errors(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """--set below the registry-published version never reaches manifests."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(scoped_repo, set_versions={"poc": "0.9.0"})
        assert excinfo.value.code == 1
        assert read_version(scoped_repo, "package.json") == "1.0.0"

    def test_equal_version_errors(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """--set equal to the published version is also rejected."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        with pytest.raises(SystemExit) as excinfo:
            bump_scoped_run(scoped_repo, set_versions={"poc": "1.0.0"})
        assert excinfo.value.code == 1

    def test_malformed_version_errors(self, scoped_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Non-semver and leading-zero versions exit 1, not a traceback."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        for bad in ("1.2", "01.2.3", "abc"):
            with pytest.raises(SystemExit) as excinfo:
                bump_scoped_run(scoped_repo, set_versions={"poc": bad})
            assert excinfo.value.code == 1

    def test_set_wins_over_version_override(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Both flags given: --set decides for its package, --version for the rest."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")
        (scoped_repo / "myk_pi_tools" / "new2.py").write_text("y = 2\n", encoding="utf-8")
        commit(scoped_repo, "fix: thing", "myk_pi_tools/new2.py")

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(
            scoped_repo,
            set_versions={"poc": "1.2.0"},
            version_override="1.0.1",
            as_json=True,
        )
        payload = json.loads(capsys.readouterr().out)
        assert {p["name"]: p["version"] for p in payload["packages"]} == {
            "poc": "1.2.0",
            "tools": "1.0.1",
        }

    def test_version_below_latest_repo_tag_is_allowed(
        self,
        scoped_repo: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """A package versions from ITS OWN registry history — the global repo
        tag sequence must not force jumps (issue #965: a package skipped for
        N releases takes the next version after its own publish, e.g.
        1.0.0 → 1.1.0 even though the repo tag is already v2.0.0)."""
        (scoped_repo / "extensions" / "b.ts").write_text("// x\n", encoding="utf-8")
        commit(scoped_repo, "feat: gate", "extensions/b.ts")
        git(scoped_repo, "tag", "v2.0.0")  # repo far ahead — irrelevant now

        def lookup(registry: str, name: str) -> str:
            return {
                ("npm", "poc"): "1.0.0",
                ("pypi", "tools"): "1.0.0",
                ("npm", "@org/sidecar"): "1.0.0",
                ("pypi", "sidecar-client"): "1.0.0",
            }[(registry, name)]

        import myk_pi_tools.release.plan as plan_mod

        monkeypatch.setattr(plan_mod, "registry_version", lookup)
        bump_scoped_run(scoped_repo, set_versions={"poc": "1.1.0"}, as_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert {p["name"]: p["version"] for p in payload["packages"]} == {"poc": "1.1.0"}
        assert read_version(scoped_repo, "package.json") == "1.1.0"
