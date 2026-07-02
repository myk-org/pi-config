# Async & Runtime Internals

## Async-Only Agents

Some agents are enforced to only run with `async: true` — sync calls are automatically
promoted to async by `subagent-tool.ts`. This prevents the LLM from blocking the session
waiting for long-running agents.

**Currently enforced:**

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

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

**Deterministic session IDs:** Async agents use `--session-id` (hash of agent name + task prefix) alongside `--no-session`.
This enables provider-side prompt caching for repeated async agent patterns.
`--no-session` creates an in-memory session (no disk persistence); `--session-id` assigns a stable ID for cache affinity.
Both flags are compatible: pi uses `SessionManager.inMemory(cwd, { id: sessionId })` when both are set.

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
