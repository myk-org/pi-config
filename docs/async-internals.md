# Async & Runtime Internals

## Async LLM capability & Runtime Invocations

Detached LLM async agents spawn a child `pi` with `PI_SUBAGENT_CHILD=1`. All
registered providers support async LLM children. Optional
`internal_operations_provider` + `internal_operations_model` can override the
model used by background dreaming (see [Project Settings Internals](project-settings.html)).

**Meta invocations:** `isPiMetaInvocation()` (`extensions/orchestrator/utils.ts`)
skips provider session wiring on `pi --help` / `--version` (`-h` / `-v`).

**Oneshot invocations:** `isPiOneshotInvocation()` / `shouldSkipOneshotRegister()`
(`extensions/shared/oneshot.ts`, re-exported from `extensions/orchestrator/utils.ts`)
skip pitasks, pidash, pidiff, and coms on `-p` / `--print` / `--mode json` so the
process can exit after the reply. Last valid
`--mode <text|json|rpc>` wins (matching pi `parseArgs`); rpc is never oneshot
even with `-p`. `--mode=json` / `--mode=rpc` are unknown flags in pi, not mode.
The scanner consumes the next token after value flags so `--mode -p` is not
oneshot. No `--` end-of-options (parseArgs has none). Argv detection does not
cover non-TTY stdin or stdout without `-p`/`--print`/`--mode json`
(`echo hi | pi`, `pi | cat`); register skips are argv-only — `ctx.mode`
exists only after session_start.
`shouldSkipOneshotShutdownDream(mode)` skips when argv is oneshot **or**
`mode` is `print`/`json`.

## Async-Only Agents

Some agents are enforced to only run with `async: true` — sync calls are automatically
promoted to async by `subagent-tool.ts`. This prevents the LLM from blocking the session
waiting for long-running agents.

**Currently enforced:**

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`
- `code-reviewer-docs`
- `code-reviewer-spec`

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

## Sync agent runs (`sync-agent-runs.ts`)

`asyncState.jobs` only ever held background jobs, so a running sync subagent — a real
child `pi` process, several at once in parallel mode — was invisible in the footer,
`/async-status` and pidash. `extensions/orchestrator/sync-agent-runs.ts` is a
process-local registry that closes that gap: `beginSyncAgentRun()` on spawn,
`end(ok)` from the `finally` in `runSingleAgent` so abort/throw/error paths cannot leak
an entry, `setTool()` for the current tool, `setAbort()` for the kill escalation, and
`onSyncAgentRunsChanged()` for repaints. Entries are deleted when they end, so
`listSyncAgentRuns()` is running-only.

- Footer: `formatAgentsStatus(asyncRunning, syncRunning)` — `💤 agents: 0` idle,
  `⏳ async: N` for async-only (unchanged look), `⏳ agents: T (A async, S sync)` when mixed.
- `/async-status`: sync rows carry `mode: "sync"` and are stopped through
  `abortSyncAgentRun` (by run id, never by agent name). A sync run is also stopped by
  cancelling the parent turn. The pidash row is display-only: the browser has no sync
  kill button, and a pidash kill never reaches a sync child
  (`tests/node/orchestrator/sync-agent-runs-wiring.test.ts`).
- Each run writes `<cwd>/.pi/tmp/sync-runs/sync-<session>-<n>/status.json` — the session id
  (or the pid when there is none) namespaces both id and dir, so two sessions sharing a cwd
  never share a run dir. Running at `beginSyncAgentRun`
  with agent/task/startedAt, updated with `setPid`/`setTool`, final `complete`/`failed` plus
  `killOrigin` on end or abort — so the detail header reads a sync row through the same
  `readLiveStatus(workerDir)` as an async job. No `output.log`: the row has no output pane.
  The dir goes with its row (finished-run grace, cap, or teardown).
- Two stops are tracked independently: a parent abort always cancels the call (throws), a
  registry stop alone returns a failed result so the batch survives. A registry-stopped
  result is marked `stoppedByRegistry`, which exempts it from the single-agent sync
  overrun penalty.
- `session.json` is deliberately absent, so the async restore, delivered-id and zombie
  scans (which read `PROJECT_TMP_DIR` one level up) never adopt a sync run.
- Visibility only: delivery of a sync agent's result is unchanged — it arrives in the
  orchestrator's turn, never as a follow-up. Nothing in the registry may be treated as
  an async job by the poller, restore, chain or delivery paths.
- Teardown: `clearSyncAgentRuns()` on `session_shutdown`, with the widget subscription.

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

## Provider Restore & Runtime Lifecycle

- **Saved default-model restore & thinking level (`extensions/providers/`):** Cold-start restore runs on `startup` and
  `resume`, skips when `enabledModels` is non-empty, and merges trusted project settings. Per-model thinking levels are
  persisted via `extensions/providers/last-thinking-level.ts`.
- **Sidecar fatal exit & ops logs:** `bindSidecarListenExit()` exits with code `1` on fatal sidecar listen errors;
  operational logs live under `~/.pi/logs/`.
- **Timers & reload safety:** Guard timer and async callbacks with `isLiveExtensionCtx` (`extensions/shared/live-ctx.ts`)
  and clear all intervals on `session_shutdown`.

## Related Pages

- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — the user-facing async and cron workflows this page implements.
- [Background Memory Consolidation (Dreaming)](background-dreaming.html) — the dream passes that rely on async LLM capability.
- [Inter-Agent Communication](inter-agent-communication.html) — peer-to-peer messaging between async agents.
- [Configuration & Settings](configuration.html) — the async-related settings keys.
