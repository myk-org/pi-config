"""Main CLI entry point for myk-pi-tools."""

from __future__ import annotations

import importlib
from typing import Any

import click

_LAZY_SUBCOMMANDS: dict[str, str] = {
    "ai-cli": "myk_pi_tools.ai_cli.commands:ai_cli",
    "coderabbit": "myk_pi_tools.coderabbit.commands:coderabbit",
    "db": "myk_pi_tools.db.commands:db",
    "memory": "myk_pi_tools.memory.commands:memory",
    "pr": "myk_pi_tools.pr.commands:pr",
    "release": "myk_pi_tools.release.commands:release",
    "reviews": "myk_pi_tools.reviews.commands:reviews",
    "settings": "myk_pi_tools.settings.commands:settings",
}


class LazyGroup(click.Group):
    """Click group that imports subcommands lazily on demand."""

    def __init__(self, *args: Any, lazy_subcommands: dict[str, str] | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.lazy_subcommands = lazy_subcommands or {}

    def list_commands(self, ctx: click.Context) -> list[str]:
        base = super().list_commands(ctx)
        return sorted(set(base) | set(self.lazy_subcommands))

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        if cmd_name in self.lazy_subcommands:
            return self._lazy_load(cmd_name)
        return super().get_command(ctx, cmd_name)

    def _lazy_load(self, cmd_name: str) -> click.Command:
        import_path = self.lazy_subcommands[cmd_name]
        modname, attr = import_path.split(":", 1)
        mod = importlib.import_module(modname)
        cmd = getattr(mod, attr)
        if not isinstance(cmd, click.Command):
            raise TypeError(f"Lazy loading of {import_path} failed: not a click.Command")
        return cmd


@click.group(cls=LazyGroup, lazy_subcommands=_LAZY_SUBCOMMANDS)
@click.version_option()
def cli() -> None:
    """CLI utilities for pi orchestrator plugins."""


def main() -> None:
    """Entry point."""
    cli()


if __name__ == "__main__":
    main()
