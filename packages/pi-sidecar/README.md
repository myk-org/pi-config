# pi-sidecar

A standalone HTTP service that wraps the
[Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(requires `@earendil-works/pi-coding-agent` ≥ 0.87.0), exposing AI sessions over a
simple JSON API. Ships with a Python client for easy integration.

📖 **[Full Documentation](https://myk-org.github.io/pi-config/)**

## Features

- **Session management** — create, prompt, abort, and delete AI sessions over REST; optionally supply a provider-agnostic, session-scoped API key
- **Model discovery** — discover models from ACPX, CLI, and built-in providers.
  See [key-scoped model discovery](#key-scoped-model-discovery) for user keys.
- **Provider discovery** — `GET /providers` lists every provider registered in
  the initialized runtime, including built-ins and extensions, even without
  discoverable models or ambient credentials. The JSON response is
  `{ "providers": [{ "provider": string, "supportsSessionApiKey": boolean }] }`.
  `provider`
  is the exact ID; `supportsSessionApiKey` says whether `POST /sessions` accepts
  `api_key`, not whether the server has credentials. No credentials or auth
  diagnostics are returned. Python: `await SidecarClient.get_providers()`
  returns a typed list of these records. Use discovery to enumerate providers,
  `GET /models` for available models, and `GET /models/:provider/status` for
  details about a known provider.
- **Provider diagnostics** — `GET /models/:provider/status` reports registration,
  model count, auth status, and `supportsSessionApiKey` (a boolean indicating
  whether `POST /sessions` accepts `api_key` for that provider, regardless of
  server credentials; false for unknown, headless-excluded, and ambient
  CLI/ACPX providers). Python: `SidecarClient.get_model_provider_status()`.
  Full auth detail on
  loopback; on non-loopback binds (`SIDECAR_HOST` / `DEV_MODE`)
  `authStatus`/`authCheck` are redacted to `{ configured }` / `{ type }`;
  `supportsSessionApiKey` remains public on both binds and in 404 responses
- **Custom tools** — plug in domain-specific tools at session creation via `custom_tools`
- **HTTP-backed tools** — custom tools with `http` config get automatic request execution with parameter interpolation and security hardening
- **Subagent delegation** — delegate tasks to specialized agents via the `subagent` tool (loaded as a Pi SDK extension)
- **Watchdog** — opt-in health-check poller for companion backend liveness
- **Localhost-only** — binds to `127.0.0.1` by default; no auth needed behind the network boundary

## Packages

| Package | Language | Install |
|---------|----------|---------|
| `@myk-org/pi-sidecar` | TypeScript | `npm install @myk-org/pi-sidecar` |
| `pi-sidecar-client` | Python ≥ 3.10 | `uv pip install pi-sidecar-client` |

The npm tarball is the Node server only. Python wheels/sdists publish to PyPI — they must not ship
inside `@myk-org/pi-sidecar` even though `uv build` writes them to the same `dist/` as `tsc`.

## Quick Start

```python
from pi_sidecar_client import call_ai_once

result = await call_ai_once(
    "Summarize this log file",
    ai_provider="gemini",
    ai_model="gemini-2.5-flash",
    system_prompt="You are a log analyst.",
)
print(result.text)
```

To override the server's stored/environment API key for one session, pass
`api_key=user_api_key` to `SidecarClient.create_session`, `call_ai`, or
`call_ai_once`. The wire field is `api_key` in `POST /sessions` (a non-empty
string of at most 1,024 characters); the response remains `{ "session_id": "..." }`. The key applies only
to the selected provider and that session, takes precedence over server
credentials, and is held in memory until the session is deleted or expires.
Omitting it preserves server credential fallback. Providers without Pi API-key
auth capability reject it with HTTP 400; OAuth, Vertex/ADC and CLI login state
are not configured by this field. Keys are not saved in session files, returned
in API responses, or passed to nested agents. Treat sidecar access as privileged:
its default loopback bind is not an authentication boundary against local users.

```bash
# Start the sidecar
npm run build && node dist/server.js  # listens on 127.0.0.1:9100

# Or, for local development (background by default; default port 9201 — override with SIDECAR_PORT; see --help):
scripts/start-sidecar.sh
```

See the [Consumer Integration Guide](CONSUMER-GUIDE.md) for Docker, Python client, and deployment best practices.
See the [full documentation](https://myk-org.github.io/pi-config/) for everything else.

## Key-scoped model discovery

`GET /models` uses the server's credentials. Static `getModels` metadata
cannot verify what a supplied key can access. For providers with
`supportsSessionApiKey: true` in `GET /providers`, query with the key instead:

```bash
curl -s -X POST http://127.0.0.1:9100/models/for-api-key \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai","api_key":"<your-key>"}'
# Returns: {"models": [...], "modelListingSupported": true}
```

The response is `{ "models": [...], "modelListingSupported": boolean }`.
A provider with native key-scoped listing returns `modelListingSupported: true`;
`models: []` then means the listing returned no models. A provider without
native key-scoped listing returns `{ "models": [], "modelListingSupported": false }`.
In that case, ask the user to enter a model ID. A listing is only **key-listed**:
it does not verify that a prompt will work. Google results require
`generateContent`; known non-generation OpenAI model families are excluded,
but remaining IDs are not **prompt-verified**. Do not use static catalog entries
as verified models for that key. Known static IDs can be used with a supplied
key. Unknown IDs can create a session only when the native listing supplies
reliable positive input and output token limits (currently Google); otherwise
`POST /sessions` returns HTTP 400 for missing model metadata.

In Python, `await SidecarClient.get_models_for_api_key(provider, api_key)`
returns the full dictionary, including `models` and `modelListingSupported`.
Providers without `supportsSessionApiKey` return HTTP 400. The lookup is
request-local: the sidecar does not cache the supplied key or result.

## CLI Commands

After installing `@myk-org/pi-sidecar`, two CLI commands are available:

```bash
# Start the sidecar server (Node.js entry point)
npx pi-sidecar

# Start/stop via shell script (background mode, dev defaults on port 9201)
npx pi-sidecar-start
npx pi-sidecar-start --stop
npx pi-sidecar-start --help
```

## License

Apache-2.0
