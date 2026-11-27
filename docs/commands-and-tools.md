# Commands and Tools Reference

Every user-facing slash command and every tool that pi-config registers, in one place. Each entry lists the exact name as it appears in source, what it does, its arguments, and an example invocation.

Commands and tools are different things: a **command** is something you type (`/cron`), while a **tool** is something the model calls. Both come from the extensions in `extensions/`, so anything missing here is missing from the product too.

## At a glance

| Kind | Count | Where they come from |
|---|---|---|
| Slash commands | 16 | `registerCommand(...)` across `extensions/` |
| Always-registered tools | 45 | `registerTool(...)` across `extensions/` |
| Code-map tools | 7 | `trail.ts`, on by default when the `trail` binary exists (`trail_enable`) |

Counts verified against source. Two names are registered in more than one place — see [Duplicate registrations](#duplicate-registrations).

## Slash commands

### /adopt-skill

Full-screen overlay listing all adoptable skills (showing `maintained` vs `unmarked` status) so you can mark one or more non-package skills as maintained (`skill-maintenance: auto`).

- **Arguments:** none
- **Keys in the overlay:** `↑↓`/`jk` navigate, `Space` multi-select, `a`/`Enter` adopt focused or selected skills, `Esc` close
- **No terminal / browser:** prints the plain-text list of adoptable skills and their status

```text
/adopt-skill
```

### /async

Full-screen overlay listing running, queued, and recently finished async/sync agents with live output, agent revive, and a unified cross-agent live activity log.

- **Arguments:** none
- **Tabs:** `1` Roster, `2` Activity (chronological lifecycle, tool, error, and response events across all jobs)
- **Roster keys:** `↑↓`/`jk` navigate, `Enter` view live output (preserves multi-selection on `Esc` back), `Space` multi-select, `r` revive a killed/completed/failed job using its persisted session or recovered output context (single or multi-select), `x` kill (focused row or selection — reports inline if no selected jobs are active), `X` kill all running/queued, `Esc` clears active selection first, then closes
- **Activity keys:** `↑↓`/`jk`/`PgUp`/`PgDn`/`Home`/`End` scroll (manual scroll pauses follow), `f` cycle filter (`All | Errors | Tools | Messages`), `/` inline search, `Space` toggle auto-follow, `Enter` jump to the agent's live output view, `1` return to Roster, `Esc` close
- **No terminal / browser:** prints the plain-text job summary and recent activity

```text
/async
```

### /coms

Full-screen P2P peers overlay with scope switching, stopped-peer revive, local inbound queue management, and a unified live COMS activity log. Activate coms programmatically via `coms_start` or at launch via `pi --coms`.

- **Arguments:** none
- **Tabs:** `1` Roster (live + recently stopped supervised peers), `2` Activity (chronological peer lifecycle, COMS message traffic, and errors)
- **Roster keys:** `↑↓`/`jk` navigate, `Space` multi-select, `r` revive a recently stopped supervised peer via the supervisor (resuming its saved session when available), `f` toggle scope (`this project` / `all projects`), `q` open local inbound queue (`Space` multi-select `x` kill), `m` message focused or selected live peers as the user (`origin: "user"`), `x` kill focused or selected supervised peers, `X` kill all supervised peers in scope, `Enter` drilldown into peer workload or stopped-peer metadata, `Esc` close
- **Activity keys:** `↑↓`/`jk`/`PgUp`/`PgDn`/`Home`/`End` scroll (manual scroll pauses follow), `f` cycle filter (`All | Errors | Tools | Messages`), `/` inline search, `Space` toggle auto-follow, `Enter` jump to the peer's drilldown/detail view, `1` return to Roster, `Esc` close
- **No terminal / browser:** prints the plain-text peer table for this project

```text
/coms
```

See [Inter-Agent Communication](inter-agent-communication.html) for the peer protocol and message semantics.

### /cron

Full-screen overlay for session and persistent project cron tasks.

- **Arguments:** none
- **Keys in the overlay:** `↑↓`/`jk` navigate, `Space` multi-select, `n` add cron, `e` edit focused cron, `p` pause/resume (single or multi-select), `t` toggle persist/session (single or multi-select — moves crons safely between session storage and `.pi/cron/crons.json`), `x` delete (single or multi-select), `f` toggle scope filter (`all` / `session` / `persist`), `Enter` detail, `Esc` close
- **No terminal / browser:** prints the plain-text list of scheduled tasks

```text
/cron
```

More detail: [Async Agents and Cron](async-agents-and-cron.html).


### /nvim-changed-files

Open the git-changed files in Neovim's quickfix list. Registered only when Pi is running inside Neovim.

- **Arguments:** none
- **Note:** on `main`/`master` it diffs against `HEAD`; on any other branch it diffs against `origin/main` (or `origin/master`) plus the working tree.

```
/nvim-changed-files
```

More detail: [Neovim Integration](neovim-integration.html).

### /pi-config-settings

Full-screen interactive settings editor with a scrollable left category sidebar, cross-category search, strict Project/Global scope isolation, per-key editing, and delete.

- **Arguments:** none — `Tab` toggles Project/Global scope inside the TUI (Global shows only Global/Default values; Project shows Project overrides plus inherited Global/Env/Default values)
- **Keys in the TUI:** in the items pane, `←` switches to the category sidebar, `↑↓` navigate settings, typing searches across all categories, `Enter` edits, and `Del` removes from the current scope; in the sidebar, `↑↓` or `j`/`k` navigate categories, `→`/`l`/`Enter` return to items, and `/` jumps to search. `Tab` switches Project/Global scope and `Esc` clears search or closes from either pane.

```text
/pi-config-settings
```

More detail: [Configuration & Settings](configuration.html).

### /pidash

Manage the web dashboard server.

- **Arguments:** `start | stop | restart | status` — no argument is equivalent to `status`
- **Note:** when the dashboard is disabled in settings, the command registers a stub that only notifies; it is a no-op elsewhere.

```
/pidash start
/pidash status
```

More detail: [Using the Web Dashboard](using-the-web-dashboard.html).

### /pidiff

Manage the diff-viewer server (the `8-diff` status widget).

- **Arguments:** `start | stop | restart | status`

```
/pidiff restart
```

### /redo

Re-apply working-tree file changes from the most recently undone turn snapshot (paired with `/undo`).

- **Arguments:** none
- **What it does:** restores the undone turn's post-mutation shadow git tree into the working tree using an ephemeral `GIT_INDEX_FILE` without touching `.git/index` or deleting gitignored files, then prints a summary of restored/removed files.
- **Note:** cleared automatically when a subsequent turn mutates files; disabled when `turn_snapshots` is `false`.

```text
/redo
```

### /repair

Repair the current session file by fixing orphaned tool calls — assistant `toolCall` entries on the active branch that never received a matching `toolResult`. Those orphans make the provider reject the next request with an API error.

- **Arguments:** none
- **What it does:**
  1. Reads the session file from `ctx.sessionManager.getSessionFile()`
  2. Walks the **active branch only** (leaf back to root via `parentId`), ignoring tool results that live on dead branches
  3. For each orphaned call, inserts a synthetic `toolResult` entry with the text `Error: session interrupted — tool call did not complete` and `isError: true`
  4. Re-parents the next entry on the branch to the last synthetic result, preserving the chain
  5. Rewrites the session file
- **Output:** a per-tool list of repaired calls, or `Session is clean — no orphaned tool calls found` when there is nothing to fix. Warns `No session file found` or `Session file is empty` when applicable.
- **Note:** edits the on-disk session file in place; run it as soon as you see a malformed-request error.

```
/repair
```

### /review-status

Show the current review-loop enforcement state: enforcement on/off, status, cycle number, findings, pending reviewers, whether the diff was edited during the cycle, and test status.

- **Arguments:** `[<worktree-path>]` — optional, checks a worktree instead of the main repo

```
/review-status
/review-status .worktrees/issue-42
```

More detail: [Automating Code Reviews](automating-code-reviews.html).

### /status

Unified session status in one notification: async agents, cron tasks, git branch and dirty state, container flag, and how many context files, skills, tools, and guidelines are loaded.

- **Arguments:** none

```
/status
```

### /tasks

Zero-arg fullscreen task manager overlay for the current session's task list.

- **Arguments:** none
- **List view:** the same fullscreen list → detail overlay as `/cron` and `/async`: `↑↓`/`j`/`k` navigate, `Space` multi-selects (preserved across `Enter` → detail → `Esc`), `Enter` opens a task,
  `n` adds a task from one line, `e` edits the focused task's subject, `s` starts the focused or selected tasks (`in_progress`), `d` marks the focused task (or all selected open tasks) done,
  `u` reopens the focused or selected completed/in-progress tasks back to `pending`, `f` toggles `mine`/`all`, `x` deletes the focused task (or the `Space`-selected tasks), `Esc` clears an active selection first and closes on the next press. Bulk outcomes and warnings display in an inline banner inside the overlay
- **`n` / `e`:** the list closes for the one-line input and re-opens on the freshly read store (`n` and `e` refuse while rows are selected). An empty board opens
  the create dialog directly, since there is no row to press `n` on. `n` asks who the task is for (`you` or `llm`) once the line is accepted. The edit dialog starts
  pre-filled with the current subject (Enter saves, Esc cancels). A blank or cancelled line writes nothing, and an unchanged subject is a no-op
- **`d`:** completes the focused task, or bulk-completes every selected open task when rows are ticked with `Space` (skipping already-completed tasks and reporting
  counts inline). When a multi-selection contains only `llm` open tasks, they complete immediately in place with no prompt. When it includes one or more open `you`
  tasks, it opens one shared optional one-line note dialog for the batch — an empty line completes without a note, `Esc` cancels without modifying tasks or losing
  the selection, and a non-empty note is saved as `completionNote` on the completed `you` tasks and included in one combined `task-completed-by-user` notice. On a
  single focused task assigned to `you` it opens the same optional note dialog first, recording `completionNote` and `completedBy`, and sends
  `Task #<id> "<subject>" marked done by you`, plus the note verbatim when there is one, so the agent learns the result on its next turn
- **`s`:** moves a focused pending task or all `Space`-selected pending tasks to `in_progress`, refusing open blockers or completed work
- **`u`:** reopens a focused completed or `in_progress` task (or all `Space`-selected non-pending tasks, both `you` and `llm`) back to `pending`, clearing stale `completedBy`, `completionNote`, and `completed_at`, skipping already-pending tasks, and reporting counts inline
- **Rows:** `✔` completed, `◼` in progress, `◻` pending, then `#<id> [<status>] [you|llm] <subject>`; a task with currently open blockers is marked `⛔ blocked`.
  Tasks assigned to `you` sort above `[llm]` tasks within their status group
- **Assignee:** a task is `llm` (the agent does it, the default for every existing task) or `user` (only the owner can — a merge, a live check in a real UI, an approval).
  User tasks never produce a reminder and are not counted as an agent's open work; `f` in the overlay filters to them
- **Detail / TaskGet:** detail shows subject, status, completed-by, outcome note, owner, blocked-by (currently open blockers), description, created and updated;
  completion attribution and the verbatim note are also readable via `TaskGet`. Reopening clears the old outcome in single and bulk updates. Manual completion always
  records the actor as `user`, regardless of assignee; legacy completed records read as completed by `llm`. Only user-assigned manual completions send a notice, queued as
  a follow-up after the agent finishes its run. Failed notice submission is logged without note text and is not retried automatically
- **Enforcement:** `TaskUpdate`, `TaskBulkUpdate` and automatic job lifecycle transitions cannot start or complete user-assigned tasks. Combining reassignment with status
  cannot bypass this guard. Reassignment alone, editing and deletion remain supported
- **Empty mine view:** `f` still returns to all tasks and `n` still creates a task. Cancelling either the subject or assignee prompt writes nothing
- **Pidash task-panel complete:** uses the same manual completion operation, records `completedBy: user`, and submits one follow-up notice only for a
  user-assigned task. Repeated completion is a no-op, including after a failed notice submission. The panel does not offer a completion note; use the terminal overlay to
  attach one.
- **No terminal, or a command sent from the pidash browser:** the same rows are printed as plain text instead of opening the overlay —
  a browser user cannot see or drive a terminal overlay, so text is the honest answer
- **Note:** when the task scope is `session` and the list becomes empty, the backing file is deleted.

```text
/tasks
```

### /undo

Revert working-tree file changes made during the most recent file-mutating turn.

- **Arguments:** none
- **What it does:** before the first `write`, `edit`, or `bash` tool call in a turn inside a git repository, pi-config captures a shadow git tree using an ephemeral `GIT_INDEX_FILE` (never touching `.git/index`, `HEAD`, branches, reflog, or `git stash`). On `agent_end`, if files actually changed, the turn is pushed onto a bounded per-session stack (20 turns). `/undo` restores the pre-turn working tree and removes files added during that turn while preserving staged changes and gitignored files (`.env`, `.pi/`, `node_modules`, `.venv`), and pushes the state onto the redo stack for `/redo`.
- **No-op:** outside git repos, in subagent children (`PI_SUBAGENT_CHILD=1`), or when `turn_snapshots` is `false`.

```text
/undo
```

### /worktree

Zero-arg fullscreen git worktrees overlay.

- **Arguments:** none
- **Keys in the overlay:** `↑↓`/`jk` navigate, `Space` multi-select, `d`/`x` guarded remove (single or multi-select with confirmation), `p` prune stale metadata, `r` refresh, `Enter` detail (`c` copy path, `d` remove, `p` prune, `r` refresh), `Esc` close
- **No terminal / browser:** prints the plain-text markdown table of worktrees

```text
/worktree
```

More detail: [Daemon and WebSockets](daemon-and-websockets.html) for how task state is persisted and shared.

## Tools

### Pi 1.6 Tool Exposure, Namespaces, and Annotations

The orchestrator auto-activates Pi's built-in `codemode` tool on `session_start` when registered and not excluded via `--no-tools`, `--exclude-tools`, or `defaultTools: ["-codemode"]`. Extension tools declare Pi 1.6 `exposure`, `namespace`, and MCP-style `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`):

| Exposure | Tools | How the model reaches them |
|---|---|---|
| `model-only` | `ask_user`, `subagent` | Declared top-level to the LLM; never callable from inside QuickJS `codemode` scripts |
| `codemode` | `memory` (7), `coms` (21), `tasks` (7), `trail` (7), `runtime` (7) | Called via `codemode` (`await tools.<name>(args)`, batchable with `Promise.allSettled`), grouped under named namespaces |
| `deferred` | `skill_adopt`, `memory_dream`, `memory_consolidate`, `review_status` | 0 top-level and 0 inline tokens; callable via `codemode` and discoverable via `searchTools()` / `describeNamespace()` |

### coms_* (21 tools, `coms` namespace)

All require active coms (`coms_start`); while inactive every one of them returns the same "coms not active" text. See [Inter-Agent Communication](inter-agent-communication.html) for the protocol, peer discovery, and queue semantics.

| Tool | Purpose | Key parameters |
|---|---|---|
| `coms_list` | List discoverable peer agents with model and live context-window usage; no network ping needed | `project` (name or `"*"` for all, defaults to caller's project), `include_explicit` (include `--explicit` agents, default false) |
| `coms_send` | Send a prompt to a peer; returns a `msg_id` on ack and the reply auto-delivers as a followUp | `target` (peer name or session_id), `prompt`, `conversation_id`, `response_schema` (JSON Schema), `tasks[]` (`subject`, `description`) to create on the peer. Rejected: `clearPrevious` |
| `coms_get` | Non-blocking poll of a pending `coms_send` reply: `pending`, `complete`, or `error` | `msg_id` (from `coms_send`) |
| `coms_queue_inspect` | Preview your queued inbound messages on a peer before any destructive recovery; shows ids, sender, age, FIFO position, delivery state — never message bodies | `target` |
| `coms_queue_clear` | Irreversibly clear exactly the messages in a given inspect preview; ownership enforced by the peer | `target`, `preview_id` (from `coms_queue_inspect`) |
| `coms_queue_delete` | Irreversibly delete one specific queued message of yours | `target`, `msg_id`, `preview_id` |
| `coms_queue_edit` | Replace the content of one of your pending queued messages | `target`, `msg_id`, `new_content` |
| `coms_queue_prioritize` | Move one of your pending messages to the front of the peer's queue | `target`, `msg_id` |
| `coms_local_queue` | Inspect or cancel messages in THIS session's own inbound coms queue (TUI: `/coms` → `q`) | `action` (`list`, `kill`), `msg_id` (required for `kill`) |
| `coms_tasks_create` | Create several tasks on a peer's task list, auto-add a "Report completion to sender" task blocked by all of them, and message the peer to start work | `target`, `tasks[]` (`subject`, `description`, at least one) |
| `coms_task_list` | List a peer's tasks without sending it a message | `target` |
| `coms_task_get` | Fetch one peer task with status, owner, description, and blocker state | `target`, `task_id` |
| `coms_task_update` | Update a peer task you created (`createdBy` must match) | `target`, `task_id`, `status` (`pending`/`in_progress`/`completed`/`deleted`), `subject`, `description`, `activeForm`, `owner`, `metadata` (merge; `null` deletes), `addBlocks[]`, `addBlockedBy[]` |
| `coms_task_delete` | Delete a peer task you created; refused while the task is `in_progress` | `target`, `task_id` |

`coms_send`'s description carries an explicit anti-loop warning: do not call it to reply to an inbound `[from <peer>]` message — the extension auto-captures your final assistant text as the reply.

### memory_* (9 tools)

Project memory, backed by topic files under `.pi/memory/topics/`. See [Memory Architecture](memory-architecture.html) for the layering and scoring, [Curating Project Memory](curating-project-memory.html) for hands-on curation, and [Safety Enforcements](safety-enforcements.html) for the enforcement fields.

| Tool | Purpose | Key parameters |
|---|---|---|
| `memory_search` | Keyword/vector search over project memories, with scores and categories | `query`, `category` (optional filter: `preference`, `lesson`, `pattern`, `decision`, `done`, `mistake`) |
| `memory_reflect` | Answer a question from long-term memory as a coherent summary instead of raw entries | `query` |
| `memory_topics` | List topic files with entry counts, hotness, and token estimates | none |
| `memory_add` | Add a new entry; keep it to one specific actionable line | `text`, `category`, `pinned` (never decays; only on explicit "remember this"), `trigger` + `action` + `verifier` (turn a memory into a code-enforced rule) |
| `memory_edit` | Update, invalidate (supersede), or annotate an entry in place — preserves scoring history, unlike remove+add | `op` (`update` or `invalidate`), `text`, `category`, `newText`, `supersededBy`, `sourceSession`, `derivedFrom`, `informs[]` |
| `memory_remove` | Delete an entry that is wrong, outdated, or superseded | `text`, `category` |
| `memory_reinforce` | Bump evidence and last-reinforced time on an existing entry, raising its stability score; may trigger promotion | `entryText` (exact text without category prefix), `category` |
| `memory_consolidate` | Produce a consolidation report: patterns, contradictions, merge candidates, and skills derived from recurring workflows | none |
| `memory_dream` | Inspect background memory dreaming status, trigger consolidation now, or toggle auto-dreaming for this session | `action` (`status`, `run`, `auto_on`, `auto_off`) |

### Task* (7 tools)

The session task list behind `/tasks` and the task widget. Statuses are `pending`, `in_progress`, `completed`, `deleted` (deleted is a status, not a hard delete, except
through `TaskBulkDelete`). Every task is assigned to `llm` (the agent, the default) or `user` (the owner), shown as `[llm]` / `[you]`. When live async subagents are bound to
an open (`pending` or `in_progress`) task via `subagent(..., async: true, taskId: "<id>")`, the task widget displays a `[⏳ ...]` badge on that task row and clears it once the
agent finishes.

| Tool | Purpose | Key parameters |
|---|---|---|
| `TaskCreate` | Create one task | `subject`, `description`, `activeForm` (spinner text), `assignee` (`llm` = the agent does it, the default; `user` = only the owner can, e.g. a merge or an approval), `agentType` (descriptive metadata only — it does not dispatch an agent), `metadata` |
| `TaskList` | List all tasks as `id`, `subject`, `status`, `owner`, `blockedBy` | none |
| `TaskGet` | Full task detail including `blocks` and `blockedBy` | `taskId` |
| `TaskUpdate` | Update a task; `in_progress` sets it as the widget's active task | `taskId`, `status`, `subject`, `description`, `activeForm`, `assignee`, `owner`, `metadata` (merge, `null` deletes), `addBlocks[]`, `addBlockedBy[]` |
| `TaskBulkCreate` | Create several tasks in one call | `tasks[]` (`subject`, `description`, `blockedBy[]`, `assignee`) |
| `TaskBulkUpdate` | Update several tasks in one call | `updates[]` (`taskId`, `status`, `subject`, `description`, `addBlockedBy[]`, `addBlocks[]`) |
| `TaskBulkDelete` | Hard-delete several tasks by id | `taskIds[]` |

File-backed task stores watch the configured parent directory and filter by the task filename, so repeated atomic file replacements remain visible, including after session
resume. Symlinked stores follow up to 8 symlink hops, watching each hop's parent directory (or the nearest existing ancestor directory until a missing target directory is
created) for link retargets, target writes, and replacements without creating external target directories. Saves still atomically replace the configured pathname, not the
symlink target; if the prior load failed with a JSON `SyntaxError`, `save()` best-effort preserves a one-time `<file>.corrupt` copy before overwriting. Local mutations notify
synchronously; filesystem events can also refresh the widget and broadcast the same snapshot again. These notifications are invalidations, not exactly-once mutation events.
Refresh callbacks do not write the store. Subagent children do not start watchers.

Watching depends on the platform's `fs.watch` support and event delivery. Replacing the watched parent directory, changes reported without a filename, and filesystems without
reliable notifications are not covered; there is no polling fallback or replay of changes made while the watcher is closed. Watcher errors close and clear the handles so a later
`reopen()` can try again. There is no automatic retry timer during an active session.

### Core tools (14 tools)

| Tool | Purpose | Key parameters |
|---|---|---|
| `async_status` | List running and recent async/sync subagent jobs (ID, name, agent, status, elapsed, current tool) or inspect one job's output tail | `id` (optional exact ID or unique prefix), `max_chars` (200–20000, default 4000) |
| `session_status` | Return the unified `/status` snapshot (async agents, crons, git branch/dirty state, worktrees, context %, loaded resources) | none |
| `worktree_status` | List git worktrees (branch, dirty counts, open PR, active COMS peers) or prune stale worktree metadata | `action` (`list`, `prune`) |
| `daemon_manage` | Check status or start/stop/restart local `pidash` and `pidiff` daemons (handles disabled daemons cleanly) | `name` (`pidash`, `pidiff`), `action` (`status`, `start`, `stop`, `restart`) |
| `settings_get` | Inspect effective and per-scope (`env`/`project`/`global`/`default`) pi-config settings (`codemode`, `runtime` namespace, read-only) | `key` (optional), `category` (optional), `only_overrides` (optional bool) |
| `settings_set` | Approval-gated `set`/`reset` of a validated setting in `global` or `project` scope (`model-only`, never in `codemode`, fails closed when headless) | `action` (`set`, `reset`), `key`, `scope` (`global`, `project`), `value` (required for `set`) |
| `skill_adopt` | List unmarked adoptable skills or adopt a named skill with `skill-maintenance: auto` | `action` (`list`, `adopt`), `name` (required for `adopt`) |
| `cron_manage` | Manage scheduled tasks (`add`, `list`, `edit`, `pause`, `resume`, `remove`); `persist=true` keeps a task across Pi sessions in the project | `action` (`add`, `list`, `edit`, `pause`, `resume`, `remove`), `persist`, `description`, `task`, `model` (`""` on `edit` clears pinned model), `interval_seconds` (min 10), `at_hour` (0–23), `at_minute` (0–59, requires `at_hour` unless editing a daily cron), `id` |
| `subagent` | Delegate to a subagent with isolated context; modes are single (`agent`+`task`), parallel (`tasks[]`), and chain (`chain[]` with a `{previous}` placeholder). A chain also runs async with `async: true`: each step needs its own `taskId` and `cwd`, each step gets the previous step's output as `{previous}`, and a failed step stops the chain | `agent`, `task`, `tasks[]`, `chain[]`, `agentScope`, `confirmProjectAgents`, `cwd`, `estimatedSeconds` (required for sync; `>= 30` forces async), `async`, `fireAndForget`, `name`, `taskId` (`-1` if unlinked), `asyncKill`, `persistSession`, `model` (`provider/model-id`) |
| `session_search` | Search past conversation summaries by keyword — zero LLM cost | `query`, `limit` (default 10) |
| `review_status` | Read the review-loop enforcement state before committing | `worktree_path` (optional) |
| `ask_user` | Ask the user a question with selectable options; returns the choice or free text. Its prompt guidelines require it instead of plain-text questions | `question`, `options[]` (optional) |
| `list_models` | List available provider/model pairs for `subagent(model=...)` | `provider` (optional filter) |

More detail: [Managing Custom Agents](managing-custom-agents.html) for `subagent`, [Automating Code Reviews](automating-code-reviews.html) for `review_status`, and [Image Generation](image-generation.html) for generating images via Pi 1.6 native `codemode` `models.generateImages()`.

### trail_* (7 tools, on by default)

Registered by `extensions/orchestrator/trail.ts` when `trail_enable` is on, which is the default, and only in a trusted session. They are absent when the `trail` binary is not on `PATH` — that binary is the real gate. `trail_refresh` and `trail_blast_radius` are additionally omitted in subagent children; children get the five read-only query tools.

| Tool | Purpose | Key parameters |
|---|---|---|
| `trail_find_code` | Find compact ranked code references in the local Trail map | `query`, `limit` (1–20), `path` (project-relative) |
| `trail_find_all` | Search indexed project files | `pattern`, `path`, `fixed` (literal, not regex) |
| `trail_file_api` | Signatures-only API view of a file | `path` |
| `trail_trace_calls` | Trace callers or callees of a symbol | `symbol`, `direction` (`in`/`out`), `depth` (1–10) |
| `trail_repo_map` | Compact map-based repository overview | `max_dirs` (1–30) |
| `trail_refresh` | Rebuild the local Trail map | none |
| `trail_blast_radius` | Dependencies affected by the local diff | `depth` (1–10) |

**Map-first gate.** On a substantive prompt the first project navigation of the turn is the map, not raw search: `read` of an indexed file and `grep`/`find`/`rg` are blocked until a `trail_*` call runs (or the agent reads a file:line pointer the retrieval injected). Unindexed paths — docs, lockfiles, `.pi/**` — are never blocked, and the gate fails open when there is no map. In linked git worktrees, maps live under `graft/` or `.trail/cache/` from the worktree root and never write into the main checkout's map.

**`trail_repo_map` is capped.** The overview is a one-per-session orientation aid. A second call in the same session returns a redirect to `trail_find_code` instead of re-running the CLI, because repeated overviews replaced actual lookup in practice.

## Duplicate registrations

Two names are registered twice in source. Both branches are mutually exclusive stubs, so there is no user-visible conflict — but it is worth knowing if you grep the code.

| Name | Registrations | Which one you get |
|---|---|---|
| `/pidash` | `pidash.ts` twice | Two mutually exclusive branches: one registered when the dashboard is disabled (notify-only stub), one when it is enabled. Exactly one is live. |
| `/pidiff` | `pidiff.ts` twice | Same pattern as `/pidash`: disabled-branch stub, or the full server management command. |

## Verifying this page

The lists here were produced from source, not from documentation:

```bash
# Slash commands
grep -rn 'registerCommand("' extensions/ --include=*.ts

# Tools — note trail.ts registers its tools through a tool() helper loop
grep -rn 'registerTool' extensions/ --include=*.ts
```

When you add a command or a tool, add it to this page in the same change.
