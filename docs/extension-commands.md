# Extension Commands

Extension commands (like `/pidash`, `/pidiff`, `/status`) are registered in the extension source files
under `extensions/`. Each command uses `context.registerCommand()` with a name, description, and handler.

For what each command does from the user side — arguments, flags, and examples — see
[Commands and Tools Reference](commands-and-tools.html). This page maps each command to its source and documents
the internals that are not visible from usage alone.

## Command Source Map

| Command | Source | Summary |
| --- | --- | --- |
| `/pidash` | `pidash/pidash.ts` | Manage pidash daemon (start/stop/restart/status) |
| `/pidiff` | `pidiff/pidiff.ts` | Manage pidiff per-project server (start/stop/restart/status) |
| `/status` | `status.ts` | Unified session status snapshot (includes 1-line `Worktrees:` summary when linked worktrees exist) |
| `/worktree` | `worktree.ts` + `worktree-helpers.ts` | Zero-arg fullscreen list→detail overlay for git worktrees (`Space` multi-select guarded `d`/`x` remove, `p` prune, `r` refresh, `Enter` detail with `c` copy path); plain-text table when headless |
| `/review-status [worktree-path]` | `enforcement.ts` | Show review loop state, optionally for a specific worktree |
| `/async` | `async-agents.ts` + `async-status-ui.ts` | Zero-arg fullscreen overlay: list async agents → live output; `x` kills the focused job (or the whole `Space` multi-selection), `X` kills all running/queued immediately (no confirmation) |
| `/adopt-skill` | `skill-maintenance.ts` | Zero-arg fullscreen overlay listing all adoptable skills (`maintained` vs `unmarked`) with `Space` multi-select + `a`/`Enter` batch adopt |
| `/cron` | `cron.ts` + `cron-store.ts` + `cron-status-ui.ts` | Zero-arg fullscreen overlay (`n` add, `e` edit, `x` delete, `p` pause/resume, `t` toggle persist/session, `f` scope filter `all`/`session`/`persist`, `Space` multi-select, `Enter` detail) |
| `/pi-config-settings` | `settings-tui.ts` + `settings-tui-helpers.ts` | Zero-arg interactive settings editor overlay (`Tab` switches Project/Global scope) |
| `/nvim-changed-files` | `nvim.ts` | Send changed files to nvim quickfix |
| `/coms` | `coms/coms-wrapper.ts` + `coms-peers-ui.ts` + `coms-p2p.ts` | Zero-arg fullscreen P2P peers overlay (`f` scope toggle, `q` local inbound queue with `Space` multi-select `x` kill, `Space` multi-select `m` message / `x` kill, `X` kill all, `Enter` drilldown) |
| `/repair` | `session-validation.ts` | Repair session — fix orphaned tool calls that break API requests |
| `/tasks` | `pitasks/index.ts` + `tasks-ui.ts` | Zero-arg fullscreen task list overlay (`Space` multi-select `s` start / `d` done / `x` delete, `n` add, `e` edit, `f` mine/all, `Enter` detail) |
| `/qa` | `qa-overlay.ts` | Zero-arg fullscreen human Q&A reader overlay (shortcut `qa_overlay_shortcut`, default `alt+q`): browse newest-first, `/` live filter, `Enter` scrollable reader, `r` quote whole answer, `1`–`9` quote Markdown heading/numbered item via `pasteToEditor()`, plus a 1-line dim buried-answer widget hint; plain-text fallback when headless |

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
- `/cron` (`f` scope toggle) labels each task plus persistent leader/follower state; it does not inspect another Pi process's private session-cron file.

## Widget Collapse/Expand & Shortcuts

The `tasks` (`aboveEditor`) and `coms-pool` (`belowEditor`) widgets support two display modes — `expanded` (full view with `[<key> collapse]` in the header) and `collapsed` (1-line header with live counts and `[<key> expand]`, pausing the 150ms task spinner timer so collapsed mode causes zero idle redraws). The 1-line header always remains visible whenever tasks exist or COMS is active, and active modes persist on `globalThis` across `/reload`:

- **Configurable keyboard shortcuts** (registered via `pi.registerShortcut()`, empty string disables):
  - `widget_tasks_shortcut` (default `alt+t`): collapse/expand the tasks widget.
  - `widget_coms_shortcut` (default `alt+c`): collapse/expand the coms widget.
  - `widget_all_shortcut` (default `alt+w`): collapse/expand both widgets via `pi.events` `"ui:toggle-all-widgets"` (collapses both if either is expanded; second press restores prior modes).
  - `qa_overlay_shortcut` (default `alt+q`): open the `/qa` human Q&A reader overlay (empty string disables; `/qa` command remains available).
- **Default mode:** `widgets_default_mode` (`"expanded" | "collapsed"`, default `"expanded"`).

Shared state and shortcut helpers live in `extensions/shared/widget-visibility.ts`.

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
