"""Review database CLI commands."""

import json
import sys
from pathlib import Path

import click

from myk_pi_tools.db.query import ReviewDB, _format_table


@click.group()
def db() -> None:
    """Review database query commands."""


@db.command("stats")
@click.option("--by-source", is_flag=True, help="Group by source (human/qodo/coderabbit)")
@click.option("--by-reviewer", is_flag=True, help="Group by reviewer author")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.option("--db-path", help="Path to database file")
def db_stats(by_source: bool, by_reviewer: bool, output_json: bool, db_path: str | None) -> None:
    """Get review statistics.

    Examples:

        # Stats by source (default)
        myk-pi-tools db stats

        # Stats by reviewer
        myk-pi-tools db stats --by-reviewer

        # JSON output
        myk-pi-tools db stats --by-source --json
    """
    if by_source and by_reviewer:
        click.echo("Error: choose only one of --by-source or --by-reviewer", err=True)
        sys.exit(1)

    db_obj = ReviewDB(db_path=Path(db_path) if db_path else None)

    # If neither flag is set, default to by-source behavior
    if not by_source and not by_reviewer:
        by_source = True

    if by_reviewer:
        results = db_obj.get_reviewer_stats()
        if output_json:
            click.echo(json.dumps(results, indent=2))
        else:
            click.echo(_format_table(results, ["author", "total", "addressed", "not_addressed", "skipped"]))
    elif by_source:
        results = db_obj.get_stats_by_source()
        if output_json:
            click.echo(json.dumps(results, indent=2))
        else:
            columns = ["source", "total", "addressed", "not_addressed", "skipped", "addressed_rate"]
            click.echo(_format_table(results, columns))


@db.command("patterns")
@click.option("--min", "min_occurrences", default=2, help="Minimum occurrences to report")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.option("--db-path", help="Path to database file")
def db_patterns(min_occurrences: int, output_json: bool, db_path: str | None) -> None:
    """Find recurring dismissed patterns.

    Identifies comments that appear multiple times with similar content,
    suggesting a pattern that should perhaps be configured as an auto-skip rule.

    Examples:

        # Find patterns with at least 2 occurrences (default)
        myk-pi-tools db patterns

        # Find patterns with at least 3 occurrences
        myk-pi-tools db patterns --min 3

        # JSON output
        myk-pi-tools db patterns --json
    """
    db_obj = ReviewDB(db_path=Path(db_path) if db_path else None)
    results = db_obj.get_duplicate_patterns(min_occurrences=min_occurrences)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        click.echo(_format_table(results, ["path", "occurrences", "reason", "body_sample"]))


@db.command("dismissed")
@click.option("--owner", required=True, help="Repository owner (org or user)")
@click.option("--repo", required=True, help="Repository name")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.option("--db-path", help="Path to database file")
def db_dismissed(owner: str, repo: str, output_json: bool, db_path: str | None) -> None:
    """Get dismissed comments for a repo.

    Retrieves all not_addressed or skipped comments for a repository.
    Useful for identifying recurring patterns or auto-skip logic.

    Examples:

        # Get dismissed comments
        myk-pi-tools db dismissed --owner myk-org --repo pi-config

        # JSON output
        myk-pi-tools db dismissed --owner myk-org --repo pi-config --json
    """
    db_obj = ReviewDB(db_path=Path(db_path) if db_path else None)
    results = db_obj.get_dismissed_comments(owner, repo)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        click.echo(_format_table(results, ["path", "line", "status", "reply", "author"]))


@db.command("query")
@click.argument("sql")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.option("--db-path", help="Path to database file")
def db_query(sql: str, output_json: bool, db_path: str | None) -> None:
    """Run a raw SELECT query.

    Only SELECT statements are allowed for safety. This command is useful
    for ad-hoc queries and exploration of the data.

    Examples:

        # Get all skipped comments
        myk-pi-tools db query "SELECT * FROM comments WHERE status = 'skipped'"

        # Count by status
        myk-pi-tools db query "SELECT status, COUNT(*) as cnt FROM comments GROUP BY status"

        # JSON output
        myk-pi-tools db query "SELECT * FROM comments LIMIT 5" --json
    """
    db_obj = ReviewDB(db_path=Path(db_path) if db_path else None)

    try:
        results = db_obj.query(sql)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    if output_json:
        click.echo(json.dumps(results, indent=2))
    else:
        click.echo(_format_table(results))


@db.command("find-similar")
@click.option("--owner", required=True, help="Repository owner (org or user)")
@click.option("--repo", required=True, help="Repository name")
@click.option("--threshold", type=float, default=0.6, help="Minimum similarity threshold (0.0-1.0)")
@click.option("--json", "output_json", is_flag=True, help="Output as JSON")
@click.option("--db-path", help="Path to database file")
def db_find_similar(owner: str, repo: str, threshold: float, output_json: bool, db_path: str | None) -> None:
    """Find a previously dismissed comment matching path/body.

    Reads JSON from stdin with 'path' and 'body' fields. Uses exact path match
    combined with body similarity (Jaccard word overlap). This is useful for
    auto-skip logic: if a similar comment was previously dismissed with a reason,
    the same reason may apply.

    Examples:

        # Find similar comment
        echo '{"path": "foo.py", "body": "Add error handling..."}' | \\
            myk-pi-tools db find-similar --owner myk-org --repo pi-config --json
    """
    # Validate threshold range
    if threshold < 0.0 or threshold > 1.0:
        click.echo("Error: --threshold must be between 0.0 and 1.0", err=True)
        sys.exit(1)

    # Read JSON from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        click.echo(f"Error: Invalid JSON input: {e}", err=True)
        sys.exit(1)

    path = input_data.get("path", "")
    body = input_data.get("body", "")

    if not path or not body:
        click.echo("Error: JSON must contain 'path' and 'body' fields", err=True)
        sys.exit(1)

    db_obj = ReviewDB(db_path=Path(db_path) if db_path else None)
    result = db_obj.find_similar_comment(owner, repo, path, body, threshold=threshold)

    if output_json:
        click.echo(json.dumps(result, indent=2))
    else:
        if result:
            click.echo(f"Found similar comment (similarity: {result['similarity']:.2f}):")
            click.echo(f"  Path: {result['path']}:{result['line']}")
            click.echo(f"  Status: {result['status']}")
            click.echo(f"  Reason: {result['reply']}")
            click.echo(f"  Original body: {result['body'][:100]}...")
        else:
            click.echo("No similar comment found")
