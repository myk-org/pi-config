"""List available models for an AI CLI provider."""

from __future__ import annotations

import asyncio
import json
import sys


def _print_stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


def list_models(provider: str) -> int:
    """List available models for a provider. Outputs JSON to stdout.

    Returns exit code (0 = success, 1 = error).
    """
    from ai_cli_runner import model_cache

    _print_stderr(f"[ai-cli] Fetching models for {provider}...")

    try:
        models = asyncio.run(model_cache.list_models(provider))
    except Exception as e:
        _print_stderr(f"[ai-cli] Error fetching models: {e}")
        return 1

    if not models:
        _print_stderr(f"[ai-cli] No models found for {provider}")
        print("[]")
        return 0

    _print_stderr(f"[ai-cli] Found {len(models)} model(s)")
    print(json.dumps(models, indent=2))
    return 0
