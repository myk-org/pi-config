"""Release-related CLI commands."""

from pathlib import Path

import click

from myk_pi_tools.release.bump_version import run as bump_run
from myk_pi_tools.release.create import run as create_run
from myk_pi_tools.release.detect_versions import run as detect_run
from myk_pi_tools.release.info import run as info_run
from myk_pi_tools.release.plan import run as plan_run


@click.group()
def release() -> None:
    """GitHub release commands."""
    pass


@release.command("info")
@click.option("--repo", help="Repository in owner/repo format")
@click.option("--target", help="Target branch for release (overrides default branch check)")
@click.option("--tag-match", help="Glob pattern to filter tags (e.g., 'v2.10.*')")
def release_info(repo: str | None, target: str | None, tag_match: str | None) -> None:
    """Fetch release validation info and commits since last tag."""
    info_run(repo, target=target, tag_match=tag_match)


@release.command("create")
@click.argument("owner_repo")
@click.argument("tag")
@click.argument("changelog_file")
@click.option("--prerelease", is_flag=True, help="Mark as pre-release")
@click.option("--draft", is_flag=True, help="Create as draft")
@click.option("--target", help="Target branch for the release")
@click.option("--title", help="Release title (defaults to tag name)")
def release_create(
    owner_repo: str,
    tag: str,
    changelog_file: str,
    *,
    prerelease: bool,
    draft: bool,
    target: str | None,
    title: str | None,
) -> None:
    """Create a GitHub release."""
    create_run(
        owner_repo=owner_repo,
        tag=tag,
        changelog_file=changelog_file,
        prerelease=prerelease,
        draft=draft,
        target=target,
        title=title,
    )


@release.command("detect-versions")
def release_detect_versions() -> None:
    """Detect version files in the current repository."""
    detect_run()


@release.command("plan")
@click.option(
    "--repo",
    "repo_root",
    type=click.Path(exists=True, file_okay=False),
    default=".",
    help="Repository root (default: current directory)",
)
@click.option(
    "--force-package",
    "force_packages",
    multiple=True,
    help="Include a package even if detection marks it unchanged (repeatable)",
)
@click.option("--json", "as_json", is_flag=True, help="Emit the plan as JSON (for /release and other tooling)")
def release_plan(repo_root: str, force_packages: tuple[str, ...], as_json: bool) -> None:
    """Scoped-release plan: which packages changed since their last publish.

    Read-only. Uses release-map.toml at the repo root; a repo without a
    map stays in lockstep mode (issue #965).
    """
    plan_run(Path(repo_root), force_packages=force_packages, as_json=as_json)


@release.command("bump-version")
@click.argument("version")
@click.option("--files", multiple=True, help="Specific files to update (can be repeated)")
def release_bump_version(version: str, files: tuple[str, ...]) -> None:
    """Update version strings in detected version files."""
    bump_run(version, list(files) if files else None)
