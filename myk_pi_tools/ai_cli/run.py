"""Run a prompt via ai-cli-runner."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

# Default models per provider — matches each CLI's default behavior
_DEFAULT_MODELS: dict[str, str] = {
    "cursor": "composer-2-fast",
    "claude": "claude-sonnet-4-6",
    "gemini": "gemini-2.5-flash",
}

# Session resume flags per provider
_RESUME_FLAGS: dict[str, list[str]] = {
    "cursor": ["--continue"],
    "claude": ["-c"],
    "gemini": ["--resume", "latest"],
}


def _print_stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


def run(
    prompt: str,
    provider: str,
    model: str = "",
    resume: bool = False,
    cwd: str | None = None,
) -> int:
    """Run a prompt via ai-cli-runner.

    Returns exit code (0 = success, 1 = error).
    """
    from ai_cli_runner import call_ai_cli, pricing_cache

    # Load LiteLLM pricing data for cost calculation (Cursor/Gemini don't report cost natively)
    asyncio.run(pricing_cache.load())

    effective_model = model or _DEFAULT_MODELS.get(provider, "")
    if not effective_model:
        _print_stderr(f"Error: No default model for provider '{provider}' and no --model specified.")
        return 1

    effective_cwd = Path(cwd) if cwd else Path.cwd()

    cli_flags: list[str] = []
    if resume:
        cli_flags.extend(_RESUME_FLAGS.get(provider, []))

    _print_stderr(f"[ai-cli] {provider.upper()} ({effective_model})")

    result = asyncio.run(
        call_ai_cli(
            prompt=prompt,
            cwd=effective_cwd,
            ai_provider=provider,
            ai_model=effective_model,
            cli_flags=cli_flags,
            output_format="json",
        )
    )

    if result.success:
        print(result.text)
        if result.usage:
            usage_info: dict[str, object] = {
                "input_tokens": result.usage.input_tokens,
                "output_tokens": result.usage.output_tokens,
            }
            if result.usage.cache_read_tokens:
                usage_info["cache_read_tokens"] = result.usage.cache_read_tokens
            if result.usage.cache_write_tokens:
                usage_info["cache_write_tokens"] = result.usage.cache_write_tokens
            if result.usage.cost_usd is not None:
                usage_info["cost_usd"] = result.usage.cost_usd
            if result.usage.duration_ms is not None:
                usage_info["duration_ms"] = result.usage.duration_ms
            _print_stderr(f"[ai-cli] Usage: {json.dumps(usage_info)}")
        return 0

    _print_stderr(f"[ai-cli] Error: {result.text}")
    return 1
