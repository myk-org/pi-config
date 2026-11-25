# Commands and Tools Reference

Every user-facing slash command and every tool that pi-config registers, in one place. Each entry lists the exact name as it appears in source, what it does, its arguments, and an example invocation.

Commands and tools are different things: a **command** is something you type (`/cron`), while a **tool** is something the model calls. Both come from the extensions in `extensions/`, so anything missing here is missing from the product too.

## At a glance

| Kind | Count | Where they come from |
|---|---|---|
| Slash commands | 17 | `registerCommand(...)` across `extensions/` |
| Always-registered tools | 45 | `registerTool(...)` across `extensions/` |
| Code-map tools | 7 | `trail.ts`, on by default when the `trail` binary exists (`trail_enable`) |

Counts verified against source. Two names are registered in more than one place — see [Duplicate registrations](#duplicate-registrations).

## Slash commands

### /async-status

Full-screen overlay listing running and queued async agents, with live output per agent.

- **Arguments:** none
- **Keys in the overlay:** `↑↓`/`jk` navigate, `Enter` view output, `Space` multi-select, `x` kill (focused row, or the whole selection), `X` kill all running/queued, `Esc` close

```
/async-status
```

### /coms

Start, stop, or inspect P2P inter-agent communication. Coms is off by default and is activated explicitly with `/coms start`; all `coms_*` tools return "coms not active" until then.

- **Arguments:** `start | stop | status | tell [--project <p>] <peer> <message> | list [--all] | kill <peer|all>` (no argument shows the status)

```
/coms start
/coms status
/coms tell impl-42 rerun the failing suite — I already approved it
/coms stop
```

`/coms tell` sends the message as YOU: the envelope carries `origin: "user"`, so the peer can tell a human decided from another model guessing. Agent tools cannot set that (`coms_send` always sends `origin: "peer"`), and a failed delivery is reported rather than dropped. Argument completion lives with the command in `extensions/coms/coms-wrapper.ts` (peer names come from the live registry, so a dead peer never completes) — `tell` completes exactly like `kill`, including `--project`.

See [Inter-Agent Communication](inter-agent-communication.html) for the peer protocol and message semantics.

### /coms-queue

Overlay of your queued inbound messages on a peer. Selecting a message shows the full prompt.

- **Arguments:** none
- **Keys in the overlay:** `↑↓`/`jk` select, `Enter` view, `x` kill, `Esc` close
- **Requires active coms** — otherwise it notifies `📡 coms not active — no queue. Run /coms start first.`

```
/coms-queue
```

### /cron

Schedule, list, and remove cron tasks. Non-empty scheduling requests are forwarded to the model as a `cron_manage` request, so you describe the schedule in natural language.
`add <request>` is also forwarded, not scheduled directly. Bare `/cron`, whitespace-only input, `--persist` alone, and `add` without a request show
`/cron requires a message for the LLM to work on.` without calling the model or changing schedules.

- **Arguments:** `list | list-all | remove <id>` (also `rm` / `delete`), plus the `--persist` flag
- **Flags:** `--persist` scope the task to the project (`.pi/cron/crons.json`) instead of the session. `--scope` and `--project` are rejected with an error pointing at `--persist`.
- **Listing:** `list` opens a cron status overlay; `list-all` shows every scope instead of just project-scoped tasks. In the overlay `Space` multi-selects rows,
  `p` pauses/resumes the focused cron (or selected group), and `x` removes the focused or selected crons

```
/cron list
/cron list-all
/cron --persist every weekday at 09:00, summarize yesterday's PR comments
/cron remove 3f2a1c
```

More detail: [Async Agents and Cron](async-agents-and-cron.html).

### /dream

Run memory consolidation (dreaming) now, in the background, non-blocking. If a dream is already running you get a warning instead of a second run.

- **Arguments:** none

```
/dream
```

More detail: [Background Memory Consolidation (Dreaming)](background-dreaming.html).

### /dream-auto

Toggle automatic memory dreaming, which otherwise runs every 3 hours and at session end.

- **Arguments:** `on | off` (no argument reports the current state)

```
/dream-auto on
/dream-auto off
```

### /external-ai-models-refresh

Clear the cached model lists and re-fetch models for the AI CLI providers (cursor, claude, gemini).

- **Arguments:** none

```
/external-ai-models-refresh
```

### /nvim-changed-files

Open the git-changed files in Neovim's quickfix list. Registered only when Pi is running inside Neovim.

- **Arguments:** none
- **Note:** on `main`/`master` it diffs against `HEAD`; on any other branch it diffs against `origin/main` (or `origin/master`) plus the working tree.

```
/nvim-changed-files
```

More detail: [Neovim Integration](neovim-integration.html).

### /pi-config-settings

Full-screen interactive settings editor: category tabs, per-key editing, project/global scope, and delete.

- **Arguments:** `[project | global]` — optional, selects the initial scope; `Tab` also toggles scope inside the TUI
- **Keys in the TUI:** `←→` category, `Tab` scope, `↑↓` navigate, `Enter` edit, `Del` remove, `Esc` close

```
/pi-config-settings
/pi-config-settings global
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

Task manager for the current session's task list.

- **Arguments:** optional subcommand — none (list), `mine` (list), `create`, `start <id>`, `done <id>`, `clear completed`, `clear all`
- **List view:** the same fullscreen list → detail overlay as `/cron list` and `/async-status`: `↑↓`/`j`/`k` navigate, `Space` multi-selects, `Enter` opens a task,
  `n` adds a task from one line, `e` edits the focused task's subject, `d` marks the focused task done, `f` toggles `mine`/`all`,
  `x` deletes the focused task (or the `Space`-selected tasks), `Esc` closes
- **`n` / `e`:** the list closes for the one-line input and re-opens on the freshly read store (`n`, `e`, and `d` refuse while rows are selected). An empty board opens
  the create dialog directly, since there is no row to press `n` on. `n` asks who the task is for (`you` or `llm`) once the line is accepted. The edit dialog starts
  pre-filled with the current subject (Enter saves, Esc cancels). A blank or cancelled line writes nothing, and an unchanged subject is a no-op
- **`d`:** completes the focused task. On a task assigned to `you` it opens an optional one-line note dialog first — an empty line completes without a note, `Esc` cancels
  and changes nothing. The outcome is kept on the record (`completionNote`, `completedBy`), and the session receives one message reading
  `Task #<id> "<subject>" marked done by you`, plus the note verbatim when there is one, so the agent learns the result on its next turn
- **Rows:** `✔` completed, `◼` in progress, `◻` pending, then `#<id> [<status>] [you|llm] <subject>`; a task with currently open blockers is marked `⛔ blocked`.
  Tasks assigned to `you` sort above `[llm]` tasks within their status group
- **Assignee:** a task is `llm` (the agent does it, the default for every existing task) or `user` (only the owner can — a merge, a live check in a real UI, an approval).
  User tasks never produce a reminder and are not counted as an agent's open work; `/tasks mine` (and `f` in the overlay) shows only them
- **Detail / TaskGet:** detail shows subject, status, completed-by, outcome note, owner, blocked-by (currently open blockers), description, created and updated;
  completion attribution and the verbatim note are also readable via `TaskGet`. Reopening clears the old outcome in single and bulk updates. Manual completion always
  records the actor as `user`, regardless of assignee; legacy completed records read as completed by `llm`. Only user-assigned manual completions send a notice, queued as
  a follow-up after the agent finishes its run. Failed notice submission is logged without note text and is not retried automatically
- **`create`:** prompts for subject and description (bridged, so pidash can answer it too). Headless sessions receive guidance to use `TaskCreate` or an interactive UI.
- **`start <id>` / `done <id>`:** move a task to `in_progress` / `completed`; an unknown id is reported, `done` on a completed task is a no-op, and `start` refuses open
  blockers or reopening completed work. `done` records manual attribution and sends the same owner-task notice as the overlay, without a note. To attach a note, use `d`
  on a user task in the terminal overlay
- **Enforcement:** `TaskUpdate`, `TaskBulkUpdate` and automatic job lifecycle transitions cannot start or complete user-assigned tasks. Combining reassignment with status
  cannot bypass this guard. Reassignment alone, editing and deletion remain supported
- **Empty mine view:** `f` still returns to all tasks and `n` still creates a task. Cancelling either the subject or assignee prompt writes nothing
- **Existing `clear completed` / `clear all` subcommands:** delete matching tasks and report the count. Status-based bulk clearing is a subcommand, not an overlay key;
  the overlay deletes the focused task or `Space`-selected tasks with `x`.
- **Pidash task-panel complete:** uses the same manual completion operation as `/tasks done`, records `completedBy: user`, and submits one follow-up notice only for a
  user-assigned task. Repeated completion is a no-op, including after a failed notice submission. The panel does not offer a completion note; use the terminal overlay to
  attach one.
- **No terminal, or a command sent from the pidash browser:** the same rows are printed as plain text (followed by the subcommand hint) instead of opening the overlay —
  a browser user cannot see or drive a terminal overlay, so text is the honest answer
- **Note:** when the task scope is `session` and the list becomes empty, the backing file is deleted.

```
/tasks
/tasks mine
/tasks create
/tasks start 3
/tasks done 3
/tasks clear completed
/tasks clear all
```

More detail: [Daemon and WebSockets](daemon-and-websockets.html) for how task state is persisted and shared.

## Tools

### coms_* (15 tools)

All require active coms (`/coms start`); while inactive every one of them returns the same "coms not active" text. See [Inter-Agent Communication](inter-agent-communication.html) for the protocol, peer discovery, and queue semantics.

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
| `coms_local_queue` | Inspect or cancel messages in THIS session's own inbound coms queue (equivalent to `/coms-queue`) | `action` (`list`, `kill`), `msg_id` (required for `kill`) |
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
| `memory_dream` | Inspect background memory dreaming status, trigger consolidation now, or toggle auto-dreaming (equivalent to `/dream` and `/dream-auto`) | `action` (`status`, `run`, `auto_on`, `auto_off`) |

### Task* (7 tools)

The session task list behind `/tasks` and the task widget. Statuses are `pending`, `in_progress`, `completed`, `deleted` (deleted is a status, not a hard delete, except
through `TaskBulkDelete`). Every task is assigned to `llm` (the agent, the default) or `user` (the owner), shown as `[llm]` / `[you]`.

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

### Core tools (12 tools)

| Tool | Purpose | Key parameters |
|---|---|---|
| `async_status` | List running and recent async/sync subagent jobs (ID, name, agent, status, elapsed, current tool) or inspect one job's output tail | `id` (optional exact ID or unique prefix), `max_chars` (200–20000, default 4000) |
| `session_status` | Return the unified `/status` snapshot (async agents, crons, git branch/dirty state, worktrees, context %, loaded resources) | none |
| `worktree_status` | List git worktrees (branch, dirty counts, open PR, active COMS peers) or prune stale worktree metadata | `action` (`list`, `prune`) |
| `daemon_manage` | Check status or start/stop/restart local `pidash` and `pidiff` daemons (handles disabled daemons cleanly) | `name` (`pidash`, `pidiff`), `action` (`status`, `start`, `stop`, `restart`) |
| `skill_adopt` | List unmarked adoptable skills or adopt a named skill with `skill-maintenance: auto` | `action` (`list`, `adopt`), `name` (required for `adopt`) |
| `cron_manage` | Manage scheduled tasks (`add`, `list`, `edit`, `pause`, `resume`, `remove`); `persist=true` keeps a task across Pi sessions in the project | `action` (`add`, `list`, `edit`, `pause`, `resume`, `remove`), `persist`, `description`, `task`, `model` (`""` on `edit` clears pinned model), `interval_seconds` (min 10), `at_hour` (0–23), `at_minute` (0–59, requires `at_hour` unless editing a daily cron), `id` |
| `subagent` | Delegate to a subagent with isolated context; modes are single (`agent`+`task`), parallel (`tasks[]`), and chain (`chain[]` with a `{previous}` placeholder). A chain also runs async with `async: true`: each step needs its own `taskId` and `cwd`, each step gets the previous step's output as `{previous}`, and a failed step stops the chain | `agent`, `task`, `tasks[]`, `chain[]`, `agentScope`, `confirmProjectAgents`, `cwd`, `estimatedSeconds` (required for sync; `>= 30` forces async), `async`, `fireAndForget`, `name`, `taskId` (`-1` if unlinked), `asyncKill`, `persistSession`, `model` (`provider/model-id`) |
| `session_search` | Search past conversation summaries by keyword — zero LLM cost | `query`, `limit` (default 10) |
| `review_status` | Read the review-loop enforcement state before committing | `worktree_path` (optional) |
| `ask_user` | Ask the user a question with selectable options; returns the choice or free text. Its prompt guidelines require it instead of plain-text questions | `question`, `options[]` (optional) |
| `list_models` | List available provider/model pairs for `subagent(model=...)` | `provider` (optional filter) |
| `generate_image` | Generate an image from a structured description via Gemini; returns the file path. Needs `image_model` in `pi-config-settings.json` (or `PI_IMAGE_MODEL`) plus `GEMINI_API_KEY`/`GOOGLE_API_KEY` | `subject` (required), `action`, `scene`, `composition`, `lighting`, `style`, `text`, `aspect_ratio` (`1:1`, `3:4`, `4:3`, `9:16`, `16:9`) |

More detail: [Managing Custom Agents](managing-custom-agents.html) for `subagent`, [Automating Code Reviews](automating-code-reviews.html) for `review_status`, [Image Generation](image-generation.html) for `generate_image`.

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
