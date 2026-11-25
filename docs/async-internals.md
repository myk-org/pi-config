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
`/async` and pidash. `extensions/orchestrator/sync-agent-runs.ts` is a
process-local registry that closes that gap: `beginSyncAgentRun()` on spawn,
`end(ok)` from the `finally` in `runSingleAgent` so abort/throw/error paths cannot leak
an entry, `setTool()` for the current tool, `setAbort()` for the kill escalation, and
`onSyncAgentRunsChanged()` for repaints. Entries are deleted when they end, so
`listSyncAgentRuns()` is running-only.

- Footer: `formatAgentsStatus(asyncRunning, syncRunning)` — `💤 agents: 0` idle,
  `⏳ async: N` for async-only (unchanged look), `⏳ agents: T (A async, S sync)` when mixed.
- `/async`: sync rows carry `mode: "sync"` and are stopped through
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

- **Saved default-model restore & thinking level (`extensions/providers/`):** `extensions/providers/session-restore.ts`
  owns one ordered `session_start` flow (cold-start default-model restore on `startup`/`resume` — skipping when
  `enabledModels` is non-empty and merging trusted project settings — followed directly by per-model thinking-level
  restore persisted via `extensions/providers/last-thinking-level.ts`) and cancels pending retry timers on
  `session_shutdown` or superseded `session_start`.
- **Sidecar fatal exit & ops logs:** `bindSidecarListenExit()` exits with code `1` on fatal sidecar listen errors;
  operational logs live under `~/.pi/logs/`.
- **Timers & reload safety:** Guard timer and async callbacks with `isLiveExtensionCtx` (`extensions/shared/live-ctx.ts`)
  and clear all intervals on `session_shutdown`.

## Cross-Extension Lifecycle Hooks

Multiple extensions subscribe independently to `agent_end`, `turn_end`, and
`session_shutdown`. Extension load order is not guaranteed (in practice alphabetical
by directory, so `extensions/coms/` loads before `extensions/orchestrator/`); within
`extensions/orchestrator/`, handlers run in `index.ts` registration order. Handlers
that finalize state or queue `followUp` turns must coordinate across extensions
instead of assuming sole ownership.

| Hook | Extension / File | State Mutated / Action | Guards & Ordering Notes |
|------|------------------|------------------------|-------------------------|
| `agent_end` | `extensions/coms/coms-p2p.ts` | Clears `agentRunning`; safety-net finalizes delivered `currentInbound` (replies to peer and drains FIFO queue), or re-injects once / aborts undelivered non-`followUp` inbounds. | Skipped on oneshot register; loads before `orchestrator`; defers when `shouldDeferForMalformedRecovery()` is true. |
| `agent_end` | `extensions/orchestrator/malformed-response-recovery.ts` | Detects recoverable provider stop reasons (`MALFORMED_RESPONSE`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`); up to 2 consecutive retries, calls `markRecoveryPending(true)` and queues hidden `followUp` (`triggerTurn: true`); resets budget on normal turns; calls `notifyMalformedRecoveryAborted()` on send failure. | Coordinates with `coms-p2p` via `extensions/shared/session-bridge.ts`. |
| `agent_end` | `extensions/orchestrator/review-ui.ts` | Refreshes cached `lastCtx` for background `reviewPoller` / `gitDirtyPoller` status-bar updates. | — |
| `agent_end` | `extensions/orchestrator/status-line.ts` (2 handlers) | Cancels debounce timer and runs immediate git branch/status refresh (`updateBranch`); updates `lastActivityTime` and status-bar timestamp (`touchActivity`). | Guarded by `shutDown` / `ctx.hasUI`. |
| `agent_end` | `extensions/pidash/pidash.ts` (2 handlers) | `forward("agent_end")` sets `activity = "idle"`, bumps `activitySequence`, buffers/forwards over WS; second handler auto-names unnamed sessions once from first user prompt (`setSessionName`). | Guarded by `shuttingDown`. |
| `agent_end` | `extensions/pidiff/pidiff.ts` | Updates cached `lastCtx` and refreshes pidiff status slot when connected. | — |
| `turn_end` | `extensions/coms/coms-p2p.ts` | Early-finalizes delivered `currentInbound` on zero-tool-call, non-error/non-aborted assistant turns with `pendingSteers === 0`, draining the inbound FIFO queue so queued follow-ups/async results cannot starve `agent_end`. | Runs before `orchestrator`; skips when `toolResults.length > 0`, `hasToolCalls`, `stopReason` is `error`/`aborted`, or `pendingSteers > 0`. |
| `turn_end` | `extensions/orchestrator/rules.ts` | Logs memory retrieval telemetry (clears `lastInjectedMemories` on `aborted`/`error`); checks semantic verifiers on `toolResults` and queues `enforcement-violation` `followUp` (`triggerTurn: true`); vector-searches memories for `edit`/`write` paths and queues `memory-reminder` `followUp` (`triggerTurn: false`). | Skipped for `PI_SUBAGENT_CHILD=1`; verifier/reminder only run when `toolResults` is non-empty (no race with `coms-p2p`'s zero-tool-call finalization). |
| `turn_end` | `extensions/orchestrator/status-line.ts` | Updates `lastActivityTime` and status-bar timestamp (`touchActivity`). | Guarded by `shutDown` / `ctx.hasUI`. |
| `turn_end` | `extensions/orchestrator/skill-maintenance.ts` | Reconciles project skill tree changes against turn snapshot, queues `skill-maintenance` `followUp` notice (`triggerTurn: false`) if changed, and clears per-turn tracking sets. | — |
| `turn_end` | `extensions/pidash/pidash.ts` (2 handlers) | `forward("turn_end")` projects (`projectTurnEndEvent`) and sends over WS; second handler syncs `thinkingLevel` (`update_info`). | Guarded by `shuttingDown`. |
| `turn_end` | `extensions/pitasks/index.ts` | Clears `agentBusy` and `turnTaskRefs`; attributes assistant turn token usage to task widget (`addTokenUsage` / `beginTurn`). | `agent_settled` also resets `agentBusy` if `turn_end` is skipped on abort/error. |
| `turn_end` | `extensions/reload-flag/index.ts` | Fallback trigger (`maybeTrigger()`) for `.pi/run/reload.flag` if FS watcher missed it. | Guarded by `isLiveExtensionCtx` and `isHandshakeParticipant(ctx.mode)`. |
| `session_shutdown` | `extensions/coms/coms-wrapper.ts` → `coms-p2p.ts` (`ComsPeerRuntime.stop()`) | Unsubscribes the single `pidash:request-commands` listener and calls `runtime.stop()`, which stops watchers/timers, broadcasts `"leaving"` presence, closes P2P socket/server and ping worker, unsubscribes malformed-recovery abort listener, removes `SIGINT`/`SIGTERM` handlers, and clears UI widget/status while preserving persisted reload state. | Reload cleans up old sockets and reactivates directly via `ComsPeerRuntime.start()` on `session_start` (`reason: "reload"`). |
| `session_shutdown` | `extensions/openai-compatible-discovery/index.ts` | `restoreSources()` aborts in-flight discovery requests, increments `lifecycleGeneration`, unregisters augmented providers. | — |
| `session_shutdown` | `extensions/orchestrator/index.ts` | Unregisters its session workload slot in `extensions/shared/session-bridge.ts` so torn-down runtimes do not serve coms drilldowns from dead getters. | — |
| `session_shutdown` | `extensions/orchestrator/async-agents.ts` | Nulls `asyncState.lastCtx`, stops poller interval and FS watcher, unsubscribes sync-run listener, calls `abortAllSyncAgentRuns()`. | — |
| `session_shutdown` | `extensions/orchestrator/cron.ts` | `cleanupRuntime()` clears timers/watchers and releases durable leader locks; unlinks session cron file on `reason` in `["new", "fork", "quit"]`. | Preserves session cron file on `reload`/`resume`. |
| `session_shutdown` | `extensions/orchestrator/dreaming.ts` | Stops auto-dream timer; spawns `runDreamAsync()` on `quit` (or unset `reason`). | Skipped when `shouldSkipOneshotShutdownDream(lastCtx?.mode)`, `dreamInFlight`, or `reason !== "quit"`. |
| `session_shutdown` | `extensions/orchestrator/enforcement.ts` | Clears session-scoped dangerous-command approvals (`Symbol.for("pi-config.dangerousSessionApprovals")`). | Preserved when `event.reason === "reload"`. |
| `session_shutdown` | `extensions/orchestrator/malformed-response-recovery.ts` | Sets `shuttingDown = true`, clears `markRecoveryPending(false)`, unregisters bridge coordinator, calls `notifyMalformedRecoveryAborted()` if recovery was pending. | Unblocks any deferred `coms-p2p` inbound. |
| `session_shutdown` | `extensions/orchestrator/review-ui.ts` | Nulls `lastCtx`, clears `reviewPoller` and `gitDirtyPoller` intervals. | — |
| `session_shutdown` | `extensions/orchestrator/session-search.ts` | Harvests compaction/branch summaries from session file (fallback: joined user messages) and indexes them. | — |
| `session_shutdown` | `extensions/orchestrator/status-line.ts` | Sets `shutDown = true`, bumps `branchUpdateSeq`, nulls `lastCtx`, clears debounce timer and `gitPoller`/`timePoller`. | — |
| `session_shutdown` | `extensions/orchestrator/trail.ts` | Increments `state.generation` (invalidating in-flight refresh continuations) and clears `trail` status slot. | — |
| `session_shutdown` | `extensions/pidash/pidash.ts` | Clears pending bridged UI requests, sends `session_shutdown` (`reason`, `targetSessionFile`) to daemon, sets `shuttingDown = true`, stops timers/heartbeat/reconnect, closes WS. | — |
| `session_shutdown` | `extensions/pidiff/pidiff.ts` | Sets `shuttingDown = true`, stops reconnect/heartbeat, closes WS. | Server auto-exits when last session disconnects. |
| `session_shutdown` | `extensions/pitasks/index.ts` | Sets `shuttingDown = true`, clears `turnTaskRefs`, GC/reminder intervals, toggle-all subscription; deactivates widget and closes store. | — |
| `session_shutdown` | `extensions/reload-flag/index.ts` | Stops flag watcher; atomically releases owned `reload.pending` lock; cancels pending `continuationTimer`. | Preserves `reload.pending` when `event.reason === "reload"`. |

### Load-Order Caveats & Bridge Coordination

Because `extensions/coms/` loads before `extensions/orchestrator/`, `coms-p2p.ts`'s
`agent_end` handler runs before `malformed-response-recovery.ts`. Without
coordination, `coms-p2p` would finalize an active `currentInbound` and reply to the
peer with an incomplete or failed turn before the orchestrator schedules its
recovery `followUp`.

Extensions avoid circular imports and load-order assumptions by coordinating through
`extensions/shared/session-bridge.ts`, which owns a single process-local
`globalThis[Symbol.for("pi-config.sessionBridge")]` `Map<sessionKey, SessionBridgeSlot>`
with typed per-session slots (`taskStore`, `workload`, `malformedRecovery`, `comsActive`)
and automatic empty-slot and outer-map pruning:

- `malformed-response-recovery.ts` registers a synchronous predicate with
  `registerRecoveryCoordinator()`, marks retries in flight via
  `markRecoveryPending()`, and emits `notifyMalformedRecoveryAborted()` if sending
  fails or the session shuts down.
- `coms-p2p.ts` checks `shouldDeferForMalformedRecovery()` before finalizing on
  `agent_end` and subscribes via `onMalformedRecoveryAborted()` so deferred inbounds
  finalize cleanly if recovery aborts.

Other lifecycle-spanning bridges using the same cross-extension isolation principles:
`extensions/shared/ui-bridge.ts` and `extensions/shared/widget-visibility.ts`.

Checklist when adding a new `agent_end`, `turn_end`, or `session_shutdown` subscriber:

1. **`turn_end` + `followUp` (`triggerTurn: true`) on zero-tool-call assistant turns:**
   Check whether `coms-p2p` already finalized `currentInbound` before your handler runs.
2. **`agent_end` + `followUp` (`triggerTurn: true`):** Expose a synchronous predicate
   and abort callback via `extensions/shared/` so earlier-loaded `coms-p2p` defers
   finalization until the follow-up finishes or aborts.
3. **`session_shutdown`:** Distinguish `event.reason === "reload"` from real exits
   when clearing `globalThis` grants, session files, or lockfiles; always clear timers
   and watchers, and guard async continuations with `isLiveExtensionCtx`
   (`extensions/shared/live-ctx.ts`).

## Related Pages

- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — the user-facing async and cron workflows this page implements.
- [Background Memory Consolidation (Dreaming)](background-dreaming.html) — the dream passes that rely on async LLM capability.
- [Inter-Agent Communication](inter-agent-communication.html) — peer-to-peer messaging between async agents.
- [Configuration & Settings](configuration.html) — the async-related settings keys.
