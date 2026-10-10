# Async & Runtime Internals

## Async LLM capability (`supportsAsyncLlm`)

Detached LLM async agents spawn a child `pi` with `PI_SUBAGENT_CHILD=1`. The acpx
provider **does not load** in those children (nested `cursor-agent` hangs), so an
**acpx parent cannot host async LLM children on the parent model**.

The user-facing behavior matrix — what happens to optional async, must-async
(dream/cron/fireAndForget), and `cli-*` parents — is documented in
[Running Background Agents and Scheduled Tasks](async-agents-and-cron.html). This page covers the mechanism behind it:

- Registration list: `acpx_agents` → `getRegisteredAcpxProviders` / `isAcpxProvider` (which agents we register)
- Capability gate: **any** provider id starting with `acpx-` → `supportsAsyncLlm` false (`isAcpxProviderId`), even if not in settings — children never load acpx
- `cli-${agent}` from `cli_agents` loads in subagent children, so `supportsAsyncLlm` is `true` for `cli-*`

Settings: `acpx_agents`, `cli_agents`, `internal_operations_provider` + `internal_operations_model` — see [Project Settings Internals](project-settings.html) and [CLI Provider Internals](cli-provider.html).

**acpx runtime resolution:** `extensions/acpx-provider/load-runtime.ts` prefers a
global `npm install -g acpx`, then falls back to the package-local `acpx`
dependency (required so plain `pi` / `~/.pi` installs can `import("acpx/runtime")`).
Package dep range is `">=0.12.0 <1"` (latest within acpx 0.x; see issue #651).
Not `^0.8.0` (that stays on 0.8.x under 0.x caret rules).

**Native createProvider (pi ≥ 0.84.0):** `acpx-*` registers via
`extensions/shared/create-runtime-provider.ts` (same helper as `cli-*`):
ambient `resolve`/`check` succeed when `isAcpxAgentConfigured` (`agents.has`);
`/login acpx-<agent>` stores an optional `configured` marker (not required for ambient
auth); `fetchModels` rediscovers via `discoverModelsInternal` (returns `[]` if no
state; empty discovery with state → `${agent}:default`);
`filterModels` also gates on `agents.has` — **not** a live health probe;
`session_shutdown` clears AgentState / maps and resets providers `initialized`
so the next factory re-registers (required for `/new`|`/resume`|`/fork` to keep
saved `cli-*` / `acpx-*` defaults — same lifecycle as native `createProvider`
in `extensions/providers/`);
streams use `{ stream, streamSimple }` → `streamAcpx`.
No legacy `registerProvider(name, { streamSimple })` bag.

**Meta invocations:** `isPiMetaInvocation()` (`extensions/orchestrator/utils.ts`)
skips acpx/cli provider discovery on `pi --help` / `--version` (`-h` / `-v`).

**Oneshot invocations:** `isPiOneshotInvocation()` / `shouldSkipOneshotRegister()`
(`extensions/shared/oneshot.ts`, re-exported from `extensions/orchestrator/utils.ts`)
skip pitasks, pidash, pidiff, and coms on `-p` / `--print` / `--mode json` so the
process can exit after the reply. CLI/ACPX providers still load. Last valid
`--mode <text|json|rpc>` wins (matching pi `parseArgs`); rpc is never oneshot
even with `-p`. `--mode=json` / `--mode=rpc` are unknown flags in pi, not mode.
The scanner consumes the next token after value flags so `--mode -p` is not
oneshot. No `--` end-of-options (parseArgs has none). Argv detection does not
cover non-TTY stdin or stdout without `-p`/`--print`/`--mode json`
(`echo hi | pi`, `pi | cat`); register skips are argv-only — `ctx.mode`
exists only after session_start.
`shouldSkipOneshotShutdownDream(mode)` skips when argv is oneshot **or**
`mode` is `print`/`json`.

**Code-enforced (not prompt-only):**

- `subagent-tool.ts` — coerce / sidecar / skip via `decideAsyncLlmDispatch`
- `enforcement.ts` — does not push “use async” sleep/repeat blocks when capability is false
- `dreaming.ts` / `cron.ts` — sidecar or skip on acpx

## Async-Only Agents

Some agents are enforced to only run with `async: true` — sync calls are automatically
promoted to async by `subagent-tool.ts`. This prevents the LLM from blocking the session
waiting for long-running agents.

**Currently enforced (native / `supportsAsyncLlm` only):**

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`
- `code-reviewer-docs`
- `code-reviewer-spec`

On acpx parents these agents run **sync** (coerced) instead of being forced async.

**To add/remove agents from the async-only list:**

1. Edit the `ASYNC_ONLY_AGENTS` set in `extensions/orchestrator/subagent-tool.ts`
2. Update this section in `docs/async-internals.md`

## Project-Scoped Temp Directories

All async agent temp files live under `.pi/tmp/`. Session cron files are local state only; project cron tasks use a versioned envelope at `<project>/.pi/cron/crons.json`.

```text
.pi/tmp/
├── debug.log                                 # Async debug log
├── cron-<sha256(session-id)>.json            # Session cron state; retained on reload/resume, removed on new/fork/quit
├── async-results-pid-<pid>-<starttime>/      # Async agent completion results
└── worker-<id>/                              # Async agent working dir
    ├── status.json                           # Agent state (running/complete/failed)
    ├── session.json                          # Parent PID + starttime for zombie detection
    ├── output.log                            # Agent output
    └── system-prompt.md                      # Agent system prompt
```

**Deterministic session IDs:** Async agents use `--session-id` (hash of agent name + task prefix) alongside `--no-session` by default.
This enables provider-side prompt caching for repeated async agent patterns.
`--no-session` creates an in-memory session (no disk persistence); `--session-id` assigns a stable ID for cache affinity.
Both flags are compatible: pi uses `SessionManager.inMemory(cwd, { id: sessionId })` when both are set.

**Persistent sessions (`persistSession: true`):** When enabled (via subagent parameter),
`--no-session` is omitted so the session persists to disk.
The session ID is derived from `agentName + cwd + parentSessionId` (not task prefix)
so the same agent in the same project reuses its session across calls.

**Reviewer session reuse:** Code-reviewer agents automatically use persistent sessions
during the review loop (cycle 2+). On the first cycle (`needs_review`/`none`), they get
a fresh session. On subsequent cycles (`has_findings`/`in_progress`), they reuse their
session from the previous cycle — keeping codebase context and previous findings.
When the loop finishes clean and a new edit triggers `markNeedsReview`, sessions
start fresh again.

**Session auto-clearing:** When a reviewer's context usage exceeds 80% of the model's
context window, its persisted session file is deleted to force a fresh session on the
next cycle, preventing context overflow.

**Zombie cleanup:** On `session_start`, checks each agent's `parentPid` + `parentStartTime` against `/proc/PID/stat` — dead parent = zombie = delete.

**Shared helper:** `getProjectTmpDir(cwd)` in `utils.ts` — returns `<cwd>/.pi/tmp/`, creates dir if missing.

**Enforcement:** `rm -rf` within `.pi/tmp/` or `/tmp/<something>` is silently allowed
(paths resolved via `realpathSync()` to prevent symlink traversal).
Read-only commands with dangerous patterns in args are also excluded from confirmation.

## Argv and mode guards

Modes: `"tui"` (interactive), `"rpc"` (programmatic), `"json"` (structured output), `"print"` (one-shot).
`ctx.mode` does not exist at extension register time — use argv helpers there.

| Feature | Guard | Reason |
|---------|-------|--------|
| Session extras register (pitasks, pidash, pidiff, coms) | `shouldSkipOneshotRegister()` / argv `isPiOneshotInvocation()` | Watchers/sockets keep the event loop alive; argv runs before `ctx.mode` exists |
| Shutdown dream spawn | `shouldSkipOneshotShutdownDream(mode)` — argv oneshot **or** `mode === "print"\|"json"` | `runDreamAsync` → `spawnAsyncAgent` is not detached/unref'd |
| Daemon connections (pidash, pidiff) | `ctx.mode === "tui"` | No UI to display (rpc/tui path after register) |
| Autocomplete providers | `ctx.mode === "tui"` | No editor input |
| Cron scheduling | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no timers |
| Dreaming (auto-dream timer) | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no background work |

Use `ctx.hasUI` for simple UI guards (`notify`, `select`, `confirm`). Use argv helpers for register-time oneshot skips. Use `ctx.mode` in session callbacks after mode exists.

## Kill origin attribution

`killAsyncAgent(target, origin)` takes a typed `AsyncKillOrigin` so a kill is never
misattributed to the user. The label is persisted to `status.json` as `killOrigin`
plus `output`, and prefixes the `## Async Agent Result` delivery to the AI.

| Origin | Caller | Label |
|--------|--------|-------|
| `user` | async-status overlay `x`/`a`, pidash browser UI | `Killed by user` |
| `orchestrator` | `subagent(asyncKill=…)` — an LLM decision | `Killed by orchestrator` |
| `task-system` | pitasks `subagents:rpc:stop` | `Killed by task system` |

The pidash browser UI is a human clicking, so it counts as `user`. An unrecognised
runtime value falls back to `user`. The async-status detail header appends
`· killed by <origin>` for failed jobs.

## Related Pages

- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — the user-facing async and cron workflows this page implements.
- [Background Memory Consolidation (Dreaming)](background-dreaming.html) — the dream passes that rely on async LLM capability.
- [Inter-Agent Communication](inter-agent-communication.html) — peer-to-peer messaging between async agents.
- [CLI Provider Internals](cli-provider.html) — the `cli-*` providers that load in subagent children.
- [Configuration & Settings](configuration.html) — the async-related settings keys.
