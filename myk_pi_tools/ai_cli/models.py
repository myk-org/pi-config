"""List available models for an AI CLI provider."""

from __future__ import annotations

import asyncio
import json

import click


def list_models(provider: str) -> int:
    """List available models for a provider. Outputs JSON to stdout.

    Returns exit code (0 = success, 1 = error).
    """
    from ai_cli_runner import model_cache

    click.echo(f"[ai-cli] Fetching models for {provider}...", err=True)

    try:
        models = asyncio.run(model_cache.list_models(provider))
    except (OSError, TimeoutError) as e:
        click.echo(f"[ai-cli] Error fetching models: {e}", err=True)
        return 1

    if not models:
        click.echo(f"[ai-cli] No models found for {provider}", err=True)
        print("[]")
        return 0

    click.echo(f"[ai-cli] Found {len(models)} model(s)", err=True)
    print(json.dumps(models, indent=2))
    return 0
