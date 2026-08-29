# Pi-Sidecar Consumer Guide

Best practices for integrating `@myk-org/pi-sidecar` into your project.

## Installation

### Node.js (TypeScript server wrapper)

Create a `sidecar-helper/` directory in your project:

```bash
mkdir -p sidecar-helper
cd sidecar-helper
npm init -y
npm install @myk-org/pi-sidecar
```

### Python client

```bash
# In your project's pyproject.toml dependencies:
"pi-sidecar-client>=4.2.0"

# Or install directly:
uv add pi-sidecar-client
```

## Project Structure

Recommended layout for projects using pi-sidecar:

```text
your-project/
├── sidecar-helper/
│   ├── package.json          # @myk-org/pi-sidecar dependency
│   ├── package-lock.json
│   └── src/
│       └── server.ts         # Thin wrapper calling startSidecar()
├── pyproject.toml             # pi-sidecar-client dependency
├── your_app/
│   └── ai_client.py          # Uses pi_sidecar_client
└── entrypoint.sh              # Starts sidecar + your app
```

## Server Wrapper (TypeScript)

Create `sidecar-helper/src/server.ts`:

```typescript
import { bindSidecarListenExit, startSidecar } from "@myk-org/pi-sidecar";

const handle = startSidecar({
  port: parseInt(process.env.SIDECAR_PORT || "9100"),
  host: process.env.SIDECAR_HOST || "127.0.0.1",
});
bindSidecarListenExit(handle);

process.on("SIGTERM", async () => {
  await handle.close();
  process.exit(0);
});
```

## Python Client Usage

### Simple one-shot call

```python
from pi_sidecar_client import call_ai_once

result = await call_ai_once(
    "Summarize this log file",
    ai_provider="google",
    ai_model="gemini-2.5-flash",
    system_prompt="You are a log analyst.",
)
print(result.text)
```

### Multi-turn session

```python
from pi_sidecar_client import SidecarClient

async with SidecarClient() as client:
    session_id = await client.create_session(
        provider="google",
        model="gemini-2.5-flash",
        system_prompt="You are a helpful assistant.",
    )
    try:
        result1 = await client.prompt(session_id, "What is Python?")
        result2 = await client.prompt(session_id, "Show me an example")
    finally:
        await client.delete_session(session_id)
```

### Custom tools

```python
result = await call_ai_once(
    "Look up the status of project X",
    ai_provider="google",
    ai_model="gemini-2.5-flash",
    system_prompt="You have access to project tools.",
    custom_tools=[
        {
            "name": "get_project_status",
            "description": "Get the status of a project",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string"}
                },
                "required": ["project_name"]
            },
            "http": {
                "method": "GET",
                "url": "https://api.example.com/projects/{project_name}/status",
                "headers": {"Authorization": "Bearer YOUR_TOKEN_HERE"}
            }
        }
    ],
)
```

## CLI Commands

After `npm install @myk-org/pi-sidecar`, run from the `sidecar-helper/` directory:

```bash
cd sidecar-helper

# Start the sidecar server (foreground)
npx pi-sidecar

# Start/stop in background (port 9201)
npx pi-sidecar-start
npx pi-sidecar-start --stop
npx pi-sidecar-start --help
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDECAR_PORT` | `9100` | Listen port (`9201` for start script). `startSidecar()` stamps this env while running (default, `options.port`, or `0` for ephemeral) so nested Cursor CLI can detect sidecar and pass `--approve-mcps`. `close()` restores the inherited value. |
| `SIDECAR_HOST` | `127.0.0.1` | Bind address |
| `SIDECAR_URL` | `http://127.0.0.1:9100` | Python client base URL |
| `CLI_AGENTS` | (none) | Comma-separated CLI agents: `cursor,claude,gemini` |
| `ACPX_AGENTS` | (none) | Comma-separated ACPX agents: `cursor,claude,gemini` |
| `GEMINI_API_KEY` | (none) | Google AI API key (native provider) |
| `GOOGLE_API_KEY` | (none) | Alternative Google API key |
| `GOOGLE_CLOUD_PROJECT` | (none) | GCP project for Vertex AI Claude |
| `SIDECAR_WATCHDOG_URL` | (none) | Health-check URL for watchdog |
| `DEV_MODE` | `false` | Bind to `0.0.0.0` when `true` |

## Entrypoint Pattern

For containerized deployments:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Start sidecar in background
cd /app/sidecar-helper
SIDECAR_PORT="${SIDECAR_PORT:-9100}" \
CLI_AGENTS="${CLI_AGENTS:-}" \
ACPX_AGENTS="${ACPX_AGENTS:-}" \
  nohup node node_modules/@myk-org/pi-sidecar/dist/server.js \
  > /tmp/sidecar.log 2>&1 &

# Wait for health
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:${SIDECAR_PORT:-9100}/health" && break
  sleep 1
done

# Start your app
exec your-app "$@"
```

## Docker Integration

> **Example files:** [`Dockerfile.example`](Dockerfile.example) and [`entrypoint.example.sh`](entrypoint.example.sh) — copy these to your project as a starting point.

### Multi-stage build pattern

> See [`Dockerfile.example`](Dockerfile.example) for the full working example.

Use a dedicated sidecar builder stage to keep the runtime image small:

```dockerfile
# Stage: Sidecar Builder
FROM node:22-slim AS sidecar-builder
WORKDIR /sidecar

COPY sidecar-helper/package.json sidecar-helper/package-lock.json* ./
RUN npm ci

COPY sidecar-helper/ .
RUN npx tsc
RUN npm prune --omit=dev
```

In your runtime stage, copy only the built artifacts:

```dockerfile
# Copy sidecar (dist + node_modules + package.json)
COPY --from=sidecar-builder /sidecar/dist /app/sidecar-helper/dist
COPY --from=sidecar-builder /sidecar/node_modules /app/sidecar-helper/node_modules
COPY --from=sidecar-builder /sidecar/package.json /app/sidecar-helper/package.json
```

### Runtime dependencies

The runtime stage needs Node.js, `curl` (health checks), `bash`, and `uv` (if using Python).
See [`Dockerfile.example`](Dockerfile.example) for the complete setup including system packages, non-root user, and PATH configuration.

### CLI agents

Install CLI agents for CLI/ACPX providers. See [`Dockerfile.example`](Dockerfile.example) for the complete pattern with correct `HOME` and npm prefix setup.

Required CLIs:

| CLI | Install method | Binary location |
|-----|---------------|-----------------|
| Claude Code | `curl -fsSL https://claude.ai/install.sh` piped to `bash` | `~/.local/bin/claude` |
| Cursor Agent | `curl -fsSL https://cursor.com/install` piped to `bash` | `~/.local/bin/agent` |
| Gemini | `npm install -g @google/gemini-cli` | npm global bin |
| ACPX | `npm install -g acpx` | npm global bin |

**Note:** Gemini requires npm prefix setup (`npm config set prefix`) for non-root users.
The Cursor CLI binary is named `agent`, but the sidecar agent name is `cursor`.
Claude and Cursor use official vendor install scripts — verify URLs before use in production.

### Entrypoint pattern

> See [`entrypoint.example.sh`](entrypoint.example.sh) for the full working example.

Key requirements:

- Start sidecar in background with `node .../dist/server.js &`
- **Lifecycle coupling:** `trap` to kill sidecar on exit
- **Monitor:** background watcher kills container if sidecar dies
- **Health wait:** poll `/health` up to 15s before starting app
- **Exit on failure:** if sidecar not healthy, exit 1 (don't proceed with broken AI)
- **Run app in background + wait** — start your app with `&`, then `wait $APP_PID`. This lets the EXIT trap fire for sidecar cleanup.
- **Forward signals** — trap SIGTERM and SIGINT separately: `trap 'kill -TERM $APP_PID' TERM` and `trap 'kill -INT $APP_PID' INT`
- **Use `tini` as PID 1** — ensures signals reach the entrypoint shell. Use `ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]` in your Dockerfile.

### Health check

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${SIDECAR_PORT:-9100}/health || exit 1
```

### Key rules

- **Always copy 3 things** from sidecar builder: `dist/`, `node_modules/`, `package.json`
- **Don't exec** the main app if sidecar is running — use plain invocation so the EXIT trap fires
- **Monitor the sidecar** — if it dies, kill the container (avoid silent AI failures)
- **Set `SIDECAR_PORT`** explicitly — default is 9100
- **Set `CLI_AGENTS`/`ACPX_AGENTS`** env vars if CLI agents are installed

## API Quick Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/models` | List all available models |
| `GET` | `/models/:provider/status` | Provider diagnostics |
| `POST` | `/models/refresh` | Refresh model catalog |
| `POST` | `/sessions` | Create a session |
| `POST` | `/sessions/:id/prompt` | Send a prompt |
| `POST` | `/sessions/:id/abort` | Abort in-progress prompt |
| `DELETE` | `/sessions/:id` | Delete a session |

### Create Session

```bash
curl -s -X POST http://127.0.0.1:9100/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-2.5-flash",
    "provider": "google",
    "system_prompt": "You are a helpful assistant.",
    "cwd": "/tmp"
  }'
# Returns: {"session_id": "<uuid>"}
```

`cwd` is the session working directory. Pi tools (`read` / `ls` / `grep` /
`bash`) use it, and nested CLI/ACPX agents (`cli-cursor` `--workspace`, spawn
cwd, ACPX `ensureSession`) inherit that same folder. Omit `cwd` and the sidecar
still defaults to its process working directory (`process.cwd()`). Pass an
explicit project path when you want job isolation.

### Send Prompt

```bash
curl -s -X POST http://127.0.0.1:9100/sessions/<session-id>/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message": "What is 2+2?"}'
# Returns: {"text": "4", "usage": {"input_tokens": ..., "output_tokens": ..., "cost_usd": ...}}
```

## Provider Types

| Provider | Source | Models | Cost reported |
|----------|--------|--------|--------------|
| `google` | Native (API key) | Gemini models | ✅ Yes |
| `google-vertex` | Native (ADC) | Gemini via Vertex | ✅ Yes |
| `google-vertex-claude` | Vertex Claude extension | Claude via Vertex | ✅ Yes |
| `cli-cursor` | Cursor CLI (`agent`) | Cursor models | ❌ No |
| `cli-claude` | Claude CLI | Claude models | ❌ No |
| `cli-gemini` | Gemini CLI | Gemini models | ❌ No |
| `acpx-cursor` | ACPX + Cursor | Cursor models | ❌ No |

## Versioning

All packages in the pi-config monorepo share the same version number:

- `pi-orchestrator-config` (npm)
- `@myk-org/pi-sidecar` (npm)
- `@myk-org/pi-vertex-claude` (npm)
- `myk-pi-tools` (PyPI)
- `pi-sidecar-client` (PyPI)

Sidecar depends on `pi-orchestrator-config` and `@myk-org/pi-vertex-claude` at
`>=4.3.4` (not `*`, which can resolve to an older published tag) — installing
sidecar pulls the full set.

`@myk-org/pi-vertex-claude` is standalone: it does not depend on
`pi-orchestrator-config`. Its peer deps require
`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `>=0.84.4` — same
floor as sidecar.
