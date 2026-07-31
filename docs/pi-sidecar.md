# or: pip install pi-sidecar-client
```

CLIs after install: `pi-sidecar` (server) and `pi-sidecar-start` (dev start script).

### 2. Start the sidecar

**Production-style (default port 9100):**

```bash
npx pi-sidecar
# or: node dist/server.js
```

**Local dev helper (default port 9201):**

```bash
npx pi-sidecar-start
# foreground: npx pi-sidecar-start --foreground
# stop:       npx pi-sidecar-start --stop
```

| Variable | Default (`pi-sidecar`) | Default (`pi-sidecar-start`) | Effect |
| :--- | :--- | :--- | :--- |
| `SIDECAR_PORT` | `9100` | `9201` | Listen port |
| `SIDECAR_HOST` | `127.0.0.1` | `127.0.0.1` | Bind address (`DEV_MODE=true` → `0.0.0.0` if host unset) |
| `SIDECAR_URL` | — | — | Client base URL (Python default `http://127.0.0.1:9100`) |
| `PI_SIDECAR_LOG_LEVEL` | `info` | `info` | Server / client log level |

> **Tip:** Point the client at the port you actually started. Dev script uses **9201**; the Node server and Python client default to **9100**.

```bash
export SIDECAR_URL=http://127.0.0.1:9201   # when using pi-sidecar-start
```

### 3. Wait until healthy

```bash
curl -s http://127.0.0.1:9100/health
```

| `status` | Meaning |
| :--- | :--- |
| `ok` | Ready (model discovery finished) |
| `starting` | Discovery still running (HTTP 503) |
| `degraded` | Discovery failed; sessions may still work for already-known models |

```python
from pi_sidecar_client import check_sidecar_available

ok, msg = await check_sidecar_available()
print(ok, msg)
```

### 4. Discover models

```python
from pi_sidecar_client import list_models

all_models = await list_models()
gemini = await list_models(provider="gemini")
```

Friendly Python provider aliases map to sidecar ids:

| Client alias | Sidecar provider |
| :--- | :--- |
| `gemini` | `google` |
| `cursor` | `acpx-cursor` (model prefixed with `cursor:` if needed) |
| `claude` | `google-vertex-claude` |

Refresh after changing agents or auth:

```bash
curl -X POST http://127.0.0.1:9100/models/refresh
```

Diagnose a single provider:

```python
from pi_sidecar_client import get_sidecar_client

client = get_sidecar_client()
status = await client.get_model_provider_status("google")
print(status["registered"], status["modelCount"])
```

> **Note:** On non-loopback binds, auth fields on provider status are redacted. Prefer `127.0.0.1` for local diagnostics. For Vertex auth setup, see [Google Vertex Claude Provider](vertex-claude-provider.html).

### 5. Run a session

**Single-shot (auto cleanup):** use `call_ai_once` as in the Quick Example.

**Multi-turn:**

```python
from pi_sidecar_client import call_ai, get_sidecar_client

result = await call_ai(
    "I'm building a REST API in Python. What framework should I use?",
    ai_provider="gemini",
    ai_model="gemini-2.5-flash",
    system_prompt="You are a senior Python developer. Be concise.",
)
session_id = result.session_id

result = await call_ai(
    "Show me a minimal example with that framework.",
    ai_provider="gemini",
    ai_model="gemini-2.5-flash",
    session_id=session_id,
)

await get_sidecar_client().delete_session(session_id)
```

Session lifecycle:

1. Create session (`POST /sessions`) with provider, model, system prompt, cwd.
2. Prompt (`POST /sessions/:id/prompt`) — one in-flight prompt per session.
3. Optional abort (`POST /sessions/:id/abort`).
4. Delete (`DELETE /sessions/:id`) when finished.

Default built-in tools when you omit `tools`: `read`, `grep`, `find`, `ls`, `bash`.

`cwd` loads project resources from `{cwd}/.pi/` and `AGENTS.md`. Optional `agent_dir` points at a global agent directory (e.g. `~/.pi/agent`); it is rejected on non-loopback binds unless `DEV_MODE=true` (then ignored).

## Advanced Usage

### HTTP API surface

| Method | Path | Effect |
| :--- | :--- | :--- |
| `GET` | `/health` | Readiness (`ok` / `starting` / `degraded`) |
| `GET` | `/models` | List discovered models |
| `POST` | `/models/refresh` | Re-run discovery |
| `GET` | `/models/:provider/status` | Registration, model count, auth (redacted off-loopback) |
| `POST` | `/sessions` | Create session → `{ session_id }` |
| `POST` | `/sessions/:id/prompt` | Send `{ "message": "..." }` |
| `POST` | `/sessions/:id/abort` | Cancel in-flight prompt |
| `DELETE` | `/sessions/:id` | Destroy session |

Body size limit: 1 MiB. Concurrent prompts on the same session return conflict (busy).

### Custom HTTP-backed tools

Pass `custom_tools` when creating a session. Entries with an `http` block are executed as outbound HTTP; `{param}` placeholders interpolate from tool args.

```python
result = await call_ai_once(
    "Look up user 42",
    ai_provider="gemini",
    ai_model="gemini-2.5-flash",
    custom_tools=[{
        "name": "fetch_data",
        "description": "Fetch user data by ID",
        "parameters": {
            "type": "object",
            "properties": {"userId": {"type": "string"}},
        },
        "http": {
            "method": "GET",
            "url": "https://api.example.com/users/{userId}",
        },
    }],
)
```

| `http` field | Type | Default | Effect |
| :--- | :--- | :--- | :--- |
| `method` | `GET` \| `POST` \| `PUT` \| `DELETE` \| `PATCH` | (required) | HTTP method |
| `url` | string | (required) | URL template with `{params}` |
| `headers` | object | — | Header templates |
| `query_params` / `queryParams` | object | — | Query templates |
| `body_template` / `bodyTemplate` | object \| string | — | Body template |
| `timeout_ms` / `timeoutMs` | number | `30000` | Request timeout |

Restrict the built-in tool allowlist with `tools=["read", "grep"]` (or `[]` for none).

### ACPX and CLI model sources

```bash
export ACPX_AGENTS=cursor
export CLI_AGENTS=claude,gemini
npx pi-sidecar
```

Then use providers such as `acpx-cursor` / `cli-claude` (or Python aliases `cursor` / mapped names). Refresh with `POST /models/refresh` after changing env. See [Configuration & Settings](configuration.html) for project-level agent lists used by interactive Pi.

### Watchdog (companion process)

```bash
export SIDECAR_WATCHDOG_URL=http://127.0.0.1:8000/health
npx pi-sidecar
```

When set, the sidecar polls that URL and shuts itself down after consecutive failures (default: 60s grace, 30s interval, 10s timeout, 6 failures).

### Docker / process coupling

Start the sidecar, wait for `/health`, then start your app and trap cleanup — see the package `entrypoint.example.sh` pattern (`SIDECAR_PORT` default `9100`).

### Using vs extending

| Goal | What you do |
| :--- | :--- |
| **Use** | Run `pi-sidecar`, call `call_ai_once` / `SidecarClient`, pass `custom_tools` / `tools` |
| **Extend** | Call `startSidecar({ port, host, watchdogUrl, watchdogOptions })` from Node, or override extension paths with `SIDECAR_ACPX_EXTENSION_PATH`, `SIDECAR_CLI_PROVIDER_EXTENSION_PATH`, `SIDECAR_PROVIDER_EXTENSION_PATH`, `SIDECAR_VERTEX_EXTENSION_PATH`, `SIDECAR_SUBAGENT_EXTENSION_PATH` |

Startup lifecycle:

1. Assert Pi SDK version ≥ 0.81.1.
2. Listen on host/port.
3. Optionally start watchdog.
4. Async model discovery — `/health` is `starting` until ready.
5. Serve session/prompt routes; idle sessions cleaned after 1 hour.

### Parallel calls and usage hooks

```python
from pi_sidecar_client import run_parallel_with_limit, set_usage_recorder

set_usage_recorder(my_recorder)  # sync or async; kwargs: request_id, result, call_type, ...
results = await run_parallel_with_limit(tasks, max_concurrency=5)
```

`ai_call_timeout` on `call_ai` / `call_ai_once` is in **minutes** (converted to HTTP timeout seconds).

## Troubleshooting

| Problem | Fix |
| :--- | :--- |
| Client connection errors | Align `SIDECAR_URL` with the server port (`9100` vs `9201`). |
| `/health` stuck on `starting` / 503 | Wait for discovery; check logs (`PI_SIDECAR_LOG_LEVEL=debug`). |
| Empty model list | Auth providers; set `ACPX_AGENTS` / `CLI_AGENTS`; `POST /models/refresh`; check `GET /models/:provider/status`. |
| Session create rejects model | Use an id from `GET /models`; interactive OAuth-only providers are blocked in this headless service. |
| `409` / session busy | Wait for the current prompt or `POST .../abort`. |
| `agent_dir` rejected | Bind on loopback, or use `DEV_MODE=true` (value discarded). |
| Pi version error at startup | Upgrade `@earendil-works/pi-coding-agent` to ≥ 0.81.1. |

> **Warning:** Default bind is loopback-only. Binding to `0.0.0.0` exposes an unauthenticated AI API on the network — use only behind a trusted boundary.

## Related Pages

- [Google Vertex Claude Provider](vertex-claude-provider.html)
- [ACPX Provider Integration](acpx-provider.html)
- [External AI Agents & CLI](external-ai-agents.html)
- [Configuration & Settings](configuration.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
