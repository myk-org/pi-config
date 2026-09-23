# pi-sidecar

A standalone HTTP service that wraps the
[Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(requires `@earendil-works/pi-coding-agent` ≥ 0.87.0), exposing AI sessions over a
simple JSON API. Ships with a Python client for easy integration.

📖 **[Full Documentation](https://myk-org.github.io/pi-config/)**

## Features

- **Session management** — create, prompt, abort, and delete AI sessions over REST; optionally supply a provider-agnostic, session-scoped API key
- **Model discovery** — auto-discover models from ACPX agents, CLI providers (`cli-*`), and built-in providers
- **Provider diagnostics** — `GET /models/:provider/status` reports registration,
  model count, and auth status for a single provider
  (Python: `SidecarClient.get_model_provider_status()`). Full auth detail on
  loopback; on non-loopback binds (`SIDECAR_HOST` / `DEV_MODE`)
  `authStatus`/`authCheck` are redacted to `{ configured }` / `{ type }`
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
string); the response remains `{ "session_id": "..." }`. The key applies only
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
