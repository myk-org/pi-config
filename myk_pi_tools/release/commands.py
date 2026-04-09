"""Release-related CLI commands."""

import click

from myk_pi_tools.release.bump_version import run as bump_run
from myk_pi_tools.release.create import run as create_run
from myk_pi_tools.release.detect_versions import run as detect_run
from myk_pi_tools.release.info import run as info_run


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


@release.command("bump-version")
@click.argument("version")
@click.option("--files", multiple=True, help="Specific files to update (can be repeated)")
def release_bump_version(version: str, files: tuple[str, ...]) -> None:
    """Update version strings in detected version files."""
    bump_run(version, list(files) if files else None)
