import asyncio
import inspect
import json
import os
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from types import ModuleType
from typing import TYPE_CHECKING, Any, TypedDict
from urllib.parse import quote

import httpx
from simple_logger.logger import get_logger

logger = get_logger(name=__name__, level=os.environ.get("PI_SIDECAR_LOG_LEVEL", "INFO"))

DEFAULT_SIDECAR_URL = "http://127.0.0.1:9100"
DEFAULT_CWD = tempfile.gettempdir()


def _default_sidecar_url() -> str:
    """Return the sidecar base URL from SIDECAR_URL env or DEFAULT_SIDECAR_URL."""
    return os.environ.get("SIDECAR_URL", DEFAULT_SIDECAR_URL)


def _normalize_sidecar_url(value: str) -> str:
    """Normalize a sidecar base URL (trailing slashes stripped, like SidecarClient)."""
    return value.rstrip("/")


MAX_API_KEY_LENGTH = 1024
MAX_ERROR_DETAIL_LENGTH = 2048


def _validate_api_key(api_key: str) -> str | None:
    """Return a safe validation error, or None for a usable key."""
    # JavaScript String.trim whitespace (Python str.strip also strips C1 controls).
    js_whitespace = "\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff" + "".join(
        chr(codepoint) for codepoint in range(0x2000, 0x200B)
    )
    if not api_key.strip(js_whitespace):
        outcome, error = "blank", "Invalid api_key: blank"
    else:
        try:
            length = len(api_key.encode("utf-16-le")) // 2
        except UnicodeEncodeError:
            outcome, error = "malformed", "Invalid api_key: unpaired Unicode surrogate"
        else:
            if length > MAX_API_KEY_LENGTH:
                outcome, error = "oversized", f"Invalid api_key: exceeds {MAX_API_KEY_LENGTH} characters"
            else:
                outcome, error = "accepted", None
    logger.debug("API key validation: outcome=%s", outcome)
    return error


def _redact_api_key(value: str, api_key: str | None) -> str:
    """Mask mixed literal, JSON/Unicode and percent-escaped key characters without regex."""
    if not api_key:
        return value
    # Bound work on untrusted errors, and never return an unscanned secret suffix.
    if len(value) > MAX_ERROR_DETAIL_LENGTH:
        return "[error detail omitted]"
    # Bit i represents the option for key character i. Match tokens once per
    # error position rather than comparing every key character at every position.
    exact: dict[tuple[int, str], int] = {}
    folded: dict[tuple[int, str], int] = {}
    for index, char in enumerate(api_key):
        escaped = json.dumps(char, ensure_ascii=True)[1:-1]
        encoded = "".join(f"%{byte:02X}" for byte in char.encode("utf-8"))
        options = [(char, exact), (encoded.lower(), folded)]
        if escaped != char:
            options.append((
                escaped.lower() if escaped.startswith("\\u") else escaped,
                folded if escaped.startswith("\\u") else exact,
            ))
        for token, table in options:
            slot = (len(token), token)
            table[slot] = table.get(slot, 0) | (1 << index)

    lengths = {length for length, _ in exact} | {length for length, _ in folded}
    matches: list[list[tuple[int, int]]] = []
    for pos in range(len(value)):
        options_at_pos = []
        for length in lengths:
            if pos + length > len(value):
                continue
            candidate = value[pos : pos + length]
            mask = exact.get((length, candidate), 0)
            # Percent hex digits and the digits after a literal \\u are case-insensitive.
            if candidate.startswith("%") or candidate.startswith("\\u"):
                mask |= folded.get((length, candidate.lower()), 0)
            if mask:
                options_at_pos.append((length, mask))
        matches.append(options_at_pos)

    # Backward bitset DP: bit i means the remaining key from i matches here.
    final = 1 << len(api_key)
    suffix = [final] * (len(value) + 1)
    for pos in range(len(value) - 1, -1, -1):
        for length, mask in matches[pos]:
            suffix[pos] |= (suffix[pos + length] >> 1) & mask

    output: list[str] = []
    start = pos = 0
    while pos < len(value):
        if not suffix[pos] & 1:
            pos += 1
            continue
        # Only trace a complete match at the next emitted redaction. Preserve
        # the longest encoding when multiple parses share a starting position.
        pending = {pos: 1}
        end = pos
        for current in range(pos, len(value) + 1):
            states = pending.pop(current, 0)
            if not states and not pending:
                break
            if states & final:
                end = current
            if current == len(value):
                continue
            for length, mask in matches[current]:
                next_pos = current + length
                advanced = ((states & mask) << 1) & suffix[next_pos]
                if advanced:
                    pending[next_pos] = pending.get(next_pos, 0) | advanced
        output.extend((value[start:pos], "[redacted]"))
        pos = start = end
    output.append(value[start:])
    return "".join(output)


if TYPE_CHECKING:
    # Runtime value is provided by _PiSidecarClientModule.__getattr__ (reads SIDECAR_URL env).
    SIDECAR_URL: str

__all__ = [
    "AIResult",
    "AITokenUsage",
    "ProviderDiscovery",
    "SIDECAR_URL",
    "SidecarClient",
    "call_ai",
    "call_ai_once",
    "check_sidecar_available",
    "get_sidecar_client",
    "list_models",
    "run_parallel_with_limit",
    "set_usage_recorder",
]


class ProviderDiscovery(TypedDict):
    """Provider identity and session API key capability from GET /providers."""

    provider: str
    supportsSessionApiKey: bool


@dataclass
class AITokenUsage:
    """Token usage data from an AI call."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float | None = None
    duration_ms: int | None = None
    provider: str = ""
    model: str = ""
    session_id: str = ""


# Module-level callback — consumers register their storage function
_usage_recorder: Callable | None = None


def set_usage_recorder(callback: Callable) -> None:
    """Register a callback for recording AI token usage.

    The callback may be sync or async:
        def recorder(*, request_id, result, call_type, prompt_chars, ai_provider, ai_model)
        async def recorder(*, request_id, result, call_type, prompt_chars, ai_provider, ai_model)
    """
    global _usage_recorder
    _usage_recorder = callback


@dataclass
class AIResult:
    """Result from an AI call."""

    success: bool
    text: str
    usage: AITokenUsage | None = None
    session_id: str | None = None
    error: str | None = None

    async def record_usage(
        self,
        *,
        request_id: str,
        call_type: str,
        prompt_chars: int = 0,
        ai_provider: str = "",
        ai_model: str = "",
    ) -> None:
        """Record token usage via the registered callback. Best-effort — never raises."""
        if not _usage_recorder:
            return
        try:
            maybe_coro = _usage_recorder(
                request_id=request_id,
                result=self,
                call_type=call_type,
                prompt_chars=prompt_chars,
                ai_provider=ai_provider,
                ai_model=ai_model,
            )
            if inspect.isawaitable(maybe_coro):
                await maybe_coro
        except Exception:
            logger.debug("Failed to record usage", exc_info=True)


# Provider mapping: friendly provider names → sidecar provider names
_PROVIDER_MAP = {
    "cursor": "acpx-cursor",
    "claude": "google-vertex-claude",
    "gemini": "google",
}


def _map_provider_model(provider: str, model: str, api_key: str | None = None) -> tuple[str, str]:
    """Map friendly provider/model names to sidecar provider/model."""
    sidecar_provider = _PROVIDER_MAP.get(provider, provider)
    sidecar_model = model
    # Cursor models need the cursor: prefix
    if sidecar_provider == "acpx-cursor" and not model.startswith("cursor:"):
        sidecar_model = f"cursor:{model}"
    if sidecar_provider != provider or sidecar_model != model:
        logger.debug(
            "Provider mapped: %s/%s → %s/%s",
            _redact_api_key(provider, api_key),
            _redact_api_key(model, api_key),
            _redact_api_key(sidecar_provider, api_key),
            _redact_api_key(sidecar_model, api_key),
        )
    return sidecar_provider, sidecar_model


class SidecarClient:
    """HTTP client for the Pi SDK sidecar service."""

    def __init__(self, base_url: str | None = None, *, verify: bool | str = True):
        # When base_url is omitted, re-read SIDECAR_URL from the environment at construction time.
        self._base_url = (base_url if base_url is not None else _default_sidecar_url()).rstrip("/")
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=600.0, verify=verify)
        self._closed = False
        logger.debug("SidecarClient created: url=%s, timeout=600s, verify=%s", self._base_url, verify)

    async def health(self) -> dict:
        """Check sidecar health."""
        logger.debug("Checking sidecar health: url=%s", self._base_url)
        resp = await self._client.get("/health")
        resp.raise_for_status()
        data = resp.json()
        logger.debug("Sidecar health response: %s", data)
        return data

    async def get_models(self) -> list[dict]:
        """Get available models."""
        logger.debug("Fetching models from sidecar")
        resp = await self._client.get("/models")
        resp.raise_for_status()
        models = resp.json().get("models", [])
        logger.debug("Fetched %d models from sidecar", len(models))
        return models

    async def get_providers(self) -> list[ProviderDiscovery]:
        """Return providers and their session API key capability from the sidecar."""
        logger.debug("Fetching providers from sidecar")
        resp = await self._client.get("/providers")
        resp.raise_for_status()
        providers = resp.json()["providers"]
        logger.debug("Fetched %d providers from sidecar", len(providers))
        return providers

    async def refresh_models(self) -> list[dict]:
        """Trigger model discovery and return updated list."""
        logger.debug("Triggering model refresh on sidecar")
        resp = await self._client.post("/models/refresh")
        resp.raise_for_status()
        models = resp.json().get("models", [])
        logger.info("Model refresh complete: %d models available", len(models))
        return models

    async def get_model_provider_status(self: "SidecarClient", provider: str) -> dict:
        """Get registration, model count, and auth status for a single provider.

        Args:
            provider: Sidecar provider id, e.g. ``"google"``, ``"acpx-cursor"``,
                or ``"cli-cursor"``. URL-encoded before being placed in the path
                so ids containing reserved characters (e.g. ``/``) can't alter
                the request path.

        Returns:
            A dict mirroring the sidecar's ``GET /models/:provider/status``
            response (see ``ProviderStatus`` in ``src/sessions.ts``):

            - ``provider`` (str): the provider id that was queried.
            - ``registered`` (bool): whether the provider is currently
              registered on the shared ``ModelRuntime``.
            - ``modelCount`` (int): number of models known for this provider
              (from the acpx/cli snapshot cache for ``acpx-*``/``cli-*``
              providers, or the live catalog for builtins).
            - ``supportsSessionApiKey`` (bool): whether this provider accepts
              ``api_key`` on ``POST /sessions``. Independent of server auth;
              false for unknown, headless-excluded, and ambient CLI/ACPX providers.
              Included even on non-loopback binds and in 404 response bodies.
            - ``authStatus`` (dict | None): result of
              ``ModelRuntime.getProviderAuthStatus()``, or ``None`` if that
              call raised. On non-loopback sidecar binds the response is
              redacted to ``{"configured": bool}`` only (no ``source``/``label``).
            - ``authCheck`` (dict | None): result of
              ``ModelRuntime.checkAuth()``, or ``None`` if unregistered or
              that call raised. On non-loopback binds redacted to
              ``{"type": ...}`` only (no ``source``).

        Raises:
            httpx.HTTPStatusError: If the provider is not registered (HTTP
                404 — response body still includes the status fields) or on
                any other non-2xx response.
        """
        logger.debug("Fetching provider status: provider=%s", provider)
        resp = await self._client.get(f"/models/{quote(provider, safe='')}/status")
        resp.raise_for_status()
        status = resp.json()
        # Do not log authStatus/authCheck — may contain sensitive auth details.
        logger.debug(
            "Provider status fetched: provider=%s, registered=%s, modelCount=%s",
            provider,
            status.get("registered"),
            status.get("modelCount"),
        )
        return status

    async def create_session(
        self,
        *,
        provider: str,
        model: str,
        system_prompt: str,
        cwd: str = DEFAULT_CWD,
        agent_dir: str | None = None,
        custom_tools: list | None = None,
        tools: list[str] | None = None,
        api_key: str | None = None,
    ) -> str:
        """Create a new AI session. Returns session_id.

        The ``cwd`` parameter also controls project-level resource loading —
        the Pi SDK automatically discovers skills, prompts, extensions, and themes
        from ``{cwd}/.pi/`` and loads ``AGENTS.md`` from ``{cwd}/``.
        Nested CLI/ACPX agents (``cli-cursor`` ``--workspace``, spawn cwd, ACPX sessions)
        use this same folder. Omitting ``cwd`` defaults to ``tempfile.gettempdir()``,
        not the sidecar process working directory.

        The ``agent_dir`` parameter points to the global agent directory for
        user-level skills, extensions, auth, and model configs (e.g., ``~/.pi/agent/``).
        """
        if api_key is not None and (error := _validate_api_key(api_key)):
            raise ValueError(error)
        sidecar_provider, sidecar_model = _map_provider_model(provider, model, api_key)
        logger.debug(
            "Creating session: provider=%s→%s, model=%s→%s, cwd=%s, agent_dir=%s, custom_tools=%d, tools=%s",
            _redact_api_key(provider, api_key),
            _redact_api_key(sidecar_provider, api_key),
            _redact_api_key(model, api_key),
            _redact_api_key(sidecar_model, api_key),
            _redact_api_key(cwd, api_key),
            _redact_api_key(agent_dir, api_key) if agent_dir else None,
            len(custom_tools or []),
            tools if api_key is None else "[omitted for keyed session]",
        )
        body: dict[str, Any] = {
            "provider": sidecar_provider,
            "model": sidecar_model,
            "system_prompt": system_prompt,
            "cwd": cwd,
        }
        if agent_dir:
            body["agent_dir"] = agent_dir
        if custom_tools:
            body["custom_tools"] = custom_tools
        if tools is not None:
            body["tools"] = tools
        if api_key is not None:
            body["api_key"] = api_key
        logger.debug("Creating session request: api_key_supplied=%s", api_key is not None)
        try:
            resp = await self._client.post("/sessions", json=body)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            if api_key is None:
                raise
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            detail = str(exc)
            if isinstance(exc, httpx.HTTPStatusError):
                try:
                    payload = exc.response.json()
                    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                        detail = payload["error"]
                    else:
                        detail = exc.response.text or detail
                except ValueError:
                    detail = exc.response.text or detail
            error = _redact_api_key(detail, api_key)
            message = (
                f"Sidecar session creation failed (HTTP {status}): {error}"
                if status
                else f"Sidecar session creation failed: {error}"
            )
            logger.error("Session creation HTTP failure: status=%s, error=%s", status, message)
            raise RuntimeError(message) from None
        session_id = resp.json()["session_id"]
        logger.info(
            "Session created: session_id=%s, provider=%s, model=%s",
            session_id,
            _redact_api_key(sidecar_provider, api_key),
            _redact_api_key(sidecar_model, api_key),
        )
        return session_id

    async def prompt(self, session_id: str, message: str, timeout: float | None = None) -> AIResult:
        """Send a message to a session. Returns AIResult."""
        logger.debug("Sending prompt: session=%s, message_length=%d", session_id, len(message))
        request_timeout = timeout or self._client.timeout
        resp = await self._client.post(
            f"/sessions/{session_id}/prompt",
            json={"message": message},
            timeout=request_timeout,
        )
        if resp.status_code != 200:
            try:
                payload = resp.json()
                error = payload.get("error", resp.text) if isinstance(payload, dict) else resp.text
            except ValueError:
                error = resp.text or f"HTTP {resp.status_code}"
            logger.error("Prompt failed: session=%s, status=%d", session_id, resp.status_code)
            return AIResult(success=False, text=error, error=error)

        data = resp.json()
        usage_data = data.get("usage", {})
        usage = AITokenUsage(
            input_tokens=usage_data.get("input_tokens", 0),
            output_tokens=usage_data.get("output_tokens", 0),
            cache_read_tokens=usage_data.get("cache_read_tokens", 0),
            cache_write_tokens=usage_data.get("cache_write_tokens", 0),
            cost_usd=usage_data.get("cost_usd"),
            duration_ms=usage_data.get("duration_ms"),
        )

        # Surface error from sidecar even on HTTP 200
        error = data.get("error")
        if error:
            logger.error(
                "Prompt returned error from AI: session=%s, text_length=%d",
                session_id,
                len(data.get("text", "")),
            )
            return AIResult(success=False, text=data.get("text") or error, usage=usage, error=error)

        text = data.get("text", "")
        if not text:
            logger.warning("Prompt returned empty text: session=%s, usage=%s", session_id, usage_data)

        logger.debug(
            "Prompt completed: session=%s, text_length=%d, input_tokens=%d, output_tokens=%d, duration_ms=%s",
            session_id,
            len(text),
            usage.input_tokens,
            usage.output_tokens,
            usage.duration_ms,
        )
        return AIResult(
            success=True,
            text=text,
            usage=usage,
        )

    async def abort(self, session_id: str) -> None:
        """Abort an in-progress prompt."""
        logger.debug("Aborting session: %s", session_id)
        resp = await self._client.post(f"/sessions/{session_id}/abort")
        resp.raise_for_status()
        logger.info("Session aborted: %s", session_id)

    async def delete_session(self, session_id: str) -> None:
        """Delete a session."""
        logger.debug("Deleting session: %s", session_id)
        resp = await self._client.delete(f"/sessions/{session_id}")
        resp.raise_for_status()
        logger.debug("Session deleted: %s", session_id)

    async def __aenter__(self) -> "SidecarClient":
        if self._closed:
            raise RuntimeError("SidecarClient is already closed")
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the HTTP client."""
        logger.debug("Closing sidecar client: url=%s", self._base_url)
        await self._client.aclose()
        self._closed = True
        logger.debug("Sidecar client closed")


# Singleton client
_client: SidecarClient | None = None


def get_sidecar_client() -> SidecarClient:
    """Get the singleton sidecar client."""
    global _client
    if _client is None or _client._closed:
        _client = SidecarClient()
        logger.debug("Created new sidecar client: url=%s", _client._base_url)
    return _client


# --- Convenience functions for single-shot AI calls ---


async def call_ai(
    prompt: str,
    *,
    ai_provider: str = "",
    ai_model: str = "",
    cwd: str | None = None,
    agent_dir: str | None = None,
    system_prompt: str = "",
    ai_call_timeout: int | None = None,
    session_id: str | None = None,
    custom_tools: list | None = None,
    tools: list[str] | None = None,
    api_key: str | None = None,
) -> AIResult:
    """Call AI via the sidecar.

    Creates a new session (or reuses *session_id*), sends the prompt,
    and returns the result with session_id attached.

    The ``cwd`` parameter also controls project-level resource loading —
    the Pi SDK automatically discovers skills, prompts, extensions, and themes
    from ``{cwd}/.pi/`` and loads ``AGENTS.md`` from ``{cwd}/``.
    Nested CLI/ACPX agents use this same folder. Omitting ``cwd`` defaults to
    the system temp directory (``DEFAULT_CWD``), not the sidecar process cwd.

    Session lifecycle:
    - Caller is responsible for deleting sessions when done.
    - For single-shot calls, use ``call_ai_once(...)``
      or call ``client.delete_session()`` manually after.
    - For multi-turn (peer debate), pass ``session_id`` from the
      previous result to continue the conversation.
    """
    if api_key is not None and (error := _validate_api_key(api_key)):
        return AIResult(success=False, text=error, error=error)
    logger.debug(
        "call_ai: provider=%s, model=%s, session_id=%s, prompt_length=%d, agent_dir=%s, tools=%s, api_key_supplied=%s",
        _redact_api_key(ai_provider, api_key),
        _redact_api_key(ai_model, api_key),
        session_id or "new",
        len(prompt),
        _redact_api_key(agent_dir, api_key) if agent_dir else None,
        tools if api_key is None else "[omitted for keyed session]",
        api_key is not None,
    )
    if session_id and api_key is not None:
        error = "api_key cannot be supplied with an existing session_id"
        return AIResult(success=False, text=error, error=error, session_id=session_id)
    client = get_sidecar_client()
    created_session = False
    try:
        if not session_id:
            session_id = await client.create_session(
                provider=ai_provider,
                model=ai_model,
                system_prompt=system_prompt or "You are a helpful assistant.",
                cwd=cwd or DEFAULT_CWD,
                agent_dir=agent_dir,
                custom_tools=custom_tools,
                tools=tools,
                api_key=api_key,
            )
            created_session = True
        else:
            logger.debug("call_ai: reusing existing session=%s", session_id)
        # Convert minutes to seconds for httpx timeout
        timeout = ai_call_timeout * 60.0 if ai_call_timeout else None
        result = await client.prompt(session_id, prompt, timeout=timeout)
        if api_key is not None and not result.success:
            result.error = _redact_api_key(result.error, api_key) if result.error is not None else None
            result.text = _redact_api_key(result.text, api_key)
        # Attach session_id to result so callers can reuse or clean up
        result.session_id = session_id
        logger.debug(
            "call_ai complete: session=%s, success=%s, text_length=%d", session_id, result.success, len(result.text)
        )
        return result
    except Exception as e:
        error = _redact_api_key(str(e), api_key) if api_key is not None else str(e)
        if api_key is not None:
            logger.error("Sidecar call failed: error_type=%s, error=%s", type(e).__name__, error)
        else:
            logger.error("Sidecar call failed: %s", e, exc_info=True)
        # Clean up session if WE created it and the prompt failed
        cleanup_succeeded = False
        if created_session and session_id:
            try:
                await client.delete_session(session_id)
                cleanup_succeeded = True
            except Exception:
                logger.warning("Failed to cleanup leaked session %s", session_id, exc_info=api_key is None)
        return AIResult(
            success=False,
            text=error,
            error=error,
            session_id=None if cleanup_succeeded else session_id,
        )


async def call_ai_once(
    prompt: str,
    *,
    ai_provider: str = "",
    ai_model: str = "",
    cwd: str | None = None,
    agent_dir: str | None = None,
    system_prompt: str = "",
    ai_call_timeout: int | None = None,
    custom_tools: list | None = None,
    tools: list[str] | None = None,
    api_key: str | None = None,
) -> AIResult:
    """Single-shot AI call with automatic session cleanup.

    Creates a session, sends the prompt, and deletes the session.
    Cleanup is best-effort — if deletion fails, result.session_id is
    preserved so the caller can retry cleanup.
    Use ``call_ai`` directly for multi-turn conversations.
    """
    if api_key is not None and (error := _validate_api_key(api_key)):
        return AIResult(success=False, text=error, error=error)
    logger.debug(
        "call_ai_once: provider=%s, model=%s, prompt_length=%d, agent_dir=%s, tools=%s",
        _redact_api_key(ai_provider, api_key),
        _redact_api_key(ai_model, api_key),
        len(prompt),
        _redact_api_key(agent_dir, api_key) if agent_dir else None,
        tools if api_key is None else "[omitted for keyed session]",
    )
    result = await call_ai(
        prompt,
        ai_provider=ai_provider,
        ai_model=ai_model,
        cwd=cwd,
        agent_dir=agent_dir,
        system_prompt=system_prompt,
        ai_call_timeout=ai_call_timeout,
        custom_tools=custom_tools,
        tools=tools,
        api_key=api_key,
    )
    # Always clean up — this is a single-shot call
    if result.session_id:
        try:
            await get_sidecar_client().delete_session(result.session_id)
            result.session_id = None  # Clear so caller doesn't try to reuse
        except Exception:
            logger.warning(
                "Failed to cleanup session %s after call_ai_once", result.session_id, exc_info=api_key is None
            )
            # Preserve session_id so caller can retry cleanup
    logger.debug("call_ai_once complete: success=%s, text_length=%d", result.success, len(result.text))
    return result


async def list_models(provider: str = "") -> list[dict]:
    """List available models, optionally filtered by provider."""
    logger.debug("list_models: provider_filter=%s", provider or "none")
    client = get_sidecar_client()
    models = await client.get_models()
    if provider:
        sidecar_provider = _PROVIDER_MAP.get(provider, provider)
        models = [m for m in models if m.get("provider") == sidecar_provider]
    logger.debug("list_models: returned %d models", len(models))
    return models


async def check_sidecar_available() -> tuple[bool, str]:
    """Check if the sidecar service is available and ready."""
    logger.debug("Checking sidecar availability")
    client: SidecarClient | None = None
    try:
        client = get_sidecar_client()
        data = await client.health()
        if data.get("status") == "ok":
            logger.info("Sidecar is ready: url=%s", client._base_url)
            return True, "Sidecar is ready"
        if data.get("status") == "starting":
            logger.info(
                "Sidecar starting: url=%s, message=%s",
                client._base_url,
                data.get("message", "model discovery in progress"),
            )
            return False, f"Sidecar starting: {data.get('message', 'model discovery in progress')}"
        logger.warning("Sidecar unhealthy: url=%s, data=%s", client._base_url, data)
        return False, f"Sidecar unhealthy: {data}"
    except httpx.HTTPStatusError as e:
        url = client._base_url if client is not None else _default_sidecar_url()
        if e.response.status_code == 503:
            try:
                data = e.response.json()
                logger.info(
                    "Sidecar starting: url=%s, message=%s",
                    url,
                    data.get("message", "model discovery in progress"),
                )
                return False, f"Sidecar starting: {data.get('message', 'model discovery in progress')}"
            except ValueError:
                logger.debug(
                    "Sidecar 503 response was not JSON: url=%s, body=%r",
                    url,
                    e.response.text,
                    exc_info=True,
                )
        logger.warning("Sidecar unhealthy: url=%s, status=%d", url, e.response.status_code)
        return False, f"Sidecar unhealthy (HTTP {e.response.status_code})"
    except Exception as e:
        url = client._base_url if client is not None else _default_sidecar_url()
        logger.error("Sidecar unavailable: url=%s, error=%s", url, e, exc_info=True)
        return False, f"Sidecar unavailable: {e}"


async def run_parallel_with_limit(
    tasks: list,
    max_concurrency: int = 5,
) -> list:
    """Run async tasks in parallel with concurrency limit."""
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be >= 1")
    logger.debug("Running %d tasks with max_concurrency=%d", len(tasks), max_concurrency)

    semaphore = asyncio.Semaphore(max_concurrency)

    async def limited(coro: Any) -> Any:
        async with semaphore:
            return await coro

    results = await asyncio.gather(*(limited(t) for t in tasks), return_exceptions=True)
    failures = sum(1 for r in results if isinstance(r, BaseException))
    logger.debug("Parallel tasks complete: total=%d, failures=%d", len(results), failures)
    return results


class _PiSidecarClientModule(ModuleType):
    """Module subclass so ``SIDECAR_URL`` reads/writes ``os.environ`` without shadowing."""

    def __getattr__(self, name: str) -> object:
        if name == "SIDECAR_URL":
            return _default_sidecar_url()
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    def __setattr__(self, name: str, value: object) -> None:
        if name == "SIDECAR_URL":
            if value is None:
                os.environ.pop("SIDECAR_URL", None)
            else:
                os.environ["SIDECAR_URL"] = _normalize_sidecar_url(str(value))
            return
        super().__setattr__(name, value)

    def __dir__(self) -> list[str]:
        return sorted(set(super().__dir__()) | set(__all__) | {"SIDECAR_URL"})


sys.modules[__name__].__class__ = _PiSidecarClientModule
