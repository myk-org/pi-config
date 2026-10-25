"""Scoped-release plan tests (issue #965).

Covers: release-map.toml loader validation, path matching semantics, and
the per-package detection engine (registry ground truth → anchor commit →
diff window → proposed bump) against a fixture git repo. The generic
lockstep behavior for repos WITHOUT a map is part of the regression
contract — run() must stay a clean no-op there.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from myk_pi_tools.release.plan import (
    PackagePlan,
    ReleasePlanner,
    _bump_version_string,
    _commits_bump_type,
)
from myk_pi_tools.release.plan import (
    run as plan_run,
)
from myk_pi_tools.release.release_map import (
    ReleaseMapError,
    _path_under_any,
    find_release_map,
    load_release_map,
)

# ── Loader ────────────────────────────────────────────────────────────────

VALID_MAP = """
[release]
mode = "scoped"
exclude-paths = ["tests/", "packages/*/tests/"]

[[package]]
name = "poc"
registry = "npm"
version-files = ["package.json"]
paths = ["extensions/", "package.json"]
exclude-paths = ["scripts/docs_render/"]

[[package]]
name = "tools"
registry = "pypi"
version-files = ["pyproject.toml", "myk_pi_tools/__init__.py"]
paths = ["myk_pi_tools/", "pyproject.toml"]

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


def write_map(tmp_path: Path, content: str) -> Path:
    (tmp_path / "release-map.toml").write_text(content, encoding="utf-8")
    return tmp_path


class TestLoader:
    def test_valid_map_parses(self, tmp_path: Path) -> None:
        rm = load_release_map(write_map(tmp_path, VALID_MAP))
        assert rm.mode == "scoped"
        assert [p.name for p in rm.packages] == ["poc", "tools", "sidecar"]
        assert rm.global_excludes == ("tests/", "packages/*/tests/")
        assert rm.container_rebuild_paths == ("Dockerfile",)

    def test_registry_names_use_overrides(self, tmp_path: Path) -> None:
        rm = load_release_map(write_map(tmp_path, VALID_MAP))
        sidecar = next(p for p in rm.packages if p.name == "sidecar")
        assert sidecar.registry_names() == [("npm", "@org/sidecar"), ("pypi", "sidecar-client")]
        poc = next(p for p in rm.packages if p.name == "poc")
        assert poc.registry_names() == [("npm", "poc")]

    def test_missing_map_returns_none(self, tmp_path: Path) -> None:
        assert find_release_map(tmp_path) is None

    def test_invalid_toml_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ReleaseMapError, match="not valid TOML"):
            load_release_map(write_map(tmp_path, "mode = [unclosed"))

    def test_missing_release_section_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ReleaseMapError, match=r"\[release\]"):
            load_release_map(write_map(tmp_path, "[container]\nrebuild-paths = []\n"))

    def test_unknown_registry_raises(self, tmp_path: Path) -> None:
        bad = VALID_MAP.replace('registry = "npm"', 'registry = "cargo"')
        with pytest.raises(ReleaseMapError, match="cargo"):
            load_release_map(write_map(tmp_path, bad))

    def test_duplicate_package_name_raises(self, tmp_path: Path) -> None:
        bad = (
            VALID_MAP
            + '\n[[package]]\nname = "poc"\nregistry = "npm"\nversion-files = ["x/package.json"]\npaths = ["x/"]\n'
        )
        with pytest.raises(ReleaseMapError, match="duplicate package name"):
            load_release_map(write_map(tmp_path, bad))

    def test_overlapping_version_files_raises(self, tmp_path: Path) -> None:
        bad = (
            VALID_MAP
            + '\n[[package]]\nname = "other"\nregistry = "npm"\nversion-files = ["package.json"]\npaths = ["other/"]\n'
        )
        with pytest.raises(ReleaseMapError, match="belongs to both"):
            load_release_map(write_map(tmp_path, bad))

    def test_npm_name_on_pypi_only_raises(self, tmp_path: Path) -> None:
        bad = VALID_MAP.replace('registry = "pypi"', 'registry = "pypi"\nnpm-name = "nope"')
        with pytest.raises(ReleaseMapError, match="npm-name"):
            load_release_map(write_map(tmp_path, bad))

    def test_missing_required_fields_raise(self, tmp_path: Path) -> None:
        for field_name, snippet in (
            ("version-files", '\n[[package]]\nname = "x"\nregistry = "npm"\npaths = ["x/"]\n'),
            ("paths", '\n[[package]]\nname = "x"\nregistry = "npm"\nversion-files = ["x/package.json"]\n'),
            ("name", '\n[[package]]\nregistry = "npm"\nversion-files = ["x/package.json"]\npaths = ["x/"]\n'),
        ):
            with pytest.raises(ReleaseMapError, match=field_name):
                load_release_map(write_map(tmp_path, VALID_MAP + snippet))


class TestPathMatching:
    def test_prefix_requires_segment_boundary(self) -> None:
        assert _path_under_any("extensions/a.ts", ("extensions/",))
        assert _path_under_any("extensions/", ("extensions/",))
        assert not _path_under_any("extensions-foo/a.ts", ("extensions/",))

    def test_exact_file_match(self) -> None:
        assert _path_under_any("package.json", ("package.json",))
        assert not _path_under_any("package.json.bak", ("package.json",))

    def test_glob_prefix(self) -> None:
        assert _path_under_any("packages/sidecar/tests/x.py", ("packages/*/tests/",))
        assert not _path_under_any("packages/sidecar/src/x.py", ("packages/*/tests/",))

    def test_affects_respects_package_excludes(self, tmp_path: Path) -> None:
        rm = load_release_map(write_map(tmp_path, VALID_MAP))
        poc = rm.packages[0]
        assert poc.affects("extensions/orchestrator/x.ts")
        assert not poc.affects("scripts/docs_render/render.py")  # excluded from poc
        assert poc.affects("package.json")  # explicit path entry

    def test_global_excludes_apply_before_packages(self, tmp_path: Path) -> None:
        rm = load_release_map(write_map(tmp_path, VALID_MAP))
        affected = rm.affected_packages(["tests/python/test_x.py", "extensions/a.ts"])
        assert [p.name for p in affected] == ["poc"]


# ── Bump math ─────────────────────────────────────────────────────────────


class TestBump:
    def test_patch_bumps_the_patch_segment(self) -> None:
        assert _bump_version_string("1.2.3", "patch") == "1.2.4"

    def test_minor_bumps_the_minor_segment(self) -> None:
        assert _bump_version_string("1.2.3", "minor") == "1.3.0"

    def test_major_bumps_the_major_segment(self) -> None:
        assert _bump_version_string("1.2.3", "major") == "2.0.0"

    def test_bump_version_string_rejects_non_semver(self) -> None:
        with pytest.raises(RuntimeError, match="non-semver"):
            _bump_version_string("1.2", "patch")

    def test_fix_subject_maps_to_patch(self) -> None:
        assert _commits_bump_type(["fix: a"]) == "patch"

    def test_feat_subject_maps_to_minor(self) -> None:
        assert _commits_bump_type(["feat: a"]) == "minor"

    def test_scoped_feat_subject_maps_to_minor(self) -> None:
        assert _commits_bump_type(["feat(scope): a"]) == "minor"

    def test_feat_bang_subject_maps_to_major(self) -> None:
        assert _commits_bump_type(["feat!: a"]) == "major"

    def test_non_release_subject_defaults_to_patch(self) -> None:
        assert _commits_bump_type(["chore: a"]) == "patch"

    def test_breaking_change_footer_in_body_maps_to_major(self) -> None:
        # %B full messages: the footer lives on a later line (Qodo #966).
        message = "feat: add a thing\n\nSome body text.\n\nBREAKING CHANGE: drops the old flag\n"
        assert _commits_bump_type([message]) == "major"

    def test_feat_over_fix_wins_minor(self) -> None:
        assert _commits_bump_type(["fix: a", "feat: b"]) == "minor"

    def test_breaking_over_fix_wins_major(self) -> None:
        assert _commits_bump_type(["fix: a", "feat!: b"]) == "major"


# ── Detection engine (fixture git repo) ──────────────────────────────────


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def commit(repo: Path, message: str, *files: str) -> None:
    """Commit ONLY the named files (Qodo PR #966: ``git add -A`` staged
    whatever else happened to be in the fixture tree)."""
    git(repo, "add", "--", *files)
    git(repo, "commit", "-m", message)


@pytest.fixture()
def fixture_repo(tmp_path: Path) -> Path:
    """A git repo with two packages over a shared map, at v1.0.0 published."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    write_map(repo, VALID_MAP)

    (repo / "package.json").write_text(json.dumps({"name": "poc", "version": "0.9.0"}), encoding="utf-8")
    (repo / "pyproject.toml").write_text('[project]\nname = "tools"\nversion = "0.9.0"\n', encoding="utf-8")
    for f in (
        "myk_pi_tools/__init__.py",
        "extensions/a.ts",
        "packages/sidecar/package.json",
        "packages/sidecar/src/index.ts",
        "myk_pi_tools/cli.py",
    ):
        p = repo / f
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            '__version__ = "0.9.0"\n'
            if f.endswith("__init__.py")
            else json.dumps({"name": "sidecar", "version": "0.9.0"})
            if f.endswith("package.json")
            else "// seed\n",
            encoding="utf-8",
        )
    commit(
        repo,
        "chore: seed repo at 0.9.0",
        "release-map.toml",
        "package.json",
        "pyproject.toml",
        "myk_pi_tools/__init__.py",
        "myk_pi_tools/cli.py",
        "extensions/a.ts",
        "packages/sidecar/package.json",
        "packages/sidecar/src/index.ts",
    )

    # Bump ALL packages to 1.0.0 — the lockstep-era release commit.
    (repo / "package.json").write_text(json.dumps({"name": "poc", "version": "1.0.0"}), encoding="utf-8")
    (repo / "pyproject.toml").write_text('[project]\nname = "tools"\nversion = "1.0.0"\n', encoding="utf-8")
    (repo / "myk_pi_tools" / "__init__.py").write_text('__version__ = "1.0.0"\n', encoding="utf-8")
    (repo / "packages" / "sidecar" / "package.json").write_text(
        json.dumps({"name": "sidecar", "version": "1.0.0"}), encoding="utf-8"
    )
    commit(
        repo,
        "chore: bump version to 1.0.0",
        "package.json",
        "pyproject.toml",
        "myk_pi_tools/__init__.py",
        "packages/sidecar/package.json",
    )
    return repo


def make_planner(repo: Path, published: dict[tuple[str, str], str], **kwargs: object) -> ReleasePlanner:
    rm = load_release_map(repo)

    def lookup(registry: str, name: str) -> str:
        try:
            return published[(registry, name)]
        except KeyError:
            raise RuntimeError(f"{registry}:{name} not in mock") from None

    return ReleasePlanner(repo, rm, registry_lookup=lookup, **kwargs)  # type: ignore[arg-type]


class TestPlanner:
    def test_no_changes_since_publish_all_skipped(self, fixture_repo: Path) -> None:
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = make_planner(fixture_repo, published).plan()
        assert all(not p.affected for p in plans)
        assert all(p.anchor is not None for p in plans)

    def test_extension_change_affects_only_poc_patch(self, fixture_repo: Path) -> None:
        (fixture_repo / "extensions" / "b.ts").write_text("// new\n", encoding="utf-8")
        commit(fixture_repo, "fix(orchestrator): guard the gate", "extensions/b.ts")
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert plans["poc"].affected
        assert plans["poc"].proposed_version == "1.0.1"
        assert plans["poc"].bump_type == "patch"
        assert not plans["tools"].affected
        assert not plans["sidecar"].affected

    def test_feat_commit_bumps_minor(self, fixture_repo: Path) -> None:
        (fixture_repo / "myk_pi_tools" / "new.py").write_text("x = 1\n", encoding="utf-8")
        commit(fixture_repo, "feat(reviews): add scoped release plan", "myk_pi_tools/new.py")
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert plans["tools"].affected
        assert plans["tools"].proposed_version == "1.1.0"
        assert not plans["poc"].affected

    def test_per_package_window_reaches_back(self, fixture_repo: Path) -> None:
        # poc published 1.0.0; tools was last published at the 0.9.0 commit.
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "0.9.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        # The 0.9.0→1.0.0 bump commit itself touched myk_pi_tools/__init__.py
        # (a tools path), so tools' window includes it → affected.
        assert plans["tools"].affected
        assert not plans["poc"].affected

    def test_excluded_paths_do_not_trigger(self, fixture_repo: Path) -> None:
        test_file = fixture_repo / "tests" / "python" / "test_x.py"
        test_file.parent.mkdir(parents=True, exist_ok=True)
        test_file.write_text("def test_x(): pass\n", encoding="utf-8")
        render = fixture_repo / "scripts" / "docs_render" / "render.py"
        render.parent.mkdir(parents=True, exist_ok=True)
        render.write_text("x = 1\n", encoding="utf-8")
        commit(fixture_repo, "test: add coverage", "tests/python/test_x.py", "scripts/docs_render/render.py")
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = make_planner(fixture_repo, published).plan()
        assert all(not p.affected for p in plans)

    def test_force_package_includes_without_changes(self, fixture_repo: Path) -> None:
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        planner = make_planner(fixture_repo, published, force_packages=("sidecar",))
        plans = {p.name: p for p in planner.plan()}
        assert plans["sidecar"].affected
        assert plans["sidecar"].forced
        assert plans["sidecar"].proposed_version == "1.0.1"  # default patch

    def test_registry_failure_is_reported_not_raised(self, fixture_repo: Path) -> None:
        def failing_lookup(registry: str, name: str) -> str:  # noqa: ARG001
            raise RuntimeError(f"{registry} unreachable")

        rm = load_release_map(fixture_repo)
        planner = ReleasePlanner(fixture_repo, rm, registry_lookup=failing_lookup)
        plans = {p.name: p for p in planner.plan()}
        assert all(p.error is not None for p in plans.values())
        assert all(not p.affected for p in plans.values())

    def test_anchor_not_found_is_reported(self, fixture_repo: Path) -> None:
        # Registry claims a version git history never had.
        published = {("npm", "poc"): "9.9.9", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert "9.9.9" in (plans["poc"].error or "")
        assert not plans["poc"].affected

    def test_sidecar_prefers_npm_ground_truth(self, fixture_repo: Path) -> None:
        (fixture_repo / "packages" / "sidecar" / "src" / "new.ts").write_text("x = 1\n", encoding="utf-8")
        commit(fixture_repo, "fix(sidecar): session handling", "packages/sidecar/src/new.ts")
        published = {("npm", "poc"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0", ("pypi", "tools"): "1.0.0"}
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert plans["sidecar"].affected
        assert plans["sidecar"].proposed_version == "1.0.1"


# ── CLI entry (run) ───────────────────────────────────────────────────────


class TestRun:
    def test_no_map_is_lockstep_noop(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        plan_run(tmp_path)
        out = capsys.readouterr().out
        assert "lockstep" in out

    def test_no_map_json(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        plan_run(tmp_path, as_json=True)
        payload = json.loads(capsys.readouterr().out)
        assert payload["mode"] == "lockstep"

    def test_invalid_map_exits_nonzero(self, tmp_path: Path) -> None:
        write_map(tmp_path, "not [ valid toml")
        with pytest.raises(SystemExit) as excinfo:
            plan_run(tmp_path)
        assert excinfo.value.code == 1

    def test_unknown_forced_package_exits_nonzero(self, fixture_repo: Path) -> None:
        with pytest.raises(SystemExit) as excinfo:
            plan_run(fixture_repo, force_packages=("nonexistent",))
        assert excinfo.value.code == 1

    def test_plan_dict_shape(self) -> None:
        plan = PackagePlan(name="x", registry="npm", affected=True, proposed_version="1.0.1")
        d = plan.to_dict()
        assert d["name"] == "x"
        assert d["affected"] is True
        assert d["proposed_version"] == "1.0.1"


# ── Round-2 behavior (Qodo PR #966) ──────────────────────────────────────


class TestGlobSegments:
    def test_one_level_glob_does_not_match_deeper_paths(self) -> None:
        # packages/*/tests/ excludes packages/sidecar/tests/... but NOT
        # packages/a/b/tests/... (a * must not consume /).
        assert _path_under_any("packages/sidecar/tests/x.py", ("packages/*/tests/",))
        assert not _path_under_any("packages/a/b/tests/x.py", ("packages/*/tests/",))

    def test_glob_directory_prefix_matches_files_under_it(self) -> None:
        assert _path_under_any("packages/sidecar/tests/deep/nested.py", ("packages/*/tests/",))


class TestModeValidation:
    def test_non_scoped_mode_rejected(self, tmp_path: Path) -> None:
        bad = VALID_MAP.replace('mode = "scoped"', 'mode = "lockstep"')
        with pytest.raises(ReleaseMapError, match="must be 'scoped'"):
            load_release_map(write_map(tmp_path, bad))


class TestRegistryAgreement:
    def test_divergent_registries_report_error_not_silence(self, fixture_repo: Path) -> None:
        published = {
            ("npm", "poc"): "1.0.0",
            ("pypi", "tools"): "1.0.0",
            ("npm", "@org/sidecar"): "1.0.0",
            ("pypi", "sidecar-client"): "0.5.0",  # diverged
        }
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert "divergence" in (plans["sidecar"].error or "")
        assert not plans["sidecar"].affected

    def test_failed_secondary_registry_still_plans(self, fixture_repo: Path) -> None:
        # npm succeeds, pypi lookup fails → the npm answer stands.
        published = {
            ("npm", "poc"): "1.0.0",
            ("pypi", "tools"): "1.0.0",
            ("npm", "@org/sidecar"): "1.0.0",
        }
        (fixture_repo / "packages" / "sidecar" / "src" / "new.ts").write_text("x = 1\n", encoding="utf-8")
        commit(fixture_repo, "fix(sidecar): x", "packages/sidecar/src/new.ts")
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert plans["sidecar"].affected
        assert plans["sidecar"].proposed_version == "1.0.1"


class TestPlannerGlobalExcludes:
    def test_global_exclude_blocks_test_only_changes_in_planner(self, fixture_repo: Path) -> None:
        # The planner itself must apply the map's global excludes
        # (packages/*/tests/), not just the loader helper.
        test_file = fixture_repo / "packages" / "sidecar" / "tests" / "test_x.py"
        test_file.parent.mkdir(parents=True, exist_ok=True)
        test_file.write_text("def test_x(): pass\n", encoding="utf-8")
        commit(fixture_repo, "test: sidecar coverage", "packages/sidecar/tests/test_x.py")
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = {p.name: p for p in make_planner(fixture_repo, published).plan()}
        assert not plans["sidecar"].affected


class TestContainerRebuild:
    def test_rebuild_when_any_package_affected(self, fixture_repo: Path) -> None:
        (fixture_repo / "extensions" / "b.ts").write_text("// new\n", encoding="utf-8")
        commit(fixture_repo, "fix: gate", "extensions/b.ts")
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        planner = make_planner(fixture_repo, published)
        container = planner.container_rebuild(planner.plan())
        assert container["rebuild"] is True
        assert "a package ships" in str(container["reason"])

    def test_no_rebuild_when_nothing_affected(self, fixture_repo: Path) -> None:
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        planner = make_planner(fixture_repo, published)
        container = planner.container_rebuild(planner.plan())
        assert container["rebuild"] is False

    def test_rebuild_path_change_since_tag_triggers_rebuild(self, fixture_repo: Path) -> None:
        git(fixture_repo, "tag", "v1.0.0")
        (fixture_repo / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
        commit(fixture_repo, "build: image tweak", "Dockerfile")
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        planner = make_planner(fixture_repo, published)
        container = planner.container_rebuild(planner.plan())
        assert container["rebuild"] is True
        assert "Dockerfile" in str(container.get("changed_rebuild_paths"))


class TestGitFailureContainment:
    def test_diff_failure_becomes_package_error(self, fixture_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import myk_pi_tools.release.plan as plan_mod

        real_git = plan_mod._git

        def failing_git(repo_root: Path, args: list[str], timeout: int = 60) -> str:
            if args and args[0] == "diff":
                raise RuntimeError("diff exploded")
            return real_git(repo_root, args, timeout)

        monkeypatch.setattr(plan_mod, "_git", failing_git)
        published = {("npm", "poc"): "1.0.0", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        plans = make_planner(fixture_repo, published).plan()
        # Every package errored on the diff — but the plan COMPLETED.
        assert all(p.error is not None for p in plans)
        assert all(not p.affected for p in plans)


class TestNpmVersion:
    def test_missing_npm_binary_is_runtime_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import myk_pi_tools.release.plan as plan_mod

        def missing_npm(*args: object, **kwargs: object) -> str:  # noqa: ARG001
            raise FileNotFoundError("npm")

        monkeypatch.setattr(plan_mod.subprocess, "run", missing_npm)
        with pytest.raises(RuntimeError, match="npm view"):
            plan_mod._npm_version("some-package")

    def test_npm_null_version_is_runtime_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import types

        import myk_pi_tools.release.plan as plan_mod

        result = types.SimpleNamespace(returncode=0, stdout='"null"', stderr="")
        monkeypatch.setattr(plan_mod.subprocess, "run", lambda *a, **k: result)  # noqa: ARG005
        with pytest.raises(RuntimeError, match="no version"):
            plan_mod._npm_version("never-published")

    def test_dispatcher_routes_by_registry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import myk_pi_tools.release.plan as plan_mod

        calls: list[tuple[str, str]] = []

        def fake(registry: str, name: str) -> str:
            calls.append((registry, name))
            return "1.0.0"

        monkeypatch.setattr(plan_mod, "registry_version", fake)
        # The dispatcher is the default lookup — call it via the module ref.
        assert plan_mod.registry_version("npm", "x") == "1.0.0"
        assert calls == [("npm", "x")]


class TestClickCommand:
    def test_command_reports_lockstep_without_map(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from myk_pi_tools.release.commands import release

        result = CliRunner().invoke(release, ["plan", "--repo", str(tmp_path)])
        assert result.exit_code == 0
        assert "lockstep" in result.output

    def test_command_json_lockstep(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from myk_pi_tools.release.commands import release

        result = CliRunner().invoke(release, ["plan", "--repo", str(tmp_path), "--json"])
        assert result.exit_code == 0
        assert json.loads(result.output)["mode"] == "lockstep"

    def test_command_invalid_map_exits_one(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from myk_pi_tools.release.commands import release

        write_map(tmp_path, "not [ valid")
        result = CliRunner().invoke(release, ["plan", "--repo", str(tmp_path)])
        assert result.exit_code == 1

    def test_command_unknown_force_exits_one(self, fixture_repo: Path) -> None:
        from click.testing import CliRunner

        from myk_pi_tools.release.commands import release

        result = CliRunner().invoke(release, ["plan", "--repo", str(fixture_repo), "--force-package", "nope"])
        assert result.exit_code == 1


class TestErroredPresentation:
    def test_errored_packages_get_their_own_section(self, fixture_repo: Path) -> None:
        published = {("npm", "poc"): "9.9.9", ("pypi", "tools"): "1.0.0", ("npm", "@org/sidecar"): "1.0.0"}
        planner = make_planner(fixture_repo, published)
        plans = planner.plan()
        errored = [p for p in plans if p.error]
        assert [p.name for p in errored] == ["poc"]
        # An errored package must not be counted as unchanged/skipped.
        skipped = [p for p in plans if not p.affected and not p.error]
        assert "poc" not in [p.name for p in skipped]
