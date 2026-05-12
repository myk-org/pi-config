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
@click.option("--resume", is_flag=True, help="Continue the last session")
@click.option("--cwd", default=None, help="Working directory (default: current)")
def run_cmd(prompt: str, provider: str, model: str, resume: bool, cwd: str | None) -> None:
    """Run a prompt via AI CLI.

    PROMPT: The prompt text to send to the AI CLI.
    """
    from myk_pi_tools.ai_cli.run import run

    sys.exit(run(prompt=prompt, provider=provider, model=model, resume=resume, cwd=cwd))


@ai_cli.command("models")
@click.argument("provider", type=click.Choice(["cursor", "claude", "gemini"]))
def models_cmd(provider: str) -> None:
    """List available models for a provider.

    PROVIDER: AI provider (cursor, claude, gemini)
    """
    from myk_pi_tools.ai_cli.models import list_models

    sys.exit(list_models(provider))
