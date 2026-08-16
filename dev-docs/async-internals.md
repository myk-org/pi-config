# Async & Runtime Internals

## Async LLM capability (`supportsAsyncLlm`)

Detached LLM async agents spawn a child `pi` with `PI_SUBAGENT_CHILD=1`. The acpx
provider **does not load** in those children (nested `cursor-agent` hangs), so an
**acpx parent cannot host async LLM children on the parent model**.

**Detection:**

- Registration list: `acpx_agents` → `getRegisteredAcpxProviders` / `isAcpxProvider` (which agents we register)
- Capability gate: **any** provider id starting with `acpx-` → `supportsAsyncLlm` false (`isAcpxProviderId`), even if not in settings — children never load acpx

| Parent provider | `supportsAsyncLlm` | Behavior |
|-----------------|--------------------|----------|
| Native (anthropic, openai, …) | `true` | Today's force-async system unchanged |
| Any `acpx-*` provider id | `false` | Coerce optional `async: true` → sync; must-async (dream/cron/fireAndForget) uses settings sidecar or skips |
| `cli-${agent}` from `cli_agents` | `true` | CLI providers load in subagent children — async works; no coerce |

Module: `extensions/orchestrator/async-capability.ts`  
Settings: `acpx_agents`, `cli_agents`, `internal_operations_provider` + `internal_operations_model` (see `dev-docs/project-settings.md`, `dev-docs/cli-provider.md`)

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

**Oneshot invocations:** `isPiOneshotInvocation()` skips pitasks, pidash, pidiff,
and coms on `-p` / `--print` / `--mode json` so the process can exit after the
reply. CLI/ACPX providers still load. `--mode rpc` is long-lived and is not skipped.

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
2. Update this section in `dev-docs/async-internals.md`

## Project-Scoped Temp Directories

All async agent temp files live under `.pi/tmp/`:

```text
.pi/tmp/
├── debug.log                                 # Async debug log
├── cron-<pid>-<suffix>.json                  # Cron task state
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

## Mode-Aware Guards (`ctx.mode`)

Modes: `"tui"` (interactive), `"rpc"` (programmatic), `"json"` (structured output), `"print"` (one-shot).

| Feature | Guard | Reason |
|---------|-------|--------|
| Daemon connections (pidash, pidiff) | `ctx.mode === "tui"` | No UI to display |
| Autocomplete providers | `ctx.mode === "tui"` | No editor input |
| Cron scheduling | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no timers |
| Dreaming (auto-dream timer) | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no background work |

Use `ctx.hasUI` for simple UI guards (`notify`, `select`, `confirm`); use `ctx.mode` when interactive vs. one-shot distinction matters.
