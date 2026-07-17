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

## Load flow (matches acpx-provider)

1. Read `cli_agents` at extension load
2. For each agent: probe binary (30s discovery timeout), create agent state
3. **Discover models from the CLI only** (see below) — no API keys, no cloud list APIs
4. Register `cli-${agent}` with discovered models, or `${agent}:default` if discovery returns empty
5. Skip registration if binary missing (no agent state)
6. Start session reaper (30m idle / 5m sweep) for `~/.pi/cli-sessions/`
7. On `session_shutdown`: stop reaper, clear in-memory state (disk markers kept for reload resume)

`pi --help` / `pi --version` (and `-h` / `-v`) still load extensions; both
`cli-provider` and `acpx-provider` early-return via `isPiMetaInvocation()` so
they do not run model discovery for meta invocations.

## Model discovery (CLI only)

| Agent | How models are discovered |
|-------|---------------------------|
| `cursor` | Run `agent --list-models` (account-scoped list from the CLI) |
| `claude` | No list flag — chunk-scan the selectable catalog embedded in the installed `claude` binary (no full-file string load; binaries are ~250MB+) |
| `gemini` | No list flag — parse `isVisible: true` model definitions from the installed `gemini` CLI package |

Results cached under `~/.pi/cli-model-cache/` (keyed by binary mtime/size; no TTL — invalidates when the binary changes).

No curated model lists and no API-key-based discovery.

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
   - **New CLI session** (e.g. switched to `cli-*` mid-pi-session) → seed prior pi user/assistant turns + current message (pi history is not deleted)
5. Stream `stream-json` events live into pi (`text_delta` / thinking) — not buffered until the end
6. Persist / touch session id (`lastSeenAt`) for later turns
7. If `--resume` fails (dead/invalid session): clear marker, re-seed history, retry once without resume

### Turn timeout (none by default)

`runCliAgent` has **no default `timeoutMs`**. Long turns (autoqodo, large tool
loops) must not be killed by an arbitrary wall clock. Cancellation is via
upstream **`AbortSignal`** only. Callers may pass explicit `timeoutMs` when they
want a bound. See issue #647.

### Session directory (`~/.pi/cli-sessions/`)

File-backed bindings keyed by cwd + agent + model + `PI_SESSION_ID` (t3-style directory, lighter):

- Fields: `sessionId`, `status`, `createdAt`, `lastSeenAt`, `resumeFailures`
- **Reaper:** every 5m, drop markers idle ≥ 30m (or `status=stopped`)
- Reload keeps markers so `--resume` can continue across `/reload`

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

Helper: `extensions/shared/file-logger.ts` (`getPiLogPath` is pure; mkdir only on write; newlines collapsed to `\n`; falls back to `$TMPDIR/pi-logs/` if `~/.pi/logs` unwritable).

## Async

Unlike `acpx-provider`, this extension **loads in subagent children** (`PI_SUBAGENT_CHILD`).  
`supportsAsyncLlm` is **true** for `cli-*` — no coerce-to-sync, no sidecar required.

## Bug / fix policy

A bug reported against **one** CLI (e.g. cursor) is assumed to apply to **all** `cli-*` agents unless proven agent-specific (unique flag/binary quirk).

When fixing: check and land the same class of fix for `cursor`, `claude`, and `gemini` (trust/approve flags, streaming, history seeding, session resume, parsing, etc.).

## Module

`extensions/cli-provider/` — per-agent drivers under `agents/` (add a new CLI there + register in `providers.ts`). `discoverCliModels()` exported for external registries.
