# Commands and Tools Reference

Every user-facing slash command and every tool that pi-config registers, in one place. Each entry lists the exact name as it appears in source, what it does, its arguments, and an example invocation.

Commands and tools are different things: a **command** is something you type (`/cron`), while a **tool** is something the model calls. Both come from the extensions in `extensions/`, so anything missing here is missing from the product too.

## At a glance

| Kind | Count | Where they come from |
|---|---|---|
| Slash commands | 17 | `registerCommand(...)` across `extensions/` |
| Always-registered tools | 38 | `registerTool(...)` across `extensions/` |
| Opt-in tools | 7 | `graft.ts`, only when `graft_enable` is on (default: off) |

Counts verified against source. Two names are registered in more than one place — see [Duplicate registrations](#duplicate-registrations).

## Slash commands

### /async-status

Full-screen overlay listing running and queued async agents, with live output per agent.

- **Arguments:** none
- **Keys in the overlay:** `↑↓`/`jk` select, `Enter` view output, `x` kill, `Esc` close

```
/async-status
```

### /async-kill

Kill async agent(s) by name, by id prefix, or all at once. With no argument it opens the same overlay as `/async-status` in kill mode.

- **Arguments:** `[<name> | <id-prefix> | all]` — optional

```
/async-kill all
/async-kill code-review
```

### /btw

Ask a quick side question that is answered from the current conversation without adding the answer to the main chat history. Requires a selected model (`/model`) and a TUI session.

- **Arguments:** `<question>` — required; missing argument prints `Usage: /btw <question>`

```
/btw what name did we give that retry helper?
```

More detail: [Asking Side Questions with /btw](btw-command.html).

### /coms

Start, stop, or inspect P2P inter-agent communication. Coms is off by default and is activated explicitly with `/coms start`; all `coms_*` tools return "coms not active" until then.

- **Arguments:** `start | stop | status` (no argument is treated as an error with a usage hint)

```
/coms start
/coms status
/coms stop
```

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

Schedule, list, and remove cron tasks. `add` is not handled directly: anything that is not a listing or removal verb is forwarded to the model as a `cron_manage` request, so you describe the schedule in natural language.

- **Arguments:** `list | list-all | remove <id>` (also `rm` / `delete`), plus the `--persist` flag
- **Flags:** `--persist` scope the task to the project (`.pi/cron/crons.json`) instead of the session. `--scope` and `--project` are rejected with an error pointing at `--persist`.
- **Listing:** `list` opens a cron status overlay; `list-all` shows every scope instead of just project-scoped tasks

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

Interactive task manager for the current session's task list.

- **Arguments:** none — the command opens a menu
- **Menu:** `View all tasks (N)`, `Create task`, `Clear completed (N)` (only when completed tasks exist), `Clear all (N)` (only when tasks exist)
- **Task list view:** `✔` completed, `◼` in progress, `◻` pending; select a task to open its detail actions: `▸ Start (in_progress)`, `✓ Complete`, `✗ Delete`
- **Note:** when the task scope is `session` and the list becomes empty, the backing file is deleted.

```
/tasks
```

More detail: [Daemon and WebSockets](daemon-and-websockets.html) for how task state is persisted and shared.

## Tools

### coms_* (14 tools)

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
| `coms_tasks_create` | Create several tasks on a peer's task list, auto-add a "Report completion to sender" task blocked by all of them, and message the peer to start work | `target`, `tasks[]` (`subject`, `description`, at least one) |
| `coms_task_list` | List a peer's tasks without sending it a message | `target` |
| `coms_task_get` | Fetch one peer task with status, owner, description, and blocker state | `target`, `task_id` |
| `coms_task_update` | Update a peer task you created (`createdBy` must match) | `target`, `task_id`, `status` (`pending`/`in_progress`/`completed`/`deleted`), `subject`, `description`, `activeForm`, `owner`, `metadata` (merge; `null` deletes), `addBlocks[]`, `addBlockedBy[]` |
| `coms_task_delete` | Delete a peer task you created; refused while the task is `in_progress` | `target`, `task_id` |

`coms_send`'s description carries an explicit anti-loop warning: do not call it to reply to an inbound `[from <peer>]` message — the extension auto-captures your final assistant text as the reply.

### memory_* (8 tools)

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

### Task* (7 tools)

The session task list behind `/tasks` and the task widget. Statuses are `pending`, `in_progress`, `completed`, `deleted` (deleted is a status, not a hard delete, except through `TaskBulkDelete`).

| Tool | Purpose | Key parameters |
|---|---|---|
| `TaskCreate` | Create one task | `subject`, `description`, `activeForm` (spinner text), `agentType` (descriptive metadata only — it does not dispatch an agent), `metadata` |
| `TaskList` | List all tasks as `id`, `subject`, `status`, `owner`, `blockedBy` | none |
| `TaskGet` | Full task detail including `blocks` and `blockedBy` | `taskId` |
| `TaskUpdate` | Update a task; `in_progress` sets it as the widget's active task | `taskId`, `status`, `subject`, `description`, `activeForm`, `owner`, `metadata` (merge, `null` deletes), `addBlocks[]`, `addBlockedBy[]` |
| `TaskBulkCreate` | Create several tasks in one call | `tasks[]` (`subject`, `description`, `blockedBy[]`) |
| `TaskBulkUpdate` | Update several tasks in one call | `updates[]` (`taskId`, `status`, `subject`, `description`, `addBlockedBy[]`, `addBlocks[]`) |
| `TaskBulkDelete` | Hard-delete several tasks by id | `taskIds[]` |

### Core tools (9 tools)

| Tool | Purpose | Key parameters |
|---|---|---|
| `cron_manage` | Manage scheduled tasks; `persist=true` keeps a task across Pi sessions in the project | `action` (`add`, `list`, `remove`), `persist`, `description`, `task`, `interval_seconds` (min 10), `at_hour` (0–23), `at_minute` (0–59, requires `at_hour`), `id` |
| `subagent` | Delegate to a subagent with isolated context; modes are single (`agent`+`task`), parallel (`tasks[]`), and chain (`chain[]` with a `{previous}` placeholder) | `agent`, `task`, `tasks[]`, `chain[]`, `agentScope`, `confirmProjectAgents`, `cwd`, `estimatedSeconds` (required for sync; `>= 30` forces async), `async`, `fireAndForget`, `name`, `taskId` (`-1` if unlinked), `asyncKill`, `persistSession`, `model` (`provider/model-id`) |
| `session_search` | Search past conversation summaries by keyword — zero LLM cost | `query`, `limit` (default 10) |
| `review_status` | Read the review-loop enforcement state before committing | `worktree_path` (optional) |
| `ask_user` | Ask the user a question with selectable options; returns the choice or free text. Its prompt guidelines require it instead of plain-text questions | `question`, `options[]` (optional) |
| `list_models` | List available provider/model pairs for `subagent(model=...)`; filters out `acpx-*` providers, which cannot run in subagent children | `provider` (optional filter) |
| `generate_image` | Generate an image from a structured description via Gemini; returns the file path. Needs `image_model` in `pi-config-settings.json` (or `PI_IMAGE_MODEL`) plus `GEMINI_API_KEY`/`GOOGLE_API_KEY` | `subject` (required), `action`, `scene`, `composition`, `lighting`, `style`, `text`, `aspect_ratio` (`1:1`, `3:4`, `4:3`, `9:16`, `16:9`) |

More detail: [Managing Custom Agents](managing-custom-agents.html) for `subagent`, [Automating Code Reviews](automating-code-reviews.html) for `review_status`, [Image Generation](image-generation.html) for `generate_image`.

### graft_* (7 tools, opt-in)

Registered by `extensions/orchestrator/graft.ts` only when the `graft_enable` setting is on, and only in a trusted session. The default for `graft_enable` is **false**, so these tools are absent in a default install. `graft_refresh` and `graft_blast_radius` are additionally omitted in subagent children.

| Tool | Purpose | Key parameters |
|---|---|---|
| `graft_find_code` | Find compact ranked code references in the local Graft graph | `query`, `limit` (1–20), `path` (project-relative) |
| `graft_find_all` | Search indexed project files | `pattern`, `path`, `fixed` (literal, not regex) |
| `graft_file_api` | Signatures-only API view of a file | `path` |
| `graft_trace_calls` | Trace callers or callees of a symbol | `symbol`, `direction` (`in`/`out`), `depth` (1–10) |
| `graft_repo_map` | Compact graph-based repository map | `max_dirs` (1–30) |
| `graft_refresh` | Rebuild the local Graft graph | none |
| `graft_blast_radius` | Dependencies affected by the local diff | `depth` (1–10) |

## Duplicate registrations

Three names are registered twice in source. The second registration is either a stub or is swallowed, so there is no user-visible conflict — but it is worth knowing if you grep the code.

| Name | Registrations | Which one you get |
|---|---|---|
| `/coms` | `coms-wrapper.ts` (`start \| stop \| status`) and `coms-p2p.ts` (force-refresh the pool widget, `--all` / `--project <name>`) | The wrapper's version. `coms-wrapper` loads `coms-p2p` through a proxy that explicitly swallows the upstream `/coms` registration ("Upstream /coms is owned by the wrapper"). The widget-refresh handler and its `--all` / `--project` flags are therefore dead in the default wrapper setup. |
| `/pidash` | `pidash.ts` twice | Two mutually exclusive branches: one registered when the dashboard is disabled (notify-only stub), one when it is enabled. Exactly one is live. |
| `/pidiff` | `pidiff.ts` twice | Same pattern as `/pidash`: disabled-branch stub, or the full server management command. |

## Verifying this page

The lists here were produced from source, not from documentation:

```bash
# Slash commands
grep -rn 'registerCommand("' extensions/ --include=*.ts

# Tools — note graft.ts registers its tools through a tool() helper loop
grep -rn 'registerTool' extensions/ --include=*.ts
```

When you add a command or a tool, add it to this page in the same change.
