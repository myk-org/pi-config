"""Memory CLI commands."""

from pathlib import Path

import click

from myk_pi_tools.memory.store import MemoryFile


@click.group()
@click.option("--file-path", default=None, help="Path to memory file")
@click.pass_context
def memory(ctx: click.Context, file_path: str | None) -> None:
    """Project memory commands — persistent per-repo learning."""
    ctx.ensure_object(dict)
    ctx.obj["mem"] = MemoryFile(file_path=Path(file_path) if file_path else None)


@memory.command("add")
@click.option(
    "--category",
    "-c",
    required=True,
    type=click.Choice(["lesson", "decision", "mistake", "pattern", "done", "preference"]),
    help="Memory category",
)
@click.option("--summary", "-s", required=True, help="Short description (one line)")
@click.option(
    "--pinned",
    is_flag=True,
    default=False,
    help="Add to Pinned section (user-requested, protected from dreaming)",
)
@click.pass_context
def memory_add(ctx: click.Context, category: str, summary: str, pinned: bool) -> None:
    """Add a memory entry.

    Examples:

        # Add a learned memory
        myk-pi-tools memory add -c lesson -s "buildah chown -R skips target dir"

        # Add a pinned memory (user-requested, never auto-removed)
        myk-pi-tools memory add -c preference -s "Always use uv run" --pinned
    """
    mem = ctx.obj["mem"]
    if pinned:
        mem.add_pinned(category, summary)
    else:
        mem.add_learned(category, summary)
    section = "Pinned" if pinned else "Learned"
    click.echo(f"Memory added to {section}: [{category}] {summary}", err=True)


@memory.command("show")
@click.pass_context
def memory_show(ctx: click.Context) -> None:
    """Show the memory file contents.

    Examples:

        myk-pi-tools memory show
    """
    mem = ctx.obj["mem"]
    click.echo(mem.read())


@memory.command("migrate")
@click.pass_context
def memory_migrate(ctx: click.Context) -> None:
    """Migrate from SQLite DB to memory.md (one-time).

    Reads all memories from memories.db, writes them to memory.md,
    then deletes the DB and related files.

    Examples:

        myk-pi-tools memory migrate
    """
    mem = ctx.obj["mem"]
    count = mem.migrate_from_db()
    if count > 0:
        click.echo(f"Migrated {count} memories from DB to {mem.file_path}", err=True)
    else:
        click.echo("No DB found or empty — nothing to migrate.", err=True)


@memory.command("path")
@click.pass_context
def memory_path(ctx: click.Context) -> None:
    """Print the memory file path.

    Examples:

        myk-pi-tools memory path
    """
    mem = ctx.obj["mem"]
    click.echo(str(mem.file_path))
