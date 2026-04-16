"""Main CLI entry point for myk-pi-tools."""

import click

from myk_pi_tools.coderabbit import commands as coderabbit_commands
from myk_pi_tools.db import commands as db_commands
from myk_pi_tools.memory import commands as memory_commands
from myk_pi_tools.pr import commands as pr_commands
from myk_pi_tools.release import commands as release_commands
from myk_pi_tools.reviews import commands as reviews_commands


@click.group()
@click.version_option()
def cli() -> None:
    """CLI utilities for pi orchestrator plugins."""


cli.add_command(coderabbit_commands.coderabbit, name="coderabbit")
cli.add_command(db_commands.db, name="db")
cli.add_command(memory_commands.memory, name="memory")
cli.add_command(pr_commands.pr, name="pr")
cli.add_command(release_commands.release, name="release")
cli.add_command(reviews_commands.reviews, name="reviews")


def main() -> None:
    """Entry point."""
    cli()


if __name__ == "__main__":
    main()
