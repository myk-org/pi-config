# CLI Provider Extension

Registers real CLI tools as pi providers under the `cli-*` namespace, parallel to `acpx-*`.

## Settings

| Setting | Env | Example |
|---------|-----|---------|
| `cli_agents` | `CLI_AGENTS` | `"cursor"` or `["claude","gemini","cursor"]` |

```json
{
  "cli_agents": ["claude", "cursor"]
}
```

Empty / unset → extension registers nothing.

`cli_agents` is coerced with `asStringArray` before `.filter` so a stale/mismatched
`getSetting` (non-array) cannot crash extension load (issue #651).

## Working directory (issue #768)

CLI/ACPX spawn uses the **pi session cwd** when it is bound, otherwise boot
`process.cwd()` (sidecar start dir, typically `/app` in a container).

Bind paths:

- Sidecar: `POST /sessions` `cwd` → `runWithSessionCwd` around `session.prompt()`
- Interactive pi: `before_agent_start` `ctx.cwd` → `enterSessionCwd` (skipped if ALS already set)
- `resolveProviderStreamCwd` reads ALS, then falls back to boot `projectCwd` (warn)

Two copies of `session-cwd.ts` share one store via `Symbol.for("pi-config.sessionCwdAls")`:
`extensions/shared/session-cwd.ts` and `packages/pi-sidecar/src/session-cwd.ts`.
Sidecar cannot import the extension file (`tsconfig` `rootDir` is `src/`). Keep the
symbol id in sync.

- Cursor: `--workspace <session-cwd>` and `spawn({ cwd })`
- Claude / Gemini: `spawn({ cwd })` only (no `--workspace` flag)
- ACPX: `ensureSession({ cwd })`; in-memory maps keyed per model+cwd

Headless Cursor passes `--approve-mcps` only when `CLI_APPROVE_MCPS` is set
(`false` opts out even in sidecar) or the process is a sidecar (`SIDECAR_PORT`).
`startSidecar()` stamps `SIDECAR_PORT` while running (default 9100, `options.port`,
or `0` for an OS ephemeral port) and restores the inherited value on `close()`. Interactive
pi omits the flag so project MCP still needs TTY approval. Headless Gemini defaults
`GEMINI_CLI_TRUST_WORKSPACE=true` on spawn but preserves an explicit parent
value (including `false`) — `--skip-trust` alone does not connect project
`.gemini/settings.json` MCP in untrusted folders (including `/tmp`). Claude
project `.mcp.json` loads via `-p` + `--dangerously-skip-permissions`.

## Load flow (matches acpx-provider)

1. Read `cli_agents` at extension load
2. For each agent: probe binary (30s discovery timeout), create agent state
3. **Discover models from the CLI only** (see below) — no API keys, no cloud list APIs
4. Register `cli-${agent}` via **`createRuntimeProvider()`** (shared helper wrapping
   `createProvider`) then `pi.registerProvider(provider)` (pi ≥ 0.84.0), with discovered
   models or `${agent}:default` if discovery returns empty
5. Skip registration if binary missing (no agent state)
6. Start session reaper (5m sweep; no immediate sweep at load) for
   `~/.pi/cli-sessions/` — deletes idle `status=stopped` markers only.
   Never deletes `status=running` (own or other `piSessionId`) so concurrent
   pi sessions in the same cwd keep CLI `--resume` (issue #661).
7. On `session_start` / `before_agent_start`:
   - Bind markers to real `sessionManager.getSessionId()` (not env `PI_SESSION_ID`)
   - Until bound, each process uses a unique provisional `tmp-<uuid>` bucket
     (never shared `"default"`) so concurrent sessions cannot steal `--resume`
   - On bind: migrate this process's provisional markers onto the real UUID
   - `reason=resume` / `new` (or pi session id change): clear markers for this
     `piSessionId` (+ this process provisional; legacy `default` only if still
     used), force next turn to re-seed from pi `context.messages` (other
     concurrent pi sessions in the same cwd are kept)
   - `reason=reload`: keep markers so CLI `--resume` continues
8. On `session_shutdown`: stop reaper, clear AgentState / in-memory maps, and
   reset providers `initialized` so the next factory invocation re-registers
   (needed for `/new`|`/resume`|`/fork`; disk markers kept for `/reload` resume)

`pi --help` / `pi --version` (and `-h` / `-v`) still load extensions; both
`cli-provider` and `acpx-provider` early-return via `isPiMetaInvocation()` so
they do not run model discovery for meta invocations.

## Native createProvider (pi ≥ 0.84.0)

Shared helper: `extensions/shared/create-runtime-provider.ts`.

| Piece | Behavior |
|-------|----------|
| **auth /login** | `/login cli-<agent>` stores marker credential `configured` when `isCliAgentConfigured` (binary on PATH **and** agent state). Ambient `resolve`/`check` succeed when configured. |
| **fetchModels** | Not configured (`!isCliAgentConfigured`) → `[]`. Configured (PATH + AgentState) + empty discovery → `${agent}:default`. |
| **filterModels** | Hides models when `isCliAgentConfigured` is false (binary gone or `agents` cleared on shutdown) |
| **streams** | Native `ProviderStreams`: `{ stream, streamSimple }` both wrap `streamCli` |

Legacy `pi.registerProvider(name, { apiKey, streamSimple })` bags are **not** used.

**Binary missing at load** → provider is not registered; install then `/reload` or
restart.

**Already registered, PATH cleared (AgentState remains)** → restore PATH; models
show again via filter/ambient. `/login` only stores the credential; model refresh
rediscovers.

**After `session_shutdown`** → AgentState / instance maps cleared and
`initialized` reset. The next extension factory call (after `/new`|`/resume`|
`/fork`) re-runs discovery + `registerProvider` so saved `cli-*` / `acpx-*`
defaults remain available. PATH restore alone does not recreate AgentState;
re-registration does.

### Cold-start default restore (#753)

pi `findInitialModel` needs both `getModel` and `hasConfiguredAuth`. Native
`createProvider` registration does not provisionally mark auth configured, so a
cold start can race: models are registered but `hasConfiguredAuth` is still
false → wrong initial model even when agent `settings.json` has
`defaultProvider` / `defaultModel`.

Implementation: `extensions/providers/restore-default-model.ts`, hooked from
`session_start` in `extensions/providers/index.ts` (fire-and-forget so startup
is not blocked by retries). Provider-agnostic — any saved default is restored
when gates pass (no hardcoded provider/model allowlists).

**Settings:** Merged like pi `SettingsManager` — global
(`PI_CODING_AGENT_DIR/settings.json` if set, else `~/.pi/agent/settings.json`)
plus project `cwd/.pi/settings.json` (from `ctx.cwd`) **only when the project
is trusted** (`ctx.isProjectTrusted()`); untrusted sessions use global defaults
only. When trusted, project wins for `defaultProvider` / `defaultModel` /
`enabledModels`. ExtensionContext has `cwd` but no `agentDir`.

**Gate (must all pass):**

1. Settings have both `defaultProvider` and `defaultModel` (non-empty)
2. `session_start` `reason` is `startup` or `new` (skip `resume` / `fork` /
   `reload`)
3. Current model is missing **or** current provider/id ≠ saved default
4. `process.argv` does not contain `--model`, `--provider`, or `--models`
   (CLI override)
5. Settings `enabledModels` is missing or empty (non-empty scopes models the
   same way as `--models`; restore must not set an out-of-scope default)

**Retry:** Up to 5 attempts × 100ms when the model is not yet resolvable
(`registry.find` / `getAvailable` fallback) or `setModel` returns false
(stale auth). Warns on exhaust for unresolvable **or** repeated `setModel`
failure/throw. Production does **not**
pass a `registeredProviders` list (a cli/acpx-only list would falsely
fail-fast native defaults). Optional `registeredProviders` fail-fast remains
for tests only. Does **not** fail-fast from `getAvailable()` missing the
target — that API is auth-filtered and can omit the default during the #753
race.

**Live re-check:** Before each attempt (and again immediately before
`setModel`), optional `getCurrentModel` (wired as `() => ctx.model`) aborts
if current already matches the saved default, changed away from the
`session_start` snapshot, or — when there was no initial model — any
non-default live selection appears mid-retry (user intent).

Complements #752 (`/new` re-register); does not replace an upstream
provisional-auth fix.

## Model discovery (CLI only)

| Agent | How models are discovered |
|-------|---------------------------|
| `cursor` | Run `agent --list-models` (account-scoped list from the CLI) |
| `claude` | No list flag — chunk-scan the selectable catalog embedded in the installed `claude` binary (no full-file string load; binaries are ~250MB+) |
| `gemini` | No list flag — parse `isVisible: true` model definitions from the installed `gemini` CLI package |

Results cached under `~/.pi/cli-model-cache/` (keyed by binary mtime/size; no TTL — invalidates when the binary changes).

No curated model lists and no API-key-based discovery.

### models.dev metadata fill (CLI / ACPX only)

Discovery still owns **which** models exist. After discovery, missing
`contextWindow` / `maxTokens` / cost / input modalities are filled
from [models.dev](https://models.dev) `api.json`.

Thinking level is **not** copied from the catalog. CLI `-high` /
ACPX `[effort=high]` (also `xhigh|medium|low|minimal|max|off`) set
`reasoning` and `pi.setThinkingLevel` on `session_start` / `model_select`.
`-fast` is not a thinking token. Catalog `reasoning: true` alone must
not show `thinking off` for `cursor-grok-4.6-high`.

- Cache: `~/.pi/pi-config/models.dev.json`
- Fetch on first use; refresh when the file is older than 1 day
- Stale cache is kept if the fetch fails
- Native pi providers are not modified
- Unmapped ids (e.g. `composer-2.5`) keep `buildRuntimeModel` defaults (200k / 32k)
- ACPX `context=` in the id (e.g. `[context=200k]`) wins over the catalog

Mapping examples: `cursor-grok-4.6-high` → `xai/grok-4.6`;
`claude-4.6-opus-high` → `anthropic/claude-opus-4-6`;
`grok-4.6[effort=xhigh,fast=false]` → `xai/grok-4.6`.

Code: `extensions/shared/models-dev.ts`.

### CLI model ids ≠ acpx model ids

`cli-*` and `acpx-*` share agent names (`cursor`, `claude`, …) but **not** model id strings. Always discover and pass ids in the namespace of the transport you use.

| Transport | Example ids |
|-----------|-------------|
| CLI (`agent --model`) | `composer-2.5`, `cursor-grok-4.5-high`, `claude-4.6-opus-high` |
| acpx (`availableModelIds`) | `composer-2.5[fast=true]`, `grok-4.5[effort=high,fast=true]`, `claude-opus-4-6[thinking=true,context=200k,effort=high]` |

Never feed acpx model ids into CLI `--model`, and never register acpx ids under `cli-*`.

## Turn flow (matches acpx-provider)

1. Await discovery `ready`
2. Ensure session (`--resume` id from `~/.pi/cli-sessions/`)
3. Apply system prompt **once** per model session (first turn)
4. Prompt:
   - **Existing CLI session** → latest user message only (CLI keeps its own history)
   - **New CLI session** (switched to `cli-*` mid-pi-session, or after `/resume` /
     `/new` forced re-seed) → seed prior pi user/assistant turns + current message
5. Stream `stream-json` events live into pi (`text_delta` / thinking) — not buffered until the end
6. Persist / touch session id (`lastSeenAt`) for later turns
7. If `--resume` fails (dead/invalid session): clear marker, re-seed history, retry once without resume.
   Abort / SIGTERM (exit 143) / SIGINT (130) do **not** clear the marker — that is
   cancel, not “session not found”.

### `/resume` ↔ CLI session contract (issue #661)

| Pi event | CLI marker | Next turn |
|----------|------------|-----------|
| `/reload` | keep | latest only (`--resume`) |
| `/resume` or `/new` | clear for cwd | re-seed from pi history (fresh CLI chat) |
| Mid-turn abort / SIGTERM | keep | retry or surface error — do not wipe |
| True “session not found” | clear | re-seed once |

Pi UI history and the Cursor/Claude/Gemini chat are different stores. After
`/resume`, only pi JSONL is authoritative until the next seeded CLI turn.

### Turn timeout (none by default)

`runCliAgent` has **no default `timeoutMs`**. Long turns (autoqodo, large tool
loops) must not be killed by an arbitrary wall clock. Cancellation is via
upstream **`AbortSignal`** only. Callers may pass explicit `timeoutMs` when they
want a bound. See issue #647.

### Session directory (`~/.pi/cli-sessions/`)

File-backed bindings keyed by cwd + agent + model + **pi session UUID**
(from `sessionManager.getSessionId()`). Before that UUID is known, each process
uses a unique provisional `tmp-<uuid>` id — never a shared `"default"` bucket —
so concurrent pi sessions cannot overwrite each other's CLI `--resume` markers.
On bind, provisional markers migrate onto the real UUID.

- Fields: `sessionId`, `status`, `createdAt`, `lastSeenAt`, `resumeFailures`, `piSessionId`
- **Reaper:** every 5m, drop idle `status=stopped` markers (≥ 30m). Never deletes
  `status=running` for any `piSessionId` — concurrent pi sessions in the same
  cwd keep CLI `--resume` (issue #661)
- `/reload` keeps markers so `--resume` can continue
- `/resume` / `/new` clears this session’s markers (+ this process’s provisional;
  legacy `default` only when still used) and forces a history re-seed on the next turn

## Streaming flags

| Agent | Live stream |
|-------|-------------|
| cursor | `--output-format stream-json --stream-partial-output` |
| claude | `--verbose --output-format stream-json --include-partial-messages` (`stream-json` requires `--verbose`) |
| gemini | `--output-format stream-json` (assistant text arrives as `type:message` deltas) |

## Provider ids

| Provider id | Binary | Model id shape |
|-------------|--------|----------------|
| `cli-claude` | `claude` | `claude:<model>` |
| `cli-gemini` | `gemini` | `gemini:<model>` |
| `cli-cursor` | `agent` | `cursor:<model>` |

## Headless trust vs tool approval

`cli-*` runs CLIs non-interactively (no TTY). Two separate concerns:

| Concern | What it does | If missing in headless |
|---------|--------------|------------------------|
| **Workspace trust** | Skip “do you trust this directory?” | Immediate exit / hard error |
| **Tool auto-approve** | Skip “allow this command/edit?” prompts | Hang, deny, or fail — **no user can answer** |

**Trust alone is not enough.** `--yolo` / `--force` is required so tool calls can proceed.

| Agent | Workspace trust | Tool auto-approve |
|-------|-----------------|-------------------|
| cursor | `--trust` | `--force` (`--yolo` alias) |
| claude | skipped by `-p` | `--dangerously-skip-permissions` |
| gemini | `--skip-trust` | `--yolo` |

This matches using the CLI as a backend LLM with full tool access (same intent as the system prompt we inject).

## Logging

Operational logs go to **`~/.pi/logs/`** (never `console.*` — that leaks into the chat text box):

| File | Contents |
|------|----------|
| `~/.pi/logs/cli-provider.log` | discovery, registration, resume recover, session reaper |
| `~/.pi/logs/dreaming.log` | dream skip/sidecar notes, provenance merge, promotion/rebuild errors |
| `~/.pi/logs/providers/` | `createLogger("providers")` — restore-default-model, initialized-guard, session_shutdown |
| `~/.pi/logs/models-dev/` | models.dev fetch/cache hit/miss and CLI/ACPX catalog mapping |

Helper: `extensions/shared/file-logger.ts`

- `getPiLogPath` is pure; mkdir only on write
- Newlines collapsed to `\n`
- Falls back to `$TMPDIR/pi-logs/` if `~/.pi/logs` unwritable
- Sync I/O by design for low-volume ops events (mkdir every write; no dir cache)

## Async

Unlike `acpx-provider`, this extension **loads in subagent children** (`PI_SUBAGENT_CHILD`).  
`supportsAsyncLlm` is **true** for `cli-*` — no coerce-to-sync, no sidecar required.

## Bug / fix policy

A bug reported against **one** CLI (e.g. cursor) is assumed to apply to **all** `cli-*` agents unless proven agent-specific (unique flag/binary quirk).

When fixing: check and land the same class of fix for `cursor`, `claude`, and `gemini` (trust/approve flags, streaming, history seeding, session resume, parsing, etc.).

## Specialist agents for CLI backends

Pi’s `subagent` tool is **not** in the CLI tool loop. Cursor / Claude / Gemini load
specialists from their own project dirs. Package source of truth remains `agents/*.md`.

### Container (`pi-docker`)

Automatic on start (`entrypoint.sh` → `scripts/symlink-cli-specialists.sh`):

| Dir | CLI |
|-----|-----|
| `.cursor/agents/*.md` | Cursor Agent (`cli-cursor`) |
| `.claude/agents/*.md` | Claude Code (`cli-claude`) |
| `.gemini/agents/*.md` | Gemini CLI (`cli-gemini`) |

File symlinks via `ln -sfn` (overwrite OK; concurrent containers on the same mount are fine).
Dirs are gitignored in the container (see `add_to_gitignore` in `entrypoint.sh`).

### Native (non-container)

No auto-sync. Symlink or copy package agents yourself, for example:

```bash
PKG="$HOME/.pi/agent/git/github.com/myk-org/pi-config/agents"
mkdir -p .cursor/agents .claude/agents .gemini/agents
for f in "$PKG"/*.md; do
  ln -sfn "$f" ".cursor/agents/$(basename "$f")"
  ln -sfn "$f" ".claude/agents/$(basename "$f")"
  ln -sfn "$f" ".gemini/agents/$(basename "$f")"
done
```

Cursor CLI Task discovery needs **project** `.cursor/agents/` (user-global
`~/.cursor/agents` is not enough in headless `-p`). Prefer the same project layout for
Claude/Gemini so all three match.

## Module

`extensions/cli-provider/` — per-agent drivers under `agents/` (add a new CLI there + register in `providers.ts`). `discoverCliModels()` exported for external registries.
