"""Full live e2e via pi_sidecar_client — pytest + fixtures.

Client API is provider + model. Live tests are parametrized over every provider
from installed CLIs (cli-* + acpx-*) plus native google.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

import httpx
import pytest

from pi_sidecar_client import SidecarClient
from tests.e2e.helpers import logged_call_ai_once, logged_prompt

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]

logger = logging.getLogger("e2e")


def _provider_status_log_fields(st: dict) -> dict:
    """Non-sensitive provider-status fields safe for e2e logs."""
    auth_status = st.get("authStatus")
    return {
        "registered": st.get("registered"),
        "modelCount": st.get("modelCount"),
        "auth_configured": (auth_status.get("configured") if isinstance(auth_status, dict) else None),
    }


# --- sidecar smoke (no provider param) ---


async def test_health(client: SidecarClient) -> None:
    h = await client.health()
    logger.info("health=%s", h)
    assert h.get("status") == "ok", h


async def test_models_list(models: list[dict]) -> None:
    providers = sorted({m["provider"] for m in models})
    logger.info("models count=%d providers=%s", len(models), providers)
    assert models, "expected non-empty model list"
    assert providers


async def test_models_refresh(client: SidecarClient) -> None:
    refreshed = await client.refresh_models()
    logger.info("refresh models count=%d", len(refreshed))
    assert isinstance(refreshed, list)
    assert refreshed


async def test_status_unknown_404(client: SidecarClient) -> None:
    with pytest.raises(httpx.HTTPStatusError) as ei:
        await client.get_model_provider_status("totally-unknown-xyz")
    assert ei.value.response.status_code == 404


async def test_status_github_copilot_excluded(client: SidecarClient) -> None:
    try:
        st = await client.get_model_provider_status("github-copilot")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            pytest.skip("github-copilot not registered")
        raise
    logger.info("status github-copilot=%s", _provider_status_log_fields(st))
    assert st.get("modelCount") == 0
    assert st.get("authCheck") is None


# --- validation: no working_models / no LLM probe ---


async def test_validate_custom_tools_whitespace(client: SidecarClient, test_cwd: Path) -> None:
    logger.info("SEND create_session custom_tools=[{'name': '  '}] (expect 400)")
    with pytest.raises(httpx.HTTPStatusError) as ei:
        await client.create_session(
            provider="google",
            model="unused-validation-only",
            system_prompt="hi",
            cwd=str(test_cwd),
            custom_tools=[{"name": "  "}],
        )
    logger.info("RECV status=%s body=%s", ei.value.response.status_code, ei.value.response.text)
    assert ei.value.response.status_code == 400


async def test_validate_agent_dir_relative(client: SidecarClient, test_cwd: Path) -> None:
    logger.info("SEND create_session agent_dir=relative/path (expect 400)")
    with pytest.raises(httpx.HTTPStatusError) as ei:
        await client.create_session(
            provider="google",
            model="unused-validation-only",
            system_prompt="hi",
            cwd=str(test_cwd),
            agent_dir="relative/path",
        )
    logger.info("RECV status=%s body=%s", ei.value.response.status_code, ei.value.response.text)
    assert ei.value.response.status_code == 400


async def test_reject_github_copilot_create(client: SidecarClient, test_cwd: Path) -> None:
    logger.info("SEND create_session provider=github-copilot (expect 400)")
    with pytest.raises(httpx.HTTPStatusError) as ei:
        await client.create_session(
            provider="github-copilot",
            model="gpt-4o",
            system_prompt="hi",
            cwd=str(test_cwd),
        )
    logger.info("RECV status=%s body=%s", ei.value.response.status_code, ei.value.response.text)
    assert ei.value.response.status_code == 400


# --- live cases: parametrized over every provider ---


async def test_status_provider(client: SidecarClient, provider: str) -> None:
    try:
        st = await client.get_model_provider_status(provider)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            pytest.skip(f"{provider} not registered")
        raise
    logger.info("status provider=%s fields=%s", provider, _provider_status_log_fields(st))
    assert st.get("registered") is True, st


async def test_prompt(provider: str, model: str) -> None:
    result = await logged_call_ai_once(
        "Reply with exactly: BATTERY_OK",
        ai_provider=provider,
        ai_model=model,
        tools=["read", "ls"],
        ai_call_timeout=300,
    )
    assert result.success and result.text, (
        f"provider={provider} model={model} error={result.error} text={result.text!r}"
    )


async def test_multiturn(client: SidecarClient, provider: str, model: str, test_cwd: Path) -> None:
    logger.info("SEND create_session provider=%s model=%s multiturn", provider, model)
    sid = await client.create_session(
        provider=provider,
        model=model,
        system_prompt="Concise.",
        cwd=str(test_cwd),
        tools=[],
    )
    try:
        r1 = await logged_prompt(
            client,
            sid,
            "Remember codeword ZEPHYR42. Reply OK.",
            provider=provider,
            model=model,
        )
        r2 = await logged_prompt(
            client,
            sid,
            "What was the codeword? Reply only the codeword.",
            provider=provider,
            model=model,
        )
        assert r1.success and r2.success and r2.text, f"e1={r1.error} e2={r2.error} t2={r2.text!r}"
    finally:
        await client.delete_session(sid)


async def test_subagent_session(client: SidecarClient, provider: str, model: str, test_cwd: Path) -> None:
    sid = await client.create_session(
        provider=provider,
        model=model,
        system_prompt="Do not call tools. Reply SUBAGENT_READY.",
        cwd=str(test_cwd),
        tools=["read", "ls", "bash", "subagent"],
    )
    try:
        r = await logged_prompt(
            client,
            sid,
            "Reply SUBAGENT_READY without calling tools.",
            provider=provider,
            model=model,
        )
        assert r.success and r.text, f"error={r.error} text={r.text!r}"
    finally:
        await client.delete_session(sid)


async def test_abort_inflight(client: SidecarClient, provider: str, model: str, test_cwd: Path) -> None:
    sid = await client.create_session(
        provider=provider,
        model=model,
        system_prompt="Verbose.",
        cwd=str(test_cwd),
        tools=[],
    )
    try:
        prompt = "Count slowly from 1 to 200 in words. Be extremely verbose."
        logger.info("SEND abort-inflight provider=%s model=%s prompt=%r", provider, model, prompt)
        task = asyncio.create_task(client.prompt(sid, prompt))
        await asyncio.sleep(0.5)
        await client.abort(sid)
        logger.info("SEND abort session=%s", sid)
        try:
            result = await asyncio.wait_for(task, timeout=90)
        except TimeoutError:
            pytest.fail("in-flight prompt did not settle within 90s after abort")
        except Exception as exc:
            # Abort may tear down the HTTP stream; that is an acceptable outcome.
            logger.info("RECV after abort exception=%s", exc)
            return
        logger.info(
            "RECV after abort success=%s error=%r text=%r",
            result.success,
            result.error,
            result.text,
        )
        # Prompt settled: either aborted (error) or finished before abort took effect.
        assert isinstance(result.success, bool)
        if not result.success:
            assert result.error, "unsuccessful prompt after abort must set error"
    finally:
        try:
            await client.delete_session(sid)
        except Exception:
            logger.warning(
                "delete_session failed after abort test provider=%s model=%s session=%s",
                provider,
                model,
                sid,
                exc_info=True,
            )


@pytest.mark.parametrize("idx", [0, 1, 2], ids=["p0", "p1", "p2"])
async def test_parallel_session(provider: str, model: str, idx: int) -> None:
    result = await logged_call_ai_once(
        f"Reply with exactly: P{idx}",
        ai_provider=provider,
        ai_model=model,
        tools=[],
        ai_call_timeout=120,
    )
    assert result.success and result.text, f"error={result.error} text={result.text!r}"


async def test_delete_then_prompt_404(client: SidecarClient, provider: str, model: str, test_cwd: Path) -> None:
    sid = await client.create_session(
        provider=provider,
        model=model,
        system_prompt="hi",
        cwd=str(test_cwd),
        tools=[],
    )
    await client.delete_session(sid)
    logger.info("SEND prompt on deleted session=%s", sid)
    result = await client.prompt(sid, "hi")
    logger.info("RECV success=%s error=%r", result.success, result.error)
    assert not result.success
    assert result.error
    assert "404" in result.error or "not found" in result.error.lower()


async def test_tool_ls(provider: str, model: str, test_cwd: Path) -> None:
    result = await logged_call_ai_once(
        "Use the ls tool on the current directory, then reply DONE.",
        ai_provider=provider,
        ai_model=model,
        tools=["ls"],
        cwd=str(test_cwd),
        ai_call_timeout=180,
    )
    assert result.success and result.text, f"error={result.error} text={result.text!r}"


async def test_subagent_invoke(
    client: SidecarClient,
    provider: str,
    model: str,
    test_cwd: Path,
    project_math_agent: Path,
) -> None:
    assert project_math_agent.is_file()
    assert (test_cwd / ".claude" / "agents" / "e2e-math.md").is_file()
    assert (test_cwd / ".gemini" / "agents" / "e2e-math.md").is_file()

    # Native Pi uses the subagent extension; Claude/Gemini CLIs use their own agent tools.
    if "claude" in provider:
        tools = ["read", "ls"]
        system_prompt = (
            "You MUST call the Agent tool exactly once. "
            'Required args: description="math", subagent_type="e2e-math", '
            'prompt="What is 2+2? Reply with only the number.". '
            "After the tool returns, reply with only the subagent's numeric answer."
        )
        user_prompt = (
            'Call Agent with subagent_type="e2e-math", description="math", '
            'prompt="What is 2+2? Reply with only the number.". '
            "Then reply with only the number from the tool result."
        )
    elif "gemini" in provider and provider != "google":
        # cli-gemini / acpx-gemini — Gemini CLI subagents from .gemini/agents/
        tools = ["read", "ls"]
        system_prompt = (
            "You MUST delegate to the e2e-math subagent exactly once "
            "(via @e2e-math or the subagent tool). "
            "Task: What is 2+2? After it returns, reply with only the numeric answer."
        )
        user_prompt = (
            "Delegate to @e2e-math: What is 2+2? Reply with only the number. Then reply with only that number."
        )
    else:
        tools = ["subagent"]
        system_prompt = (
            "You MUST call the subagent tool exactly once. "
            'Required args: agent="e2e-math", agentScope="both", '
            "confirmProjectAgents=false. Do not invent other agent names. "
            "After the tool returns, reply with only the subagent's numeric answer."
        )
        user_prompt = (
            'Call subagent with agent="e2e-math", agentScope="both", '
            'confirmProjectAgents=false, task="What is 2+2?". '
            "Then reply with only the number from the tool result."
        )

    sid = await client.create_session(
        provider=provider,
        model=model,
        system_prompt=system_prompt,
        cwd=str(test_cwd),
        tools=tools,
    )
    try:
        r = await logged_prompt(
            client,
            sid,
            user_prompt,
            provider=provider,
            model=model,
        )
        text = (r.text or "").strip()
        low = text.lower()
        failure_markers = (
            "not available",
            "does not exist",
            "cannot fulfill",
            "unable to",
            "no such agent",
            "unknown agent",
            "not found",
            "failed to produce",
            "calculator",
            "don't match the actual tool",
            "does not exist in the Agent tool",
        )
        assert not r.error, f"error={r.error} text={text!r}"
        assert not any(m in low for m in failure_markers), f"failure phrase: {text!r}"
        assert re.search(r"\b4\b", text), f"expected 4, got {text!r}"
    finally:
        await client.delete_session(sid)


async def test_health_final(client: SidecarClient) -> None:
    h = await client.health()
    logger.info("health_final=%s", h)
    assert h.get("status") == "ok", h
