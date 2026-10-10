# Extension Commands

Extension commands (like `/pidash`, `/pidiff`, `/btw`, `/status`) are registered in the extension source files
under `extensions/`. Each command uses `context.registerCommand()` with a name, description, and handler.

For what each command does from the user side — arguments, flags, and examples — see
[Commands and Tools Reference](commands-and-tools.html). This page maps each command to its source and documents
the internals that are not visible from usage alone.

## Command Source Map

| Command | Source | Summary |
| --- | --- | --- |
| `/btw` | `btw.ts` | Quick side questions |
| `/pidash` | `pidash/pidash.ts` | Manage pidash daemon (start/stop/restart/status) |
| `/pidiff` | `pidiff/pidiff.ts` | Manage pidiff per-project server (start/stop/restart/status) |
| `/status` | `status.ts` | Unified session status snapshot |
| `/review-status [worktree-path]` | `enforcement.ts` | Show review loop state, optionally for a specific worktree |
| `/async-status` | `async-agents.ts` + `async-status-ui.ts` | Fullscreen overlay: list async agents → live output; `x` kills the focused job (or the whole `Space` multi-selection), `X` kills all running/queued immediately (no confirmation) |
| `/dream` | `dreaming.ts` | Memory consolidation |
| `/dream-auto` | `dreaming.ts` | Toggle automatic dreaming |
| `/cron` | `cron.ts` + `cron-store.ts` + `cron-status-ui.ts` | Schedule session tasks, or persistent tasks with `--persist` |
| `/pi-config-settings [project\|global]` | `settings-tui.ts` + `settings-tui-helpers.ts` | Interactive settings editor overlay |
| `/nvim-changed-files` | `nvim.ts` | Send changed files to nvim quickfix |
| `/coms` | `coms/coms-wrapper.ts` | P2P agent communication (start/stop/status) |
| `/external-ai-models-refresh` | `extended-autocomplete.ts` | Refresh AI CLI model cache |

## Cron Delivery Internals

The two cron scopes (session vs `--persist` project tasks) and the leader lease that guarantees single execution
are documented in [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html). The delivery
guarantees underneath:

- Persistent tasks are stored in `<project>/.pi/cron/crons.json` as versioned envelopes that retain the task's
  project working directory. Task IDs are UUIDs, labelled for removal as `session:<uuid>` or `persist:<uuid>`.
- Delivery is best-effort, local, at-least-once: persistent tasks run only while an eligible local pi process is open, and a crash or stale-leader recovery can repeat a delivery.
- The project store elects one local leader to execute persistent tasks; non-leaders retain their local session tasks and can list or remove persistent tasks.
- Leadership uses a PID-reuse-safe process-creation token; if a process cannot obtain one, durable leadership fails closed.
- Add/remove mutations use a bounded transaction lock, so they remain safe without process identity.
- Invalid stored task records are logged and skipped before timers are created.
- `/cron list-all` labels each task plus persistent leader/follower state; it does not inspect another Pi process's private session-cron file.

## Adding an Extension Command

The `registerCommand()` pattern and the autocomplete wiring are documented with full code examples in
[Creating Slash Commands](custom-slash-commands.html). The contributor checklist:

1. Register via `context.registerCommand()` in the extension source file under `extensions/`
2. When adding slash command arguments, update autocomplete in `extensions/orchestrator/extended-autocomplete.ts`:
   - Extension commands: update the entry in the `completions` map
   - Prompt templates: update the entry in `completions` **and** ensure the command is in `promptTemplateCommands`;
     extension commands are wrapped automatically and must not be added there
   - If adding a new completable command, follow the existing patterns (static items, cached fetchers, etc.)

## Related Pages

- [Commands and Tools Reference](commands-and-tools.html) — full usage documentation for every command and tool.
- [Creating Slash Commands](custom-slash-commands.html) — how to add new commands, with code examples.
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — async workflows and cron scopes.
- [Project Settings Internals](project-settings.html) — the settings TUI behind `/pi-config-settings`.
