"""Tests for pi_sidecar_client with mocked responses and a local HTTP request test."""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from time import perf_counter
from typing import Any
from unittest.mock import AsyncMock, patch
from urllib.parse import quote

import httpx
import pytest

import pi_sidecar_client
from pi_sidecar_client import (
    AIResult,
    AITokenUsage,
    SidecarClient,
    _map_provider_model,
    _redact_api_key,
    call_ai,
    call_ai_once,
    check_sidecar_available,
    get_sidecar_client,
    list_models,
    run_parallel_with_limit,
    set_usage_recorder,
)


@contextmanager
def session_server() -> Iterator[tuple[str, list[dict]]]:
    received: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.append({
                "path": self.path,
                "body": json.loads(self.rfile.read(int(self.headers["Content-Length"]))),
            })
            body = b'{"session_id":"sess-key"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", received
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


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

    @pytest.mark.parametrize("api_key", [None, "synthetic-session-key"])
    async def test_create_session_serializes_optional_api_key(self, api_key: str | None) -> None:
        with session_server() as (url, received):
            async with SidecarClient(base_url=url) as client:
                assert (
                    await client.create_session(provider="gemini", model="flash", system_prompt="hi", api_key=api_key)
                    == "sess-key"
                )

        assert len(received) == 1
        assert received[0]["path"] == "/sessions"
        body = received[0]["body"]
        assert body["provider"] == "google"
        assert body["model"] == "flash"
        assert body.get("api_key") == api_key
        assert ("api_key" in body) is (api_key is not None)

    async def test_create_session_http_failure_hides_key(self, client: SidecarClient) -> None:
        key = "synthetic-secret-key"
        client._client.post = AsyncMock(return_value=_mock_response(400, {"error": key}))

        with patch.object(pi_sidecar_client.logger, "error") as log_error:
            with pytest.raises(RuntimeError) as exc_info:
                await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)

        assert key not in str(exc_info.value)
        assert key not in str(log_error.call_args_list)

    @pytest.mark.parametrize("encoding", ["raw", "json", "url", "unicode"])
    async def test_create_session_preserves_sanitized_http_error(self, client: SidecarClient, encoding: str) -> None:
        key = 'séc-ret"'
        variants = {
            "raw": key,
            "json": json.dumps(key)[1:-1],
            "url": quote(key, safe="").lower(),
            "unicode": json.dumps(key, ensure_ascii=True)[1:-1].replace("00e9", "00E9"),
        }
        secret = variants[encoding]
        client._client.post = AsyncMock(return_value=_mock_response(422, {"error": f"Unsupported model: {secret}"}))

        with patch.object(pi_sidecar_client.logger, "error") as log_error:
            with pytest.raises(RuntimeError) as exc_info:
                await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)

        assert str(exc_info.value) == "Sidecar session creation failed (HTTP 422): Unsupported model: [redacted]"
        assert secret not in str(exc_info.value)
        assert secret not in str(log_error.call_args_list)

    async def test_create_session_redacts_mixed_json_error_and_log(self, client: SidecarClient) -> None:
        key = 'a"é'
        mixed = 'a\\"é'
        client._client.post = AsyncMock(return_value=_mock_response(422, {"error": f"Unsupported model: {mixed}"}))

        with patch.object(pi_sidecar_client.logger, "error") as log_error:
            with pytest.raises(RuntimeError) as exc_info:
                await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)

        assert str(exc_info.value) == "Sidecar session creation failed (HTTP 422): Unsupported model: [redacted]"
        assert mixed not in str(log_error.call_args_list)
        assert key not in str(log_error.call_args_list)

    async def test_create_session_rejects_unpaired_surrogate_before_http(self, client: SidecarClient) -> None:
        client._client.post = AsyncMock()
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            with pytest.raises(ValueError, match="Invalid api_key: unpaired Unicode surrogate"):
                key = "a\ud800b"  # pragma: allowlist secret — malformed test sentinel
                await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)
        client._client.post.assert_not_awaited()
        log_debug.assert_called_once_with("API key validation: outcome=%s", "malformed")
        assert key not in str(log_debug.call_args_list)

    @pytest.mark.parametrize("key", ["", "   ", "\u00a0\ufeff\u2003"])
    async def test_create_session_rejects_blank_key_before_http(self, client: SidecarClient, key: str) -> None:
        client._client.post = AsyncMock()
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            with pytest.raises(ValueError, match="Invalid api_key: blank"):
                await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)
        client._client.post.assert_not_awaited()
        log_debug.assert_called_once_with("API key validation: outcome=%s", "blank")
        if key:
            assert key not in str(log_debug.call_args_list)

    async def test_create_session_accepts_js_nonwhitespace_c1_control(self, client: SidecarClient) -> None:
        key = "\u0085"  # Python strip removes this; JavaScript trim does not.
        client._client.post = AsyncMock(return_value=_mock_response(200, {"session_id": "sess-key"}))
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            assert await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)
        assert client._client.post.call_args.kwargs["json"]["api_key"] == key
        assert ("API key validation: outcome=%s", "accepted") in [call.args for call in log_debug.call_args_list]
        assert key not in str(log_debug.call_args_list)

    async def test_create_session_accepts_maximum_key(self, client: SidecarClient) -> None:
        key = "x" * 1024
        client._client.post = AsyncMock(return_value=_mock_response(200, {"session_id": "sess-key"}))
        assert (
            await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key) == "sess-key"
        )
        assert client._client.post.call_args.kwargs["json"]["api_key"] == key

    async def test_create_session_accepts_512_astral_characters(self, client: SidecarClient) -> None:
        key = "😀" * 512
        client._client.post = AsyncMock(return_value=_mock_response(200, {"session_id": "sess-key"}))
        assert (
            await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key) == "sess-key"
        )
        assert client._client.post.call_args.kwargs["json"]["api_key"] == key

    @pytest.mark.parametrize("length", [1025, 100_000])
    async def test_create_session_rejects_oversized_key(self, client: SidecarClient, length: int) -> None:
        client._client.post = AsyncMock()
        with pytest.raises(ValueError, match="Invalid api_key: exceeds 1024 characters"):
            await client.create_session(provider="google", model="flash", system_prompt="hi", api_key="x" * length)
        client._client.post.assert_not_awaited()

    async def test_create_session_omits_huge_http_error(self, client: SidecarClient) -> None:
        key = "private-key"
        client._client.post = AsyncMock(return_value=_mock_response(422, {"error": "a" * 100_000 + key}))
        with pytest.raises(RuntimeError) as exc_info:
            await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)
        assert str(exc_info.value) == "Sidecar session creation failed (HTTP 422): [error detail omitted]"

    async def test_create_session_preserves_transport_error(self, client: SidecarClient) -> None:
        key = "synthetic-secret-key"
        client._client.post = AsyncMock(side_effect=httpx.ConnectError(f"connection refused for {key}"))
        with pytest.raises(RuntimeError, match="connection refused for \\[redacted\\]"):
            await client.create_session(provider="google", model="flash", system_prompt="hi", api_key=key)

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

    async def test_client_prompt_error_only_uses_error_as_text(self, client: SidecarClient) -> None:
        client._client.post = AsyncMock(return_value=_mock_response(200, {"error": "provider unavailable", "text": ""}))
        result = await client.prompt("sess-1", "hi")
        assert result.success is False
        assert result.text == result.error == "provider unavailable"

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

    @pytest.mark.parametrize("api_key", [None, "synthetic-session-key"])
    async def test_call_ai_forwards_key_only_at_creation(self, mock_client: AsyncMock, api_key: str | None) -> None:
        mock_client.create_session.return_value = "sess-key"
        mock_client.prompt.return_value = AIResult(success=True, text="ok")

        result = await call_ai("hello", ai_provider="gemini", api_key=api_key)

        assert result.session_id == "sess-key"
        assert mock_client.create_session.call_args.kwargs["api_key"] == api_key
        assert mock_client.prompt.call_args.kwargs == {"timeout": None}

    @pytest.mark.parametrize("api_key", ["synthetic-session-key", ""])
    async def test_call_ai_reuse_rejects_key_without_prompt(self, mock_client: AsyncMock, api_key: str) -> None:
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            result = await call_ai("hello", session_id="existing", api_key=api_key)

        assert result.success is False
        assert result.error is not None and "api_key" in result.error
        assert result.text == result.error
        assert result.session_id == ("existing" if api_key else None)
        mock_client.create_session.assert_not_awaited()
        mock_client.prompt.assert_not_awaited()
        mock_client.delete_session.assert_not_awaited()
        if api_key:
            assert api_key not in result.error
            assert api_key not in str(log_debug.call_args_list)

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

    @pytest.mark.parametrize("api_key", [None, "synthetic-session-key"])
    async def test_call_ai_once_forwards_key_at_creation(self, mock_client: AsyncMock, api_key: str | None) -> None:
        mock_client.create_session.return_value = "sess-once-key"
        mock_client.prompt.return_value = AIResult(success=True, text="done")

        result = await call_ai_once("hello", api_key=api_key)

        assert result.session_id is None
        assert mock_client.create_session.call_args.kwargs["api_key"] == api_key
        mock_client.delete_session.assert_awaited_once_with("sess-once-key")

    async def test_call_ai_once_deletes_session_after_prompt_error(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-failed"
        mock_client.prompt.side_effect = RuntimeError("provider unavailable")

        key = "synthetic-session-key"  # pragma: allowlist secret — test sentinel
        result = await call_ai_once("hello", api_key=key)

        assert result.success is False
        assert result.session_id is None
        mock_client.delete_session.assert_awaited_once_with("sess-failed")

    async def test_call_ai_once_preserves_session_when_cleanup_fails(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.return_value = "sess-failed"
        mock_client.prompt.side_effect = RuntimeError("provider unavailable")
        mock_client.delete_session.side_effect = RuntimeError("cleanup failed")

        key = "synthetic-session-key"  # pragma: allowlist secret — test sentinel
        result = await call_ai_once("hello", api_key=key)

        assert result.success is False
        assert result.session_id == "sess-failed"
        mock_client.delete_session.assert_awaited()

    async def test_call_ai_redacts_escaped_key_in_prompt_error(self, mock_client: AsyncMock) -> None:
        key = 'synthetic-"secret-key'
        escaped_key = json.dumps(key)[1:-1]
        mock_client.create_session.return_value = "sess-key-error"
        mock_client.prompt.return_value = AIResult(success=False, text=escaped_key, error=escaped_key)

        with patch.object(pi_sidecar_client.logger, "error") as log_error:
            result = await call_ai("hello", api_key=key)

        assert key not in (result.text, result.error)
        assert escaped_key not in (result.text, result.error)
        assert key not in str(log_error.call_args_list)
        assert escaped_key not in str(log_error.call_args_list)

    async def test_call_ai_exception_preserves_sanitized_result(self, mock_client: AsyncMock) -> None:
        key = "synthetic-secret-key"
        mock_client.create_session.return_value = "sess-key-error"
        mock_client.prompt.side_effect = RuntimeError(f"provider rejected {key}")

        result = await call_ai("hello", api_key=key)

        assert not result.success
        assert result.text == result.error == "provider rejected [redacted]"
        mock_client.delete_session.assert_awaited_once_with("sess-key-error")

    async def test_call_ai_exception_hides_key_from_logs(self, mock_client: AsyncMock) -> None:
        key = "synthetic-secret-key"
        mock_client.create_session.return_value = "sess-key-error"
        mock_client.prompt.side_effect = RuntimeError(f"provider rejected {key}")

        with patch.object(pi_sidecar_client.logger, "error") as log_error:
            await call_ai("hello", api_key=key)

        assert key not in str(log_error.call_args_list)
        assert "provider rejected [redacted]" in str(log_error.call_args_list)

    async def test_call_ai_preserves_http_status_in_result(self, mock_client: AsyncMock) -> None:
        mock_client.create_session.side_effect = RuntimeError("Sidecar session creation failed (HTTP 400): invalid key")
        key = "synthetic-secret-key"  # pragma: allowlist secret — test sentinel
        result = await call_ai("hello", api_key=key)
        assert result.text == result.error == "Sidecar session creation failed (HTTP 400): invalid key"

    async def test_call_ai_rejects_unpaired_surrogate_before_http(self, mock_client: AsyncMock) -> None:
        key = "a\ud800b"
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            with patch.object(pi_sidecar_client.logger, "error") as log_error:
                result = await call_ai("hello", api_key=key)

        assert result.success is False
        assert result.text == result.error == "Invalid api_key: unpaired Unicode surrogate"
        mock_client.create_session.assert_not_awaited()
        log_debug.assert_called_once_with("API key validation: outcome=%s", "malformed")
        assert key not in str(log_debug.call_args_list)
        assert key not in str(log_error.call_args_list)

    @pytest.mark.parametrize("key", ["", "   ", "\ufeff\u00a0", "😀" * 513, "😀" * 1024])
    @pytest.mark.parametrize("entrypoint", ["create_session", "call_ai", "call_ai_once"])
    async def test_invalid_key_rejected_with_safe_validation_log_before_network(
        self, mock_client: AsyncMock, key: str, entrypoint: str
    ) -> None:
        client = SidecarClient(base_url="http://localhost:9100") if entrypoint == "create_session" else None
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            if client is not None:
                client._client.post = AsyncMock()
                with pytest.raises(ValueError, match="Invalid api_key") as exc_info:
                    await client.create_session(provider="google", model=key, system_prompt="hi", api_key=key)
                error = str(exc_info.value)
                client._client.post.assert_not_awaited()
            else:
                result = await (call_ai if entrypoint == "call_ai" else call_ai_once)(
                    "hello", ai_model=key, api_key=key
                )
                assert not result.success
                error = result.error or ""
            assert "Invalid api_key" in error
            mock_client.create_session.assert_not_awaited()
            mock_client.prompt.assert_not_awaited()
            mock_client.delete_session.assert_not_awaited()
            outcome = "oversized" if key.startswith("😀") else "blank"
            log_debug.assert_called_once_with("API key validation: outcome=%s", outcome)
            if key:
                assert key not in error
                assert key not in str(log_debug.call_args_list)
        if client is not None:
            await client.close()

    async def test_call_ai_once_rejects_unpaired_surrogate_with_safe_log(self, mock_client: AsyncMock) -> None:
        key = "a\ud800b"
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            result = await call_ai_once("hello", api_key=key)
        assert result.text == result.error == "Invalid api_key: unpaired Unicode surrogate"
        log_debug.assert_called_once_with("API key validation: outcome=%s", "malformed")
        assert key not in str(log_debug.call_args_list)
        mock_client.create_session.assert_not_awaited()

    async def test_call_ai_rejects_oversized_key_with_safe_log(self, mock_client: AsyncMock) -> None:
        key = "x" * 1025
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            result = await call_ai("hello", ai_model=key, api_key=key)
        assert result.error == "Invalid api_key: exceeds 1024 characters"
        mock_client.create_session.assert_not_awaited()
        log_debug.assert_called_once_with("API key validation: outcome=%s", "oversized")
        assert key not in str(log_debug.call_args_list)

    async def test_call_ai_once_rejects_oversized_key_with_safe_log(self, mock_client: AsyncMock) -> None:
        key = "x" * 1025
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            result = await call_ai_once("hello", ai_model=key, api_key=key)
        assert result.error == "Invalid api_key: exceeds 1024 characters"
        mock_client.create_session.assert_not_awaited()
        log_debug.assert_called_once_with("API key validation: outcome=%s", "oversized")
        assert key not in str(log_debug.call_args_list)

    async def test_call_ai_once_redacts_keyed_debug_fields(self, mock_client: AsyncMock) -> None:
        key = "synthetic-secret-key"
        mock_client.create_session.return_value = "sess-once"
        mock_client.prompt.return_value = AIResult(success=True, text="ok")
        with patch.object(pi_sidecar_client.logger, "debug") as log_debug:
            await call_ai_once(
                "hello",
                ai_provider=f"provider-{key}",
                ai_model=f"model-{key}",
                agent_dir=f"/tmp/{key}",
                tools=[key],
                api_key=key,
            )
        assert key not in str(log_debug.call_args_list)
        assert "[redacted]" in str(log_debug.call_args_list)

    async def test_call_ai_redacts_mixed_prompt_error(self, mock_client: AsyncMock) -> None:
        key = 'a"é'
        mock_client.create_session.return_value = "sess-key-error"
        mock_client.prompt.return_value = AIResult(success=False, text='rejected a\\"é', error='rejected a\\"é')
        result = await call_ai("hello", api_key=key)
        assert result.text == result.error == "rejected [redacted]"

    async def test_call_ai_redacts_encoded_prompt_error(self, mock_client: AsyncMock) -> None:
        key = "séc-ret"
        secret = json.dumps(key, ensure_ascii=True)[1:-1].replace("00e9", "00E9")
        mock_client.create_session.return_value = "sess-key-error"
        mock_client.prompt.return_value = AIResult(success=False, text=f"rejected {secret}", error=f"rejected {secret}")
        result = await call_ai("hello", api_key=key)
        assert result.text == result.error == "rejected [redacted]"

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
    @pytest.mark.parametrize(
        ("key", "secret"),
        [
            ('a"é', 'a\\"é'),
            ('a"é', 'a\\"\\u00E9'),
            ('a"é', "a%22%C3%A9"),
            ("Ab", "%41b"),
            ('a"é', '%61"é'),
            ('a"é', "a%22\\u00e9"),
            ('a"é', 'a\\"%c3%a9'),
            ('a"é', 'a"é'),
            ("Ab", "Ab"),
            ("\\" * 64 + "X", "\\" * 64 + "Y"),
            ("é", "\\u00E9"),
            ("😀", "\\uD83D\\uDE00"),
            ("é", "\\uD800"),
        ],
    )
    def test_redact_key_variants(self, key: str, secret: str) -> None:
        expected = secret if key == "\\" * 64 + "X" or secret == "\\uD800" else "[redacted]"
        assert _redact_api_key(secret, key) == expected

    def test_redact_repeated_backslash_near_match(self) -> None:
        key = "\\" * 128 + "X"
        value = ("\\" * 128 + "Y") * 100
        assert _redact_api_key(value, key) == "[error detail omitted]"

    def test_redact_max_key_near_match(self) -> None:
        key = "a" * 1023 + "X"
        value = "a" * 1023 + "Y"
        assert _redact_api_key(value, key) == value
        assert _redact_api_key(key, key) == "[redacted]"

    def test_redact_long_near_match_within_time_bound(self) -> None:
        key = "a" * 1023 + "X"
        value = "a" * 2048
        start = perf_counter()
        for _ in range(5):
            assert _redact_api_key(value, key) == value
        assert perf_counter() - start < 2.0

    def test_redact_mixed_escapes_at_maximum_key_length(self) -> None:
        key = "a" * 1021 + '"é😀'
        secret = "a" * 1021 + "%22\\u00e9%f0%9f%98%80"
        assert _redact_api_key("prefix " + secret, key) == "prefix [redacted]"

    def test_redact_oversized_detail_without_partial_secret(self) -> None:
        key = "secret-key"
        assert _redact_api_key("a" * 2048 + key, key) == "[error detail omitted]"

    def test_redact_preserves_literal_case(self) -> None:
        assert _redact_api_key("ab AB %61b", "Ab") == "ab AB %61b"

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
    async with SidecarClient(base_url="http://127.0.0.1:59999") as client:
        assert isinstance(client, SidecarClient)


@pytest.mark.asyncio
async def test_async_context_manager_closes_on_exit() -> None:
    client: SidecarClient
    async with SidecarClient(base_url="http://127.0.0.1:59999") as client:
        pass
    with pytest.raises(RuntimeError, match="already closed"):
        async with client:
            pass


@pytest.mark.asyncio
async def test_async_context_manager_reuse_after_close() -> None:
    client = SidecarClient(base_url="http://127.0.0.1:59999")
    await client.close()
    with pytest.raises(RuntimeError, match="already closed"):
        async with client:
            pass
