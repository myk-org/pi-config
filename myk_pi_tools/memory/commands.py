"""Memory CLI commands."""

import fcntl
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


@memory.command("stats")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.pass_context
def memory_stats(ctx: click.Context, output_json: bool) -> None:
    """Show memory statistics.

    Examples:

        myk-pi-tools memory stats
        myk-pi-tools memory stats --json
    """
    db = ctx.obj["db"]
    result = db.stats()

    if output_json:
        click.echo(json.dumps(result, indent=2))
    else:
        click.echo(f"Total memories: {result['total']}")
        click.echo(f"Recalled at least once: {result['recalled']}")
        click.echo(f"Never recalled: {result['never_recalled']}")
        if result.get("categories"):
            click.echo(f"Categories: {', '.join(f'{k}={v}' for k, v in sorted(result['categories'].items()))}")
        if result.get("top_recalled"):
            click.echo("\nMost recalled:")
            for tr in result["top_recalled"]:
                click.echo(f"  #{tr['id']} ({tr['recall_count']}x) {tr['summary']}")


@memory.command("score")
@click.option("--limit", "-n", default=20, help="Maximum results")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.pass_context
def memory_score(ctx: click.Context, limit: int, output_json: bool) -> None:
    """Show memories ranked by score.

    Examples:

        myk-pi-tools memory score
        myk-pi-tools memory score -n 10
    """
    db = ctx.obj["db"]
    results = db.score_memories(limit=limit)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        if not results:
            click.echo("No memories found.")
        else:
            click.echo(_format_table(results, ["id", "score", "recall_count", "category", "summary", "tags"]))


@memory.command("prune")
@click.option("--min-score", default=0.1, type=float, help="Minimum score threshold")
@click.option("--max-age", default=90, type=int, help="Max age in days for unrecalled memories")
@click.option("--apply", is_flag=True, help="Actually delete (default is dry-run)")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.pass_context
def memory_prune(ctx: click.Context, min_score: float, max_age: int, apply: bool, output_json: bool) -> None:
    """Prune low-value memories.

    Default is dry-run — shows what would be deleted. Use --apply to actually delete.

    Examples:

        # Preview what would be pruned
        myk-pi-tools memory prune

        # Actually prune
        myk-pi-tools memory prune --apply

        # Custom thresholds
        myk-pi-tools memory prune --min-score 0.2 --max-age 60
    """
    db = ctx.obj["db"]
    results = db.prune(min_score=min_score, max_age_days=max_age, dry_run=not apply)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        if not results:
            click.echo("No memories to prune." if not apply else "Nothing pruned.")
        else:
            mode = "Pruned" if apply else "Would prune"
            click.echo(f"{mode} {len(results)} memories:", err=True)
            for m in results:
                click.echo(f"  #{m['id']} ({m['category']}) {m['summary']} — {m.get('prune_reason', '')}")


_MAX_DREAM_REPORTS = 10


@memory.command("dream")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.pass_context
def memory_dream(ctx: click.Context, output_json: bool) -> None:
    """Run memory consolidation and generate dream report.

    Scores all memories, identifies prune candidates, and writes
    a report to .pi/memory/dreams.md. Keeps only the last 10 reports.

    Examples:

        myk-pi-tools memory dream
        myk-pi-tools memory dream --json
    """
    db = ctx.obj["db"]
    report = db.dream()

    # Write dream report to file, rotating to keep only last N reports.
    # Uses advisory file lock to prevent concurrent write races
    # (e.g., /dream manual + auto-dream timer running simultaneously).
    dream_path = db.db_path.parent / "dreams.md"
    lock_path = dream_path.with_suffix(".lock")

    wrote_file = False
    try:
        with open(lock_path, "w") as lock_fd:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                existing = dream_path.read_text() if dream_path.exists() else ""
                parts = [report] + [p for p in existing.split("\n---\n\n") if p.strip()]
                parts = parts[:_MAX_DREAM_REPORTS]
                dream_path.write_text("\n---\n\n".join(parts) + "\n")
                wrote_file = True
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
    except BlockingIOError:
        click.echo("Another dream is running — skipped file write.", err=True)
    except OSError as e:
        click.echo(f"Failed to write dream report: {e}", err=True)
        sys.exit(1)

    if output_json:
        click.echo(json.dumps({"report": report, "path": str(dream_path), "wrote_file": wrote_file}, indent=2))
    else:
        click.echo(report)
        if wrote_file:
            click.echo(f"\nDream report written to {dream_path}", err=True)
