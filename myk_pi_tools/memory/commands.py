"""Memory CLI commands."""

import json
import sys
from pathlib import Path

import click

from myk_pi_tools.db.query import _format_table
from myk_pi_tools.memory.store import MemoryDB


@click.group()
@click.option("--db-path", default=None, help="Path to database file")
@click.pass_context
def memory(ctx: click.Context, db_path: str | None) -> None:
    """Project memory commands — persistent per-repo learning."""
    ctx.ensure_object(dict)
    ctx.obj["db"] = MemoryDB(db_path=Path(db_path) if db_path else None)


@memory.command("add")
@click.option(
    "--category",
    "-c",
    required=True,
    type=click.Choice(["lesson", "decision", "mistake", "pattern", "done", "preference"]),
    help="Memory category",
)
@click.option("--summary", "-s", required=True, help="Short description (one line)")
@click.option("--details", "-d", default=None, help="Longer description")
@click.option(
    "--sentiment",
    default="neutral",
    type=click.Choice(["positive", "negative", "neutral"]),
    help="Sentiment (default: neutral)",
)
@click.option("--tags", "-t", default=None, help="Comma-separated tags")
@click.pass_context
def memory_add(
    ctx: click.Context,
    category: str,
    summary: str,
    details: str | None,
    sentiment: str,
    tags: str | None,
) -> None:
    """Add a memory entry.

    Examples:

        # Add a lesson
        myk-pi-tools memory add -c lesson -s "buildah chown -R skips target dir" -t docker,buildah

        # Add a completed task
        myk-pi-tools memory add -c done -s "Added security-auditor agent" --sentiment positive

        # Add a mistake
        myk-pi-tools memory add -c mistake -s "Used sleep for polling instead of async agent" --sentiment negative
    """
    db = ctx.obj["db"]
    memory_id = db.add(category=category, summary=summary, details=details, sentiment=sentiment, tags=tags)
    click.echo(f"Memory #{memory_id} added.", err=True)


@memory.command("search")
@click.argument("query")
@click.option(
    "--category",
    "-c",
    default=None,
    type=click.Choice(["lesson", "decision", "mistake", "pattern", "done", "preference"]),
    help="Filter by category",
)
@click.option("--limit", "-n", default=20, help="Maximum results")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.pass_context
def memory_search(
    ctx: click.Context,
    query: str,
    category: str | None,
    limit: int,
    output_json: bool,
) -> None:
    """Search memories by text.

    Examples:

        # Search for docker-related memories
        myk-pi-tools memory search docker

        # Search lessons only
        myk-pi-tools memory search docker -c lesson

        # JSON output
        myk-pi-tools memory search docker --json
    """
    db = ctx.obj["db"]
    results = db.search(query, category=category, limit=limit)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        if not results:
            click.echo("No memories found.")
        else:
            click.echo(_format_table(results, ["id", "date", "category", "sentiment", "summary", "tags"]))


@memory.command("list")
@click.option(
    "--category",
    "-c",
    default=None,
    type=click.Choice(["lesson", "decision", "mistake", "pattern", "done", "preference"]),
    help="Filter by category",
)
@click.option("--last", "last_days", default=None, type=click.IntRange(min=1), help="Show last N days")
@click.option("--limit", "-n", default=50, help="Maximum results")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.pass_context
def memory_list(
    ctx: click.Context,
    category: str | None,
    last_days: int | None,
    limit: int,
    output_json: bool,
) -> None:
    """List memories with optional filters.

    Examples:

        # List all memories
        myk-pi-tools memory list

        # List lessons from last 7 days
        myk-pi-tools memory list -c lesson --last 7

        # JSON output
        myk-pi-tools memory list --json
    """
    db = ctx.obj["db"]
    results = db.list_memories(category=category, last_days=last_days, limit=limit)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        if not results:
            click.echo("No memories found.")
        else:
            click.echo(_format_table(results, ["id", "date", "category", "sentiment", "summary", "tags"]))


@memory.command("delete")
@click.argument("memory_id", type=int)
@click.pass_context
def memory_delete(ctx: click.Context, memory_id: int) -> None:
    """Delete a memory by ID.

    Examples:

        myk-pi-tools memory delete 42
    """
    db = ctx.obj["db"]
    if db.delete(memory_id):
        click.echo(f"Memory #{memory_id} deleted.", err=True)
    else:
        click.echo(f"Memory #{memory_id} not found.", err=True)
        sys.exit(1)
