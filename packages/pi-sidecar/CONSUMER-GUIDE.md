# Pi-Sidecar Consumer Guide

Best practices for integrating `@myk-org/pi-sidecar` into your project.

## Prerequisites

`@myk-org/pi-sidecar` package metadata requires `@earendil-works/pi-coding-agent`
and `@earendil-works/pi-ai` version `>=1.5.0`. At startup, the sidecar checks
only the `pi-coding-agent` floor. Upgrade both dependencies before starting the
service if either is older — the floor moved up because the sidecar and the
orchestrator now use APIs added in 1.5.0.

## Installation

### Version alignment

Keep the npm package and the Python client on the **same version**. They are released together
and share one version number:

| Package | Registry |
|---|---|
| `@myk-org/pi-sidecar` | npm |
| `pi-sidecar-client` | PyPI |
| `pi-orchestrator-config` | npm |

Bump both when you bump either. A half-applied bump changes one runtime's dependency graph and
leaves the other stale, and nothing errors — the versions simply disagree.

Use a **range**, never an exact pin. An exact pin never moves on its own, so consumers stay on
vulnerable versions indefinitely and no upstream fix can ever reach them.

```json
"@myk-org/pi-sidecar": ">=4.6.5"
```

```toml
"pi-sidecar-client>=4.6.5"
```

### Node.js (TypeScript server wrapper)

Create a `sidecar-helper/` directory in your project:

```bash
mkdir -p sidecar-helper
cd sidecar-helper
npm init -y
npm install @myk-org/pi-sidecar
```

### Re-resolving after a version bump

**Delete the lockfile. Refreshing it is not sufficient.**

```bash
cd sidecar-helper
rm -rf node_modules package-lock.json
npm install
```

A plain `npm install` — including `rm -rf node_modules && npm install` with the lockfile left in
place — does **not** re-resolve. npm treats existing lockfile entries as still satisfying their
ranges and preserves them. The result reads like a successful bump while the tree underneath is
unchanged, so it audits like the pre-bump world. Automated dependency bots that update a lockfile
incrementally hit exactly this.

This is how a stale tree survived across a manifest fix: the declaration was corrected, the
lockfile that overrode it was not.

Verify the resolved tree rather than trusting the version you asked for:

```bash
npm ls @myk-org/pi-sidecar pi-orchestrator-config @huggingface/transformers sharp adm-zip --all
```

Every `sharp` and `adm-zip` should be on a patched version, and `npm ls` must report no
`invalid` or `extraneous` entries. A nested `sharp` flagged `extraneous` is a leftover from a
previous resolution, not a harmless extra.

### Python client

```bash
# In your project's pyproject.toml dependencies — keep in step with the npm package:
"pi-sidecar-client>=4.6.5"

# Or install directly:
uv add pi-sidecar-client
```

Then regenerate the Python lock so the client actually moves:

```bash
uv lock
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

### Streaming a prompt

`SidecarClient.stream_prompt()` opens the session's event feed, sends the prompt,
and yields each frame's parsed payload as a dict, closing the feed when the
turn's terminal event (`turn_end` or `error`) arrives. It is an async generator,
so existing `prompt()` callers keep working unchanged.

```python
from pi_sidecar_client import SidecarClient

async with SidecarClient() as client:
    session_id = await client.create_session(
        provider="google",
        model="gemini-2.5-flash",
        system_prompt="You are a helpful assistant.",
    )
    try:
        final = ""
        async for event in client.stream_prompt(session_id, "What is Python?"):
            if event["type"] == "text_delta":
                print(event["delta"], end="", flush=True)  # already redacted
            elif event["type"] == "turn_end":
                final = event["text"]  # authoritative — not the joined deltas
            elif event["type"] == "error":
                raise RuntimeError(event["message"])
        print(final)
    finally:
        await client.delete_session(session_id)
```

The same session can be streamed again for its next prompt, including after an
abort. Token counts and cost are not on the feed — read them from the
`prompt()` response.

### Per-session API key

```python
result = await call_ai_once(
    "Summarize this log file",
    ai_provider="google",
    ai_model="gemini-2.5-flash",
    api_key=user_api_key,
)
```

`SidecarClient.create_session(..., api_key=...)` and `call_ai(..., api_key=...)`
accept the same optional field. On the wire, `POST /sessions` takes `api_key`
as a non-empty string of at most 1,024 characters; no existing parameter or response changes. The supplied
key overrides stored/environment credentials only for that session's selected
provider; omit it to use server credentials. Check `GET /models/:provider/status` for `supportsSessionApiKey` before
sending a key. This boolean is independent of server credentials and remains
visible on non-loopback binds and unknown-provider 404 responses (false).
Headless-excluded and ambient CLI/ACPX providers report false. Unsupported API-key auth returns
400. Keys live in memory until session deletion/expiry, not session files or
API responses, and are not inherited by nested agents. Keep sidecar access
restricted to trusted callers, particularly when binding beyond loopback.

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
| `GET` | `/models/:provider/status` | Provider diagnostics, including `supportsSessionApiKey` |
| `POST` | `/models/refresh` | Refresh model catalog |
| `POST` | `/sessions` | Create a session |
| `POST` | `/sessions/:id/prompt` | Send a prompt |
| `GET` | `/sessions/:id/events` | SSE turn event feed for one session (additive — see [Event streams](#event-streams-sse)) |
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

### `cost_usd` semantics

`cost_usd` is the accumulation of the costs the driver actually reported. Two
other values carry meaning, and conflating them is how unknown spend turns into
a believable number:

| Value | Meaning |
|-------|---------|
| number | Costs were reported and accumulated. |
| `null` | Nothing usable was reported, so no total can be given. |
| number + `cost_partial: true` | A **lower bound**: at least one turn's cost could not be determined, so the real total may be higher — it may also be the same. |

Read `cost_usd` together with `cost_partial`, never on its own. `cost_partial`
is `false` when every reported turn cost was usable.

The complication is Pi pricing metadata. Pi requires numeric prices, so a model
whose source published none — one resolved from a **key-scoped listing**
(`POST /models/for-api-key`, or a model id absent from the catalog), a CLI/ACPX
discovery with no catalog price, or an OpenAI-compatible `/v1/models` record with
no priced component — is registered with zero prices. Those zeros mean *unknown
pricing*, not *free*, so the sidecar cannot derive a cost for those turns — but a
driver may still report one (ACPX models without catalog prices do).

A catalog all-zero cost means the opposite: the price is known to be zero (an
OpenRouter `:free` variant, for example), so such a model is free and reports a
real `$0`. The two are told apart by provenance, not by the number, so no model
or provider id is special-cased.

So the four cases are:

1. **Catalog model, costs reported** → number, `cost_partial: false`. A free
   model lands here as `0` with `cost_partial: false`.
2. **Unknown-priced model, driver reports nothing usable** → `null`.
3. **Unknown-priced model, driver reports some turns** → number **plus**
   `cost_partial: true`, because the unreported turns may still have cost. Note
   this means *may be* higher, not *is* higher: an unreported turn can genuinely
   cost zero, so `cost_partial` marks the total as incomplete rather than
   asserting missing spend.

Pi 1.5.0 adds `Usage.cost.totalFromProvider`: true when the driver's `cost.total` is
the provider's billed amount, false or absent when it is a catalog estimate. A
provider-billed total is authoritative exactly as sent — including a billed `0` —
and is kept even when the model's catalog pricing is unknown. The `null` and
partial cases above still describe unreported or catalog-estimated cost only: a
catalog estimate on an unknown-pricing model yields `cost_usd: null` or a
`cost_partial: true` lower bound, and unknown spend and free spend are told apart
by provenance, not by the number.

Token counts (`input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens`) are always populated regardless of pricing.

> ⚠️ **Consumers must not treat `null` as `0`, and must not present a
> `cost_partial` total as complete.** Aggregating with `COALESCE(SUM(cost_usd), 0)`
> reports unknown-only spend as a genuine zero, and summing without carrying the
> flag reports mixed spend as a complete total. Sum the cost with a plain
> `SUM(cost_usd)` and carry the partial flag in its own expression, then label any
> total that includes unknown spend as incomplete.

Aggregation differs by engine, so pick the form that matches yours:

```sql
-- PostgreSQL: bool_or over the boolean column
SELECT SUM(cost_usd) AS cost_usd, bool_or(cost_partial) AS cost_partial
FROM ai_token_usage WHERE ...;

-- SQLite / MySQL (no boolean aggregate): compare a sum of the flag instead
SELECT SUM(cost_usd) AS cost_usd,
       COALESCE(MAX(cost_partial), 0) AS cost_partial
FROM ai_token_usage WHERE ...;
```

Do **not** combine a boolean aggregate with a sum of booleans in one expression
(`bool_or(cost_partial) OR SUM(cost_partial) > 0`): `SUM(boolean)` is not valid
on PostgreSQL.

### Event streams (SSE)

`GET /sessions/:id/events` streams one session's turns as server-sent events so
a UI can render text while it is generated. It is **additive**: open the feed,
then send the prompt with `POST /sessions/:id/prompt` exactly as today. A caller
that never opens the feed behaves exactly as it does now — same request, same
response shape, same timing — and a dead or slow subscriber can never fail a
prompt.

| Event | Payload | Notes |
|---|---|---|
| `session` | `{type, sessionId}` | sent on connect |
| `turn_start` | `{type, turnId}` | one per accepted prompt; `turnId` is monotonic per session |
| `text_delta` | `{type, turnId, delta}` | `delta` is already redacted server-side |
| `turn_end` | `{type, turnId, text, aborted}` | the turn finished; `aborted: true` after an abort |
| `error` | `{type, turnId, message}` | the turn failed; `message` comes from the already-redacted error list |
| `: keepalive` | — | SSE comment every 15 s; not an event |

Every frame is a single `data:` line holding JSON (`JSON.stringify`), because
model output routinely contains newlines and an unescaped payload would let a
delta forge its own frames. The event name lives in the payload's `type` field —
there is no SSE `event:` line — so listen with `onmessage` and switch on
`payload.type`; `addEventListener("text_delta", ...)` never fires.

**End of turn:** every `turnId` receives exactly one terminal event — either
`turn_end` or `error`, never both and never two. That event ends the turn; the
next `turn_start` starts the following one.

**`turn_end.text` is authoritative and is not `concat(deltas)`.** Deltas are
per-message, redacted through a bounded holdback, and are emitted before
boundary separators are spliced, so joining them does not reproduce the final
text. The holdback keeps the tail of a turn's text pending until
`api_key.length - 1` further characters have arrived, so a secret the model
echoes *split across two deltas* is replaced as a whole instead of leaking as
fragments; deltas therefore lag the model by up to that many characters (0 when
the session carries no `api_key`), and the withheld tail is flushed as the last
`text_delta`(s) immediately before the terminal event, so nothing is lost.
Never join or persist deltas as if they were the answer — a client that needs
the text uses `turn_end.text`, which is the final post-boundary, post-redacted
text.

`turn_end` carries **no usage or cost** in v1 — do not assume `usage` is there.
Read token counts and cost from the `POST /sessions/:id/prompt` response, which
still reports them exactly as documented above.

**Abort:** `POST /sessions/:id/abort` during an open feed ends the turn with
`turn_end {aborted: true}`. The stream stays open and can be reused for the next
prompt; aborting with no turn in flight is a no-op.

**Limits.** 8 open streams per session and 32 process-wide; a request past
either cap returns `429`, an unknown session returns `404` — both as plain JSON,
written before any event data. A subscriber that leaves more than 1 MiB buffered
is dropped on its own; the turn's full text remains available from the `prompt`
response. A stream idle for 10 minutes is ended, where idle is measured on turn
events only — `: keepalive` comments do not reset the timer, so a subscribe-only
client is still reaped.

`Origin` and `Host` are validated for this endpoint only (mismatch → `403`), so
a DNS-rebinding page cannot read the feed. The rest of the HTTP surface,
including `/prompt`, is unchanged.

```js
const { session_id } = await (
  await fetch("http://127.0.0.1:9100/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", model: "gemini-2.5-flash" }),
  })
).json();

// Open the feed BEFORE prompting — deltas emitted before you connect are gone.
const source = new EventSource(`http://127.0.0.1:9100/sessions/${session_id}/events`);
source.onmessage = (msg) => {
  const event = JSON.parse(msg.data);
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "turn_end") { source.close(); console.log(event.text); }
  if (event.type === "error") { source.close(); console.error(event.message); }
};

// The prompt itself is unchanged — the feed only observes it.
await fetch(`http://127.0.0.1:9100/sessions/${session_id}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "What is 2+2?" }),
});
```

The feed sends `X-Accel-Buffering: no` and flushes its headers immediately, so
reverse proxies do not hold frames back. If a proxy in front of the sidecar
still compresses or buffers the response, deltas arrive as one burst at the end
— disable that for this path.

## Provider Types

| Provider | Source | Models | Cost reported |
|----------|--------|--------|--------------|
| `google` | Native (API key) | Gemini models in the catalog | ✅ Yes |
| `google` | Key-scoped listing | Model ids **not** in the catalog | ⚠️ `null` unless the driver reports a real cost |
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
`pi-orchestrator-config`. Its `@earendil-works/pi-coding-agent` / `pi-ai` peer
deps are `"*"` — host-provided, so npm enforces no floor there; the
orchestrator warns and the sidecar refuses to start below the floor described
above.
