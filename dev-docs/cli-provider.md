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
6. Start session reaper (5m sweep; no immediate sweep at load) for
   `~/.pi/cli-sessions/` — never deletes `status=running` markers for the
   **active** pi session id (mid-session idle must not orphan the live CLI chat —
   issue #661). While the active id is unknown, all running markers are kept.
   Idle markers from other `piSessionId`s (or legacy `default`) may be reaped
   once the active id is known, even if still `running`.
7. On `session_start`:
   - Bind markers to real `sessionManager.getSessionId()` (not env `PI_SESSION_ID`)
   - `reason=resume` / `new` (or pi session id change): clear markers for this
     `piSessionId` (+ legacy `default`), force next turn to re-seed from pi
     `context.messages` (other concurrent pi sessions in the same cwd are kept)
   - `reason=reload`: keep markers so CLI `--resume` continues
8. On `session_shutdown`: stop reaper, clear in-memory state (disk markers kept
   for `/reload` resume)

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
(from `sessionManager.getSessionId()`, falling back to `"default"`):

- Fields: `sessionId`, `status`, `createdAt`, `lastSeenAt`, `resumeFailures`, `piSessionId`
- **Reaper:** every 5m, drop idle markers (≥ 30m). Never deletes `status=running`
  for the **active** `piSessionId`. Idle running markers from other sessions (or
  legacy `default`) may be reaped once the active id is known. While the active
  id is still unknown (startup before `session_start`), all running markers are
  kept so `/reload` continuity is not wiped (issue #661)
- `/reload` keeps markers so `--resume` can continue
- `/resume` / `/new` clears this session’s markers (+ legacy `default`) and forces
  a history re-seed on the next turn

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
