"""AI CLI commands — wrapper around ai-cli-runner."""

import sys

import click


@click.group()
def ai_cli() -> None:
    """AI CLI commands (cursor, claude, gemini)."""


@ai_cli.command("run")
@click.argument("prompt")
@click.option("--provider", "-p", required=True, type=click.Choice(["cursor", "claude", "gemini"]), help="AI provider")
@click.option("--model", "-m", default="", help="Model name (e.g., gpt-5.4-high). Empty = provider default")
@click.option("--resume", is_flag=True, help="Continue the most recent session")
@click.option("--session-id", default=None, help="Resume a specific session by ID")
@click.option("--cwd", default=None, help="Working directory (default: current)")
@click.option(
    "--cli-flags",
    multiple=True,
    help="Extra CLI flags (repeatable, e.g. --cli-flags=--trust)",
)
def run_cmd(
    prompt: str,
    provider: str,
    model: str,
    resume: bool,
    session_id: str | None,
    cwd: str | None,
    cli_flags: tuple[str, ...],
) -> None:
    """Run a prompt via AI CLI.

    PROMPT: The prompt text to send to the AI CLI.
    """
    if session_id and resume:
        click.echo("Error: --session-id and --resume are mutually exclusive.", err=True)
        sys.exit(1)

    if session_id and session_id.startswith("-"):
        click.echo("Error: --session-id value must not start with '-'", err=True)
        sys.exit(1)

    from myk_pi_tools.ai_cli.run import run

    sys.exit(
        run(
            prompt=prompt,
            provider=provider,
            model=model,
            resume=resume,
            session_id=session_id,
            cwd=cwd,
            cli_flags=list(cli_flags),
        )
    )


@ai_cli.command("save-config")
@click.option("--agents", default=None, help="Save lastAgents value (e.g., 'cursor --model gpt-5.4-high')")
@click.option("--peers", default=None, help="Save lastPeers value (e.g., 'cursor,claude')")
def save_config_cmd(agents: str | None, peers: str | None) -> None:
    """Save agent/peer config for /external-ai.

    Persists to .pi/external-ai-config.json. Each option updates only its
    field — the other field is preserved.
    """
    import json
    from pathlib import Path

    if agents is None and peers is None:
        click.echo("Error: Pass --agents and/or --peers", err=True)
        sys.exit(1)

    config_path = Path(".pi/external-ai-config.json")
    config_path.parent.mkdir(parents=True, exist_ok=True)

    cfg: dict[str, str] = {}
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
        except (json.JSONDecodeError, OSError):
            cfg = {}

    if agents is not None:
        cfg["lastAgents"] = agents
    if peers is not None:
        cfg["lastPeers"] = peers

    config_path.write_text(json.dumps(cfg, indent=2) + "\n")
    click.echo(json.dumps(cfg, indent=2))


@ai_cli.command("models")
@click.argument("provider", type=click.Choice(["cursor", "claude", "gemini"]))
def models_cmd(provider: str) -> None:
    """List available models for a provider.

    PROVIDER: AI provider (cursor, claude, gemini)
    """
    from myk_pi_tools.ai_cli.models import list_models

    sys.exit(list_models(provider))
