# Extension Commands

Extension commands (like `/pidash`, `/pidiff`, `/btw`, `/status`) are registered in
the extension source files under `extensions/`. Each command uses
`context.registerCommand()` with a name, description, and handler.

## Known Extension Commands

| Command                                 | Source                                            | Description                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/btw`                                  | `btw.ts`                                          | Quick side questions                                                                                                                                                                                                                                |
| `/pidash`                               | `pidash/pidash.ts`                                | Manage pidash daemon (start/stop/restart/status)                                                                                                                                                                                                    |
| `/pidiff`                               | `pidiff/pidiff.ts`                                | Manage pidiff per-project server (start/stop/restart/status)                                                                                                                                                                                        |
| `/status`                               | `status.ts`                                       | Unified session status snapshot                                                                                                                                                                                                                     |
| `/review-status [worktree-path]`        | `enforcement.ts`                                  | Show review loop state. Pass a worktree path to check a specific worktree                                                                                                                                                                           |
| `/async-status`                         | `async-agents.ts` + `async-status-ui.ts`          | Fullscreen overlay: list async agents → live output; `x` kills selected                                                                                                                                                                             |
| `/async-kill`                           | `async-agents.ts` + `async-status-ui.ts`          | Args kill directly; no args = overlay of running agents (`x` kill)                                                                                                                                                                                  |
| `/dream`                                | `dreaming.ts`                                     | Memory consolidation                                                                                                                                                                                                                                |
| `/dream-auto`                           | `dreaming.ts`                                     | Toggle automatic dreaming                                                                                                                                                                                                                           |
| `/cron`                                 | `cron.ts` + `cron-store.ts` + `cron-status-ui.ts` | Schedule temporary session tasks by default or persistent tasks with `--persist`. `/cron list [--persist]` opens the selected jobs, or both when omitted; `/cron list-all` explicitly shows both kinds; `/cron remove session\|persist:<uuid>` removes a task. Persistent tasks are project-local, with one local leader executing them. |
| `/pi-config-settings [project\|global]` | `settings-tui.ts` + `settings-tui-helpers.ts`     | Interactive settings editor: fullscreen overlay with scope toggle (Tab), fuzzy provider/model pickers, agent multi-select, auth token masking                                                                                                       |
| `/nvim-changed-files`                   | `nvim.ts`                                         | Send changed files to nvim quickfix                                                                                                                                                                                                                 |
| `/coms`                                 | `coms/coms-wrapper.ts`                            | P2P agent communication (start/stop/status)                                                                                                                                                                                                         |
| `/external-ai-models-refresh`           | `extended-autocomplete.ts`                        | Refresh AI CLI model cache                                                                                                                                                                                                                          |
| `/mcpc connect`                         | `mcpc.ts`                                         | Connect MCP servers from `~/.pi/pi-config/mcp.json` (`mcpc connect --stdio`). Run after editing that file.                                                                                                                                          |

## Cron scopes and delivery

`/cron` creates a temporary session task by default; `--persist` keeps a task across Pi sessions
in this project. There is no `--scope`, `--project`, or global persistence. Persistent tasks are
stored in `<project>/.pi/cron/crons.json`. Durable stores are versioned envelopes and retain the
task's project working directory. Task IDs are UUIDs and are labelled for removal as
`session:<uuid>` or `persist:<uuid>`.

`/cron list [--persist]` opens persistent tasks, or both kinds when omitted. `/cron list-all` is
the explicit all-jobs view and labels each task plus persistent leader/follower state; it does not
inspect another Pi process's private session-cron file. Persistent tasks use best-effort, local
at-least-once delivery: they run only while an eligible local pi process is open, and a crash or
stale-leader recovery can repeat a delivery. The project store elects one local leader to execute
persistent tasks; non-leaders retain their local session tasks and can list or remove persistent
tasks. Leadership uses a PID-reuse-safe process-creation token; if it cannot obtain one, durable
leadership fails closed. Add/remove mutations use a bounded transaction lock, so they remain safe
without process identity. Invalid stored task records are logged and skipped before timers are
created.

## Adding an Extension Command

1. Register via `context.registerCommand()` in the extension source file under `extensions/`
2. When adding slash command arguments: update autocomplete in `extensions/orchestrator/extended-autocomplete.ts`
   - Extension commands: update the entry in the `completions` map
   - Prompt templates: update the entry in `completions` AND ensure the command is in `promptTemplateCommands`; extension commands are wrapped automatically and must not be added there
   - If adding a new completable command, follow the existing patterns (static items, cached fetchers, etc.)
