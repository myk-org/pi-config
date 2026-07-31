"""Tests for pi_sidecar_client — all HTTP calls are mocked."""

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

import pi_sidecar_client
from pi_sidecar_client import (
    AIResult,
    AITokenUsage,
    SidecarClient,
    _map_provider_model,
    call_ai,
    call_ai_once,
    check_sidecar_available,
    get_sidecar_client,
    list_models,
    run_parallel_with_limit,
    set_usage_recorder,
)

# ---------------------------------------------------------------------------
# 1. Provider mapping
# ---------------------------------------------------------------------------


class TestProviderMapping:
    def test_map_provider_model_cursor(self) -> None:
        provider, model = _map_provider_model("cursor", "gpt-4o")
        assert provider == "acpx-cursor"
        assert model == "cursor:gpt-4o"

    def test_map_provider_model_cursor_already_prefixed(self) -> None:
        provider, model = _map_provider_model("cursor", "cursor:gpt-4o")
        assert provider == "acpx-cursor"
        assert model == "cursor:gpt-4o"

    def test_map_provider_model_claude(self) -> None:
        provider, model = _map_provider_model("claude", "claude-sonnet-4-20250514")
        assert provider == "google-vertex-claude"
        assert model == "claude-sonnet-4-20250514"

    def test_map_provider_model_gemini(self) -> None:
        provider, model = _map_provider_model("gemini", "gemini-2.5-pro")
        assert provider == "google"
        assert model == "gemini-2.5-pro"

    def test_map_provider_model_unknown(self) -> None:
        provider, model = _map_provider_model("openai", "gpt-4")
        assert provider == "openai"
        assert model == "gpt-4"


# ---------------------------------------------------------------------------
# 2. Dataclass defaults
# ---------------------------------------------------------------------------


class TestDataclasses:
    def test_ai_result_defaults(self) -> None:
        result = AIResult(success=True, text="hello")
        assert result.success is True
        assert result.text == "hello"
        assert result.usage is None
        assert result.session_id is None

    def test_ai_token_usage_defaults(self) -> None:
        usage = AITokenUsage()
        assert usage.input_tokens == 0
        assert usage.output_tokens == 0
        assert usage.cache_read_tokens == 0
        assert usage.cache_write_tokens == 0
        assert usage.cost_usd is None
        assert usage.duration_ms is None
        assert usage.provider == ""
        assert usage.model == ""
        assert usage.session_id == ""


# ---------------------------------------------------------------------------
# 3. SidecarClient methods (mock HTTP)
# ---------------------------------------------------------------------------


def _mock_response(status_code: int = 200, json_data: dict | list | None = None) -> httpx.Response:
    """Build a fake httpx.Response."""
    return httpx.Response(
        status_code=status_code,
        json=json_data if json_data is not None else {},
        request=httpx.Request("GET", "http://test"),
    )


class TestSidecarClient:
    @pytest.fixture()
    def client(self) -> SidecarClient:
        return SidecarClient(base_url="http://localhost:9100")

    # -- health --
    async def test_client_health(self, client: SidecarClient) -> None:
        mock_resp = _mock_response(200, {"status": "ok"})
        client._client.get = AsyncMock(return_value=mock_resp)

        result = await client.health()
        assert result == {"status": "ok"}
        client._client.get.assert_awaited_once_with("/health")

    # -- get_models --
    async def test_client_get_models(self, client: SidecarClient) -> None:
        models = [{"id": "m1", "provider": "google"}, {"id": "m2", "provider": "acpx-cursor"}]
        mock_resp = _mock_response(200, {"models": models})
        client._client.get = AsyncMock(return_value=mock_resp)

        result = await client.get_models()
        assert result == models
        client._client.get.assert_awaited_once_with("/models")

    # -- get_model_provider_status --
    async def test_client_get_model_provider_status(self, client: SidecarClient) -> None:
        # Matches the real sidecar's camelCase ProviderStatus shape (src/sessions.ts).
        status = {
            "provider": "google",
            "registered": True,
            "modelCount": 12,
            "authStatus": {"configured": True},
            "authCheck": {"ok": True},
        }
        mock_resp = _mock_response(200, status)
        client._client.get = AsyncMock(return_value=mock_resp)

        result = await client.get_model_provider_status("google")
        assert result == status
        client._client.get.assert_awaited_once_with("/models/google/status")

    # -- get_model_provider_status URL-encodes the provider id --
    async def test_client_get_model_provider_status_url_encodes_provider(self, client: SidecarClient) -> None:
        status = {
            "provider": "acpx-cursor",
            "registered": True,
            "modelCount": 3,
            "authStatus": {"configured": True},
            "authCheck": None,
        }
        mock_resp = _mock_response(200, status)
        client._client.get = AsyncMock(return_value=mock_resp)

        result = await client.get_model_provider_status("acpx-cursor")
        assert result == status
        client._client.get.assert_awaited_once_with("/models/acpx-cursor/status")

    async def test_client_get_model_provider_status_encodes_special_characters(self, client: SidecarClient) -> None:
        """Provider ids with reserved URL characters must not alter the request path."""
        status = {
            "provider": "weird/provider",
            "registered": True,
            "modelCount": 0,
            "authStatus": None,
            "authCheck": None,
        }
        mock_resp = _mock_response(200, status)
        client._client.get = AsyncMock(return_value=mock_resp)

        await client.get_model_provider_status("weird/provider")
        client._client.get.assert_awaited_once_with("/models/weird%2Fprovider/status")

    async def test_client_get_model_provider_status_raises_on_unregistered_404(self, client: SidecarClient) -> None:
        """Unregistered providers return HTTP 404 from the sidecar."""
        body = {
            "error": "Provider 'missing-provider' is not registered",
            "provider": "missing-provider",
            "registered": False,
            "modelCount": 0,
            "authStatus": None,
            "authCheck": None,
        }
        mock_resp = _mock_response(404, body)
        client._client.get = AsyncMock(return_value=mock_resp)

        with pytest.raises(httpx.HTTPStatusError) as exc_info:
            await client.get_model_provider_status("missing-provider")
        assert exc_info.value.response.status_code == 404

    # -- create_session --
    async def test_client_create_session(self, client: SidecarClient, tmp_path: Path) -> None:
        mock_resp = _mock_response(200, {"session_id": "sess-123"})
        client._client.post = AsyncMock(return_value=mock_resp)

        sid = await client.create_session(
            provider="cursor",
            model="gpt-4o",
            system_prompt="Be helpful",
            cwd=str(tmp_path),
        )
        assert sid == "sess-123"

        # Verify provider mapping was applied in the request body
        call_kwargs = client._client.post.call_args
        body = call_kwargs.kwargs["json"]
        assert body["provider"] == "acpx-cursor"
        assert body["model"] == "cursor:gpt-4o"

    # -- create_session with tools --
    async def test_client_create_session_with_tools(self, client: SidecarClient, tmp_path: Path) -> None:
        mock_resp = _mock_response(200, {"session_id": "sess-tools"})
        client._client.post = AsyncMock(return_value=mock_resp)

        sid = await client.create_session(
            provider="gemini",
            model="gemini-2.5-pro",
            system_prompt="Be helpful",
            cwd=str(tmp_path),
            tools=["read", "bash"],
        )
        assert sid == "sess-tools"

        call_kwargs = client._client.post.call_args
        body = call_kwargs.kwargs["json"]
        assert body["tools"] == ["read", "bash"]

    # -- create_session without tools omits key --
    async def test_client_create_session_without_tools(self, client: SidecarClient, tmp_path: Path) -> None:
        mock_resp = _mock_response(200, {"session_id": "sess-no-tools"})
        client._client.post = AsyncMock(return_value=mock_resp)

        sid = await client.create_session(
            provider="gemini",
            model="gemini-2.5-pro",
            system_prompt="Be helpful",
            cwd=str(tmp_path),
        )
        assert sid == "sess-no-tools"

        call_kwargs = client._client.post.call_args
        body = call_kwargs.kwargs["json"]
        assert "tools" not in body

    # -- prompt success --
    async def test_client_prompt_success(self, client: SidecarClient) -> None:
        mock_resp = _mock_response(
            200,
            {
                "text": "Hello!",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "cache_read_tokens": 5,
                    "cache_write_tokens": 3,
                    "cost_usd": 0.001,
                    "duration_ms": 150,
                },
            },
        )
        client._client.post = AsyncMock(return_value=mock_resp)

        result = await client.prompt("sess-1", "hi")
        assert result.success is True
        assert result.text == "Hello!"
        assert result.usage is not None
        assert result.usage.input_tokens == 10
        assert result.usage.output_tokens == 20
        assert result.usage.cache_read_tokens == 5
        assert result.usage.cache_write_tokens == 3
        assert result.usage.cost_usd == 0.001
        assert result.usage.duration_ms == 150

    # -- prompt failure --
    async def test_client_prompt_failure(self, client: SidecarClient) -> None:
        mock_resp = _mock_response(500, {"error": "internal error"})
        client._client.post = AsyncMock(return_value=mock_resp)

        result = await client.prompt("sess-1", "hi")
        assert result.success is False
        assert result.text == "internal error"
        assert result.error == "internal error"

    # -- prompt with error field on 200 --
    async def test_client_prompt_with_error_field(self, client: SidecarClient) -> None:
        """Prompt returns success=False when sidecar response contains error field."""
        mock_resp = _mock_response(
            200,
            {
                "text": "partial output",
                "usage": {"input_tokens": 10, "output_tokens": 5},
                "error": "AI model returned an error during processing",
            },
        )
        client._client.post = AsyncMock(return_value=mock_resp)

        result = await client.prompt("sess-1", "hi")
        assert result.success is False
        assert result.text == "partial output"
        assert result.error == "AI model returned an error during processing"
        assert result.usage is not None
        assert result.usage.input_tokens == 10

    # -- prompt empty text --
    async def test_client_prompt_empty_text(self, client: SidecarClient) -> None:
        """Prompt returns success=True with empty text (valid for tool-only responses)."""
        mock_resp = _mock_response(
            200,
            {
                "text": "",
                "usage": {"input_tokens": 10, "output_tokens": 0},
            },
        )
        client._client.post = AsyncMock(return_value=mock_resp)

        result = await client.prompt("sess-1", "run the tool")
        assert result.success is True
        assert result.text == ""
        assert result.usage is not None

    # -- delete_session --
    async def test_client_delete_session(self, client: SidecarClient) -> None:
        mock_resp = _mock_response(200)
        client._client.delete = AsyncMock(return_value=mock_resp)

        await client.delete_session("sess-1")
        client._client.delete.assert_awaited_once_with("/sessions/sess-1")

    # -- abort --
    async def test_client_abort(self, client: SidecarClient) -> None:
        mock_resp = _mock_response(200)
        client._client.post = AsyncMock(return_value=mock_resp)

        await client.abort("sess-1")
        client._client.post.assert_awaited_once_with("/sessions/sess-1/abort")


# ---------------------------------------------------------------------------
# 4. Convenience functions (mock client)
# ---------------------------------------------------------------------------


class TestConvenienceFunctions:
    @pytest.fixture()
    def mock_client(self) -> Iterator[AsyncMock]:
        """Patch get_sidecar_client to return a fully-mocked SidecarClient."""
        client = AsyncMock(spec=SidecarClient)
        with patch("pi_sidecar_client.get_sidecar_client", return_value=client):
            yield client

    # -- call_ai creates session --
    async def test_call_ai_creates_session(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-new"
        mock_client.prompt.return_value = AIResult(success=True, text="ok")

        result = await call_ai("hello", ai_provider="gemini", ai_model="gemini-2.5-pro")

        mock_client.create_session.assert_awaited_once()
        mock_client.prompt.assert_awaited_once_with("sess-new", "hello", timeout=None)
        assert result.success is True
        assert result.session_id == "sess-new"

    # -- call_ai passes tools --
    async def test_call_ai_passes_tools(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-tools"
        mock_client.prompt.return_value = AIResult(success=True, text="ok")

        result = await call_ai(
            "hello",
            ai_provider="gemini",
            ai_model="gemini-2.5-pro",
            tools=["read", "grep"],
        )

        call_kwargs = mock_client.create_session.call_args
        assert call_kwargs.kwargs["tools"] == ["read", "grep"]
        assert result.success is True

    # -- call_ai without tools passes None --
    async def test_call_ai_without_tools(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-no-tools"
        mock_client.prompt.return_value = AIResult(success=True, text="ok")

        await call_ai("hello", ai_provider="gemini", ai_model="gemini-2.5-pro")

        call_kwargs = mock_client.create_session.call_args
        assert call_kwargs.kwargs["tools"] is None

    # -- call_ai reuses session --
    async def test_call_ai_reuses_session(self, mock_client: AsyncMock) -> None:
        mock_client.prompt.return_value = AIResult(success=True, text="ok")

        result = await call_ai("hello", session_id="existing-sess")

        mock_client.create_session.assert_not_awaited()
        mock_client.prompt.assert_awaited_once_with("existing-sess", "hello", timeout=None)
        assert result.session_id == "existing-sess"

    # -- call_ai cleans up on error --
    async def test_call_ai_cleans_up_on_error(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-fail"
        mock_client.prompt.side_effect = RuntimeError("boom")

        result = await call_ai("hello", ai_provider="claude", ai_model="sonnet")

        assert result.success is False
        assert result.text == "boom"
        assert result.error == "boom"
        mock_client.delete_session.assert_awaited_once_with("sess-fail")

    # -- call_ai_once deletes session --
    async def test_call_ai_once_deletes_session(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-once"
        mock_client.prompt.return_value = AIResult(success=True, text="done")

        result = await call_ai_once("hello", ai_provider="cursor", ai_model="gpt-4o")

        assert result.success is True
        assert result.session_id is None  # cleared after cleanup
        mock_client.delete_session.assert_awaited_once_with("sess-once")

    # -- call_ai_once passes tools --
    async def test_call_ai_once_passes_tools(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-once-tools"
        mock_client.prompt.return_value = AIResult(success=True, text="done")

        result = await call_ai_once(
            "hello",
            ai_provider="gemini",
            ai_model="gemini-2.5-pro",
            tools=["bash"],
        )

        assert result.success is True
        call_kwargs = mock_client.create_session.call_args
        assert call_kwargs.kwargs["tools"] == ["bash"]

    # -- call_ai surfaces sidecar error --
    async def test_call_ai_surfaces_sidecar_error(self, mock_client: AsyncMock) -> None:
        """call_ai surfaces error field from sidecar prompt response."""
        mock_client.create_session.return_value = "sess-err"
        mock_client.prompt.return_value = AIResult(success=False, text="partial output", error="AI error: rate limited")

        result = await call_ai("hello", ai_provider="gemini", ai_model="gemini-2.5-pro")

        assert result.success is False
        assert result.text == "partial output"
        assert result.error == "AI error: rate limited"
        assert result.session_id == "sess-err"

    # -- list_models no filter --
    async def test_list_models_no_filter(self, mock_client: AsyncMock) -> None:
        models = [
            {"id": "m1", "provider": "google"},
            {"id": "m2", "provider": "acpx-cursor"},
        ]
        mock_client.get_models.return_value = models

        result = await list_models()
        assert result == models

    # -- list_models with filter --
    async def test_list_models_with_filter(self, mock_client: AsyncMock) -> None:
        models = [
            {"id": "m1", "provider": "google"},
            {"id": "m2", "provider": "acpx-cursor"},
            {"id": "m3", "provider": "google"},
        ]
        mock_client.get_models.return_value = models

        # "gemini" maps to "google"
        result = await list_models(provider="gemini")
        assert len(result) == 2
        assert all(m["provider"] == "google" for m in result)

        # "cursor" maps to "acpx-cursor"
        result = await list_models(provider="cursor")
        assert len(result) == 1
        assert result[0]["provider"] == "acpx-cursor"


# ---------------------------------------------------------------------------
# 5. Singleton
# ---------------------------------------------------------------------------


class TestSingleton:
    def test_get_sidecar_client_singleton(self) -> None:
        c1 = get_sidecar_client()
        c2 = get_sidecar_client()
        assert c1 is c2

    def test_sidecar_url_env_backed_at_access_and_construction(self) -> None:
        """SIDECAR_URL, SidecarClient(), and get_sidecar_client() read env."""
        prev = os.environ.get("SIDECAR_URL")
        prev_client = pi_sidecar_client._client
        try:
            os.environ["SIDECAR_URL"] = "http://127.0.0.1:19100"
            assert pi_sidecar_client.SIDECAR_URL == "http://127.0.0.1:19100"
            assert pi_sidecar_client.SIDECAR_URL == "http://127.0.0.1:19100"
            assert SidecarClient()._base_url == "http://127.0.0.1:19100"

            pi_sidecar_client._client = None
            singleton = get_sidecar_client()
            assert singleton._base_url == "http://127.0.0.1:19100"

            os.environ["SIDECAR_URL"] = "http://127.0.0.1:19200"
            assert pi_sidecar_client.SIDECAR_URL == "http://127.0.0.1:19200"
            assert SidecarClient()._base_url == "http://127.0.0.1:19200"
        finally:
            if prev is None:
                os.environ.pop("SIDECAR_URL", None)
            else:
                os.environ["SIDECAR_URL"] = prev
            pi_sidecar_client._client = prev_client

    def test_sidecar_url_assignment_sets_env_and_client_base_url(self) -> None:
        """Assigning pi_sidecar_client.SIDECAR_URL updates os.environ and new clients."""
        prev = os.environ.get("SIDECAR_URL")
        try:
            os.environ.pop("SIDECAR_URL", None)
            pi_sidecar_client.SIDECAR_URL = "http://127.0.0.1:19300/"
            assert os.environ["SIDECAR_URL"] == "http://127.0.0.1:19300"
            assert pi_sidecar_client.SIDECAR_URL == "http://127.0.0.1:19300"
            assert SidecarClient()._base_url == "http://127.0.0.1:19300"
            assert "SIDECAR_URL" in dir(pi_sidecar_client)
        finally:
            if prev is None:
                os.environ.pop("SIDECAR_URL", None)
            else:
                os.environ["SIDECAR_URL"] = prev


# ---------------------------------------------------------------------------
# 6. Utility functions
# ---------------------------------------------------------------------------


class TestUtilityFunctions:
    async def test_check_sidecar_available_ok(self) -> None:
        """Health returns ok → (True, 'Sidecar is ready')."""
        with patch.object(SidecarClient, "health", new_callable=AsyncMock) as mock_health:
            mock_health.return_value = {"status": "ok", "sessions": 0}
            available, msg = await check_sidecar_available()
            assert available is True
            assert msg == "Sidecar is ready"

    async def test_check_sidecar_available_not_ready(self) -> None:
        """Health raises HTTPStatusError 503 → (False, ...)."""
        response = httpx.Response(
            status_code=503,
            json={"status": "starting", "message": "Model discovery in progress"},
            request=httpx.Request("GET", "http://test/health"),
        )
        with patch.object(SidecarClient, "health", new_callable=AsyncMock) as mock_health:
            mock_health.side_effect = httpx.HTTPStatusError(
                "Service Unavailable", request=response.request, response=response
            )
            available, msg = await check_sidecar_available()
            assert available is False
            assert "starting" in msg.lower()

    async def test_check_sidecar_available_503_non_json_body(self) -> None:
        """503 with non-JSON body falls through to unhealthy message."""
        response = httpx.Response(
            status_code=503,
            content=b"Service Temporarily Unavailable",
            request=httpx.Request("GET", "http://test/health"),
        )
        with patch.object(SidecarClient, "health", new_callable=AsyncMock) as mock_health:
            mock_health.side_effect = httpx.HTTPStatusError(
                "Service Unavailable", request=response.request, response=response
            )
            available, msg = await check_sidecar_available()
            assert available is False
            assert msg == "Sidecar unhealthy (HTTP 503)"

    async def test_check_sidecar_available_unreachable(self) -> None:
        """Health raises ConnectError → (False, 'Sidecar unavailable: ...')."""
        with patch.object(SidecarClient, "health", new_callable=AsyncMock) as mock_health:
            mock_health.side_effect = httpx.ConnectError("refused")
            available, msg = await check_sidecar_available()
            assert available is False
            assert "unavailable" in msg.lower()

    async def test_run_parallel_with_limit(self) -> None:
        """Runs tasks respecting concurrency limit."""
        results = []

        async def task(n: int) -> int:
            results.append(n)
            return n * 2

        output = await run_parallel_with_limit([task(1), task(2), task(3)], max_concurrency=2)
        assert sorted(output) == [2, 4, 6]
        assert sorted(results) == [1, 2, 3]

    async def test_run_parallel_with_limit_returns_exceptions(self) -> None:
        """Exceptions are returned, not raised."""

        async def ok() -> str:
            return "ok"

        async def fail() -> None:
            raise ValueError("boom")

        output = await run_parallel_with_limit([ok(), fail()])
        assert output[0] == "ok"
        assert isinstance(output[1], ValueError)


# ---------------------------------------------------------------------------
# 7. Record usage
# ---------------------------------------------------------------------------


class TestRecordUsage:
    async def test_record_usage_no_callback(self) -> None:
        """record_usage is a no-op when no callback registered."""
        pi_sidecar_client._usage_recorder = None
        result = AIResult(success=True, text="hello")
        # Should not raise
        await result.record_usage(request_id="j1", call_type="test")

    async def test_record_usage_with_callback(self) -> None:
        """record_usage calls the registered callback."""
        mock_recorder = AsyncMock()
        pi_sidecar_client._usage_recorder = mock_recorder
        try:
            result = AIResult(success=True, text="hello", usage=AITokenUsage(input_tokens=100))
            await result.record_usage(
                request_id="j1",
                call_type="analysis",
                prompt_chars=500,
                ai_provider="gemini",
                ai_model="gemini-2.5-flash",
            )
            mock_recorder.assert_awaited_once_with(
                request_id="j1",
                result=result,
                call_type="analysis",
                prompt_chars=500,
                ai_provider="gemini",
                ai_model="gemini-2.5-flash",
            )
        finally:
            pi_sidecar_client._usage_recorder = None

    async def test_record_usage_callback_error_suppressed(self) -> None:
        """record_usage swallows callback exceptions."""
        mock_recorder = AsyncMock(side_effect=RuntimeError("db down"))
        pi_sidecar_client._usage_recorder = mock_recorder
        try:
            result = AIResult(success=True, text="hello")
            # Should not raise
            await result.record_usage(request_id="j1", call_type="test")
        finally:
            pi_sidecar_client._usage_recorder = None

    def test_set_usage_recorder(self) -> None:
        """set_usage_recorder sets the module-level callback."""
        original = pi_sidecar_client._usage_recorder
        try:

            async def my_recorder(**kwargs: Any) -> None:
                pass

            set_usage_recorder(my_recorder)
            assert pi_sidecar_client._usage_recorder is my_recorder
        finally:
            pi_sidecar_client._usage_recorder = original


@pytest.mark.asyncio
async def test_async_context_manager() -> None:
    async with SidecarClient(base_url="http://127.0.0.1:99999") as client:
        assert isinstance(client, SidecarClient)
    assert client._closed is True


@pytest.mark.asyncio
async def test_async_context_manager_reuse_after_close() -> None:
    client = SidecarClient(base_url="http://127.0.0.1:99999")
    await client.close()
    with pytest.raises(RuntimeError, match="already closed"):
        async with client:
            pass
