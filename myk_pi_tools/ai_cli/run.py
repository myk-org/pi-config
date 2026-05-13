"""Run a prompt via ai-cli-runner."""

from __future__ import annotations

import asyncio
import json
import traceback
from pathlib import Path
from typing import TYPE_CHECKING

import click

if TYPE_CHECKING:
    from ai_cli_runner import AIResult

# Default models per provider — matches each CLI's default behavior
_DEFAULT_MODELS: dict[str, str] = {
    "cursor": "composer-2-fast",
    "claude": "claude-sonnet-4-6",
    "gemini": "gemini-2.5-flash",
}


async def _run_async(
    prompt: str,
    provider: str,
    model: str,
    cwd: Path,
    cli_flags: list[str],
    session_id: str | None = None,
    continue_session: bool = False,
) -> AIResult:
    """Load pricing and run the AI CLI call in a single event loop."""
    from ai_cli_runner import call_ai_cli, pricing_cache

    await pricing_cache.load()
    return await call_ai_cli(
        prompt=prompt,
        cwd=cwd,
        ai_provider=provider,
        ai_model=model,
        cli_flags=cli_flags,
        output_format="json",
        session_id=session_id,
        continue_session=continue_session,
    )


def run(
    prompt: str,
    provider: str,
    model: str = "",
    resume: bool = False,
    session_id: str | None = None,
    cwd: str | None = None,
) -> int:
    """Run a prompt via ai-cli-runner.

    Returns exit code (0 = success, 1 = error).
    """
    session_id = session_id or None  # Normalize "" to None for programmatic callers

    # Defense-in-depth: also validated in commands.py CLI layer
    if resume and session_id:
        click.echo("Error: --session-id and --resume are mutually exclusive.", err=True)
        return 1

    if session_id and session_id.startswith("-"):
        click.echo("Error: --session-id value must not start with '-'", err=True)
        return 1

    effective_model = model or _DEFAULT_MODELS.get(provider, "")
    if not effective_model:
        click.echo(f"Error: No default model for provider '{provider}' and no --model specified.", err=True)
        return 1

    effective_cwd = Path(cwd) if cwd else Path.cwd()

    cli_flags: list[str] = []
    continue_session = resume  # session_id mutual exclusivity already guarded above

    suffix = f", session={session_id}" if session_id else ", resume" if continue_session else ""
    click.echo(f"[ai-cli] {provider.upper()} ({effective_model}{suffix})", err=True)

    try:
        result = asyncio.run(
            _run_async(
                prompt=prompt,
                provider=provider,
                model=effective_model,
                cwd=effective_cwd,
                cli_flags=cli_flags,
                session_id=session_id,
                continue_session=continue_session,
            )
        )
    except Exception as e:
        click.echo(traceback.format_exc(), err=True)
        error_out: dict[str, object] = {
            "success": False,
            "provider": provider,
            "model": effective_model,
            "error": str(e),
        }
        if session_id:
            error_out["session_id"] = session_id
        print(json.dumps(error_out, indent=2))
        return 1

    output: dict[str, object] = {
        "success": result.success,
        "provider": provider,
        "model": effective_model,
    }

    if result.success:
        output["text"] = result.text
        if result.session_id:
            output["session_id"] = result.session_id
        elif session_id:
            output["session_id"] = session_id
        if result.usage:
            output["usage"] = {
                "provider": result.usage.provider,
                "model": result.usage.model,
                "input_tokens": result.usage.input_tokens,
                "output_tokens": result.usage.output_tokens,
                "cache_read_tokens": result.usage.cache_read_tokens,
                "cache_write_tokens": result.usage.cache_write_tokens,
                "cost_usd": result.usage.cost_usd,
                "duration_ms": result.usage.duration_ms,
            }
    else:
        output["error"] = result.text or "Unknown error (no details from provider)"
        if session_id:
            output["session_id"] = session_id

    print(json.dumps(output, indent=2))
    return 0 if result.success else 1
