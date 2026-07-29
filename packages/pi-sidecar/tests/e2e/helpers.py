"""Shared e2e logging helpers (SEND prompt / RECV LLM text)."""

from __future__ import annotations

import logging

from pi_sidecar_client import AIResult, SidecarClient, call_ai_once

logger = logging.getLogger("e2e")


def log_send(
    *,
    provider: str,
    model: str,
    prompt: str,
    tools: list[str] | None = None,
    session_id: str | None = None,
) -> None:
    logger.info(
        "SEND provider=%s model=%s session=%s tools=%s prompt=%r",
        provider,
        model,
        session_id or "new",
        tools,
        prompt,
    )


def log_recv(result: AIResult, *, provider: str, model: str) -> None:
    logger.info(
        "RECV provider=%s model=%s success=%s error=%r text=%r",
        provider,
        model,
        result.success,
        result.error,
        result.text,
    )


async def logged_call_ai_once(
    prompt: str,
    *,
    ai_provider: str,
    ai_model: str,
    tools: list[str] | None = None,
    cwd: str | None = None,
    system_prompt: str = "",
    ai_call_timeout: int | None = None,
) -> AIResult:
    log_send(provider=ai_provider, model=ai_model, prompt=prompt, tools=tools)
    result = await call_ai_once(
        prompt,
        ai_provider=ai_provider,
        ai_model=ai_model,
        tools=tools,
        cwd=cwd,
        system_prompt=system_prompt,
        ai_call_timeout=ai_call_timeout,
    )
    log_recv(result, provider=ai_provider, model=ai_model)
    return result


async def logged_prompt(
    client: SidecarClient,
    session_id: str,
    prompt: str,
    *,
    provider: str,
    model: str,
) -> AIResult:
    log_send(provider=provider, model=model, prompt=prompt, session_id=session_id)
    result = await client.prompt(session_id, prompt)
    log_recv(result, provider=provider, model=model)
    return result
