# pi-sidecar

A standalone HTTP service that wraps the
[Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(requires `@earendil-works/pi-coding-agent` ≥ 0.99.0), exposing AI sessions over a
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
- **Session transcripts** — opt-in JSONL recording of every turn (including
  full tool-call loops) for offline analysis; see
  [session transcripts](#session-transcripts)
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
In that case, ask the user to enter a model ID. A canonical builtin always
supports key-scoped listing on its own host, even when its catalog mixes APIs
(OpenRouter fronts Anthropic models alongside OpenAI ones); a models.json
`baseUrl` override or a custom gateway is still refused, so a request-supplied
endpoint never receives the credential — unless the admin flagged that custom
provider `trustKeyScopedListing` in the agent-dir `models.json` (see
[Custom providers and settings (agent dir)](#custom-providers-and-settings-agent-dir)) —
and for such a flagged provider, `models` is the **union** of the live listing
and the provider's manifest-configured `models[]` from `models.json` (see the
[`trustKeyScopedListing`](#key-scoped-listing-for-custom-providers-trustkeyscopedlisting)
section). A listing is only **key-listed**:
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

## Custom providers and settings (agent dir)

By default the sidecar's internal runtime keeps its catalog in the ephemeral,
non-configurable scratch dir `/tmp/pi-sidecar-agent`. Deployments that need to
register custom pi providers or supply pi settings point the sidecar at a
persistent **agent dir** instead:

```bash
# Environment variable (honored by npx pi-sidecar / pi-sidecar-start / node dist/server.js)
export PI_SIDECAR_AGENT_DIR=/etc/pi-sidecar/agent
npx pi-sidecar
```

```ts
// Or programmatically
import { startSidecar } from "@myk-org/pi-sidecar";
startSidecar({ agentDir: "/etc/pi-sidecar/agent" });
```

Precedence: explicit `agentDir` option → `PI_SIDECAR_AGENT_DIR` (trimmed,
non-empty) → `/tmp/pi-sidecar-agent`. Resolution is logged at startup. Use an
absolute path — a relative path resolves against the sidecar process's cwd,
which differs between the CLI entry and embedded `startSidecar()` callers.

Files honored from the configured dir (read once at process start — restart the
sidecar after changing them):

| File | Effect |
|------|--------|
| `models.json` | Custom pi providers registered on the shared runtime — listed by `GET /models` and `GET /providers`, usable in `POST /sessions`; providers flagged `trustKeyScopedListing` also serve `POST /models/for-api-key` |
| `auth.json` | Provider credentials for the shared runtime (same format as interactive pi's `auth.json`) |
| `settings.json` | Seeded into the in-memory settings store for the internal runtime and every session (e.g. `defaultProvider`) |

A `models.json` `apiKey` may reference an environment variable (e.g.
`"$ACME_API_KEY"`) — the variable must exist in the **sidecar process's**
environment (pass it through in Docker with `-e` / `Env:`). Worked example —
an Acme OpenAI-compatible gateway at `/etc/pi-sidecar/agent/models.json`:

```json
{
  "providers": {
    "acme": {
      "baseUrl": "https://acme.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$ACME_API_KEY",
      "models": [
        { "id": "acme/gpt-4o", "name": "GPT-4o via Acme" }
      ]
    }
  }
}
```

```bash
export PI_SIDECAR_AGENT_DIR=/etc/pi-sidecar/agent
export ACME_API_KEY=<your-key>
npx pi-sidecar
# GET /models now lists acme/gpt-4o (provider "acme");
# POST /sessions accepts {"provider": "acme", "model": "acme/gpt-4o", ...}
```

Notes:

- The per-request `agent_dir` field on `POST /sessions` still overrides only the
  session's resource loading (skills/prompts/agents) — it never reconfigures
  the shared runtime.
- There is no REST API change: `/health`, `/models`, `/providers`, and
  `/sessions` keep their semantics; the configured dir only changes what the
  runtime is seeded with at startup.
- Settings seeded from `settings.json` never re-enable compaction — sidecar
  sessions are short-lived and always run with compaction disabled.

### Key-scoped listing for custom providers (`trustKeyScopedListing`)

By default `POST /models/for-api-key` refuses to send a request-scoped (user)
key to any host that is not a provider-owned canonical builtin endpoint or a
literal loopback address, so custom gateways return
`{"models": [], "modelListingSupported": false}`. An admin can opt a single
custom provider into key-scoped model listing by flagging it in the agent
dir's `models.json` (read once at startup — restart the sidecar to apply):

```json
{
  "providers": {
    "acme": {
      "baseUrl": "https://acme.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$ACME_API_KEY",
      "trustKeyScopedListing": true,
      "models": [
        { "id": "acme/gpt-4o", "name": "GPT-4o via Acme" }
      ]
    }
  }
}
```

A flagged provider's listing request goes to exactly its configured `baseUrl`
— the same host the manifest's server credential (`apiKey`) already goes to.
The flag is honored **only** from this admin-controlled manifest; request- or
session-level input can never set it, and unflagged providers keep the default
refusal. URL hygiene is still enforced (no userinfo, query, or hash; only
`http:`/`https:`), and the provider must declare at least one model with all
models sharing the provider `baseUrl` (the existing uniformity check). The
extra field is ignored by pi's provider registration, so it does not affect
`GET /models` or `POST /sessions`.

For a flagged provider whose native listing succeeds, `POST
/models/for-api-key` returns the **union** of the live gateway listing and the
provider's manifest-configured `models[]` (snapshot at startup, same file
read as the flag). Real case: an Acme gateway lists 15 models via
`/v1/models` but not the manually configured `rits/zai-org/glm-5-3` — the
response contains both. Manifest-only models are appended after the live
entries in the same response shape (`provider`/`id`/`name`/`source`, plus
`capabilities.inputTokenLimit`/`capabilities.outputTokenLimit` when configured —
the models.json `contextWindow`/`maxTokens` mapped onto the same schema live
entries use). On an
id collision the manifest entry wins — the admin explicitly configured it —
replacing the live entry's name and metadata at the live position. The union
applies only to that provider's own listing; one provider's manifest models
never appear in another's response. When the native listing fails or is
refused (`modelListingSupported: false`), no union is applied.

Every entry carries a `source` provenance discriminator so consumers can
distinguish verified from admin-declared models: `"listing"` means the
gateway listed the id for this key — the id is verified for the credential
(this includes manifest-wins collision entries: the gateway did list the id,
and the manifest only supplied the name and token limits). `"manifest"`
means the entry is admin-declared in `models.json` only and was **not**
verified for this key — a user with a model-restricted key may not be able to
use it, so consumers must not treat it as accessible until access is confirmed
with that key.

A key-listed model used in `POST /sessions` with an `api_key` needs token
limits: when the live listing omits them, the sidecar falls back to the
manifest-declared `contextWindow`/`maxTokens` for that id, and otherwise
rejects the session with a 400 naming the models.json remedy — limits are
never fabricated for an unknown model.

## Session Transcripts

`RECORD_TRANSCRIPTS=1` (off by default) makes the sidecar persist every
session turn — the user prompt, assistant text, tool calls with their
arguments, tool results, and aggregated usage — as JSONL under
`~/.pi/sidecar/transcripts/{session_id}.jsonl`. One line is written per turn,
plus a `session_header` line on session creation (`created_at`, provider,
model, redacted system prompt, cwd, custom tool names). Turn records carry
the full redacted message array plus a `final_text` field with the assembled
response, the usage snapshot, and the stop reason. Prompts that reject
without completing still leave a turn record (partial output, errors,
usage) so failed turns are visible to offline analysis.

Every string in a record — including object property names — passes through
the session's credential redactor before it is written, and a single record
is capped at 8 MiB measured in UTF-8 bytes (an oversized record is replaced
with a small placeholder line). Writes for a session are chained in turn
order and drained at shutdown, so completed turns are not lost and records
never interleave. Writes are fail-soft: a transcript failure is logged and
swallowed, never propagated into the prompt response. When disabled, the
feature performs zero I/O — no directory is created, no file is touched,
and no per-turn state is kept.

Retention is enforced opportunistically (at most one scan per minute) on
session creation **and** while turns are being written, and never deletes
the transcript of a session that is still open. Files belonging to active
sessions are excluded from both age and size pruning.

| Env var | Effect |
|---|---|
| `RECORD_TRANSCRIPTS` | `1`/`true`/`yes`/`on` enables recording; anything else (or unset) disables it |
| `PI_SIDECAR_TRANSCRIPTS_DIR` | Override the transcript directory (default `~/.pi/sidecar/transcripts`) |
| `PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS` | Delete transcript files older than this many days (`0`/unset disables age pruning) |
| `PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB` | Delete oldest transcript files until the directory is under this budget (`0`/unset disables size pruning) |

**Container deployments:** the default directory lives under the user's
home directory, which is typically ephemeral in containers. Any deployment
that enables recording (e.g. RootCoz) MUST set `PI_SIDECAR_TRANSCRIPTS_DIR`
to a writable path on a persisted volume (RootCoz: a subdirectory of its
`/data` mount), or recorded transcripts are lost when the container is
replaced.

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
