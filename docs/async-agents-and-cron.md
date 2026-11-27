# Running Background Agents and Scheduled Tasks

Run long tasks without blocking your main session, and schedule recurring work so Pi can keep checking, reviewing, or cleaning up in the background. This is useful when you want to keep coding while another agent works, or when you want a workflow to run on a timer.

## Prerequisites

- A running Pi session in your project repository
- A TUI session if you want to use the fullscreen status overlays
- `git` available if your background task depends on repository state

## Quick Example

Start a background agent with a plain-English request:

> Run the `security-auditor` on the `src/` directory in the background. Let me know when it's done.

Manage recurring tasks with the zero-arg `/cron` TUI overlay (or ask Pi to schedule one via `cron_manage`):

```bash
/cron
```

Use these when you want non-blocking work right away: one-off jobs through natural language, recurring jobs through `/cron` or `cron_manage`.

## Step-by-Step

1. Start a background job.

Ask Pi to run a specialist in the background:

> Run the `security-auditor` on the `src/` directory in the background. Let me know when it's done.

Pi can keep your main session free while the background job runs and report back when it finishes.

2. Monitor running async work.

Open the async overlay:

```bash
/async
```

This shows queued and running jobs, elapsed time, and live output. Press `Enter` to inspect a job, press `x` to kill the focused job, press `Space` to multi-select rows and `x` again to kill the whole selection, or press `X` to immediately kill every running and queued job (no confirmation prompt).

Sync subagents run in the foreground of your turn, but they are real child processes, so they appear here too with a `sync` marker, their elapsed time and the tool they are running. `x` on a sync row aborts that process: the same SIGTERM → SIGKILL (after 5s) escalation the async kill uses. A sync agent's *result* still arrives in the orchestrator's turn, not as a follow-up message — the row is visibility plus an abort handle, nothing more. The footer counts both: `⏳ agents: 3 (2 async, 1 sync)`, and stays `⏳ async: N` when only async jobs run.

3. Stop async work when needed.

Use the same `/async` overlay:

- `Space` toggles rows into a selection (`Enter` inspects a row without losing ticks, `Esc` clears the selection first), and `x` kills every active job in the selection (reporting inline if none are active).
- `X` immediately kills every running and queued job. There is no confirmation prompt.

> **Tip:** If you only need to stop one job, `x` on the focused row is safer because it shows the exact running entries before you kill them.

4. Create, edit, pause, persist, or remove scheduled tasks.

Open the zero-arg cron TUI:

```bash
/cron
```

Inside `/cron`:

- `n` adds a new cron task (prompt/command, schedule such as `5m` or `09:30`, optional description, persist choice, optional model override).
- `e` edits the focused cron in place.
- `p` pauses or resumes the focused cron (or all `Space`-selected crons).
- `t` toggles persist/session scope for the focused cron (or all `Space`-selected crons), safely moving tasks between session storage and `.pi/cron/crons.json`.
- `x` deletes the focused cron (or all `Space`-selected crons).
- `f` cycles the scope filter (`all` → `session` → `persist`).
- `Enter` opens the detail view.

You can also ask Pi in plain English to create, edit, pause, resume, or remove schedules using the `cron_manage` tool.

## Advanced Usage

### Pick the Right Monitoring Command

| Goal | Command | What you get |
| --- | --- | --- |
| Watch async jobs | `/async` | Fullscreen list, live output, kill with `x` |
| Watch foreground subagents | `/async` | Sync rows carry a `sync` marker, current tool and elapsed time; `x` aborts them |
| Kill the focused job | `/async` → `x` | Kills the highlighted job |
| Kill several jobs | `/async` → `Space`, `Space`, `x` | Kills every multi-selected job |
| Kill every running job | `/async` → `X` | Immediately kills all running and queued jobs |
| Open cron overlay | `/cron` | Fullscreen list of session and persisted schedules |
| Filter cron scope | `/cron` → `f` | Cycles between `all`, `session`, and `persist` |
| Add or edit a cron | `/cron` → `n` / `e` | Interactive dialog to create or update a cron |
| Toggle persist/session | `/cron` → `t` | Moves focused or `Space`-selected crons between session and `.pi/cron/crons.json` |
| Disable a cron without deleting it | `/cron` → `p` | Toggles `⏸ paused` (single or `Space`-selected); resuming starts a fresh interval |

### Pick the Model for Background Work

Detached agents are resolved through the same chain as any other subagent
(`explicit > agent_overrides[name] > agent frontmatter > agent_provider/agent_model > parent`),
so a plain `agent_model` setting is all you need to pin background work to a specific model.
It is a `string` setting, default `""`, meaning "inherit the parent session's model".

To pin one schedule without moving the whole session, enter a model override in `/cron` (`n` or `e`), or ask Pi via `cron_manage`:

> Every hour, check upstream releases using `openrouter/anthropic/claude-opus-5` and persist it.

`cron_manage` stores that on the task and passes it as the subagent `explicit` override for
that run only. A bare `model-id` keeps the normal provider resolution chain. An unpinned cron
uses the worker's own chain (`agent_overrides[worker]` → worker frontmatter →
`agent_provider`/`agent_model`) and does not inherit the session model.

### Keep Background Context Between Runs

If you want a background agent to remember previous work, ask Pi to persist that session:

> Run the code reviewer in the background and persist its session so it remembers previous feedback.

This is most useful for iterative review loops and repeated follow-up work. See [Automating Code Reviews](automating-code-reviews.html) for a full review workflow.

### Keep Monitoring Crons Quiet When Nothing Changed

Monitoring crons often run on a short interval and find nothing to report. Set `quiet_on_noop: true` on `cron_manage(action="add")` or `cron_manage(action="edit")` to avoid interrupting your main session on clean checks:

- Pi appends a short instruction to the spawned worker prompt telling it to reply with a single line starting with `[NOOP]` when nothing changed or requires attention.
- When the worker succeeds (`complete`) and its trimmed output starts with `[NOOP]` (case-insensitive), Pi records the run in cron history (`lastRun`, `runCount`, `lastOutcome: "noop"`) and skips delivering a `followUp` chat turn.
- Any error, failure, or non-`[NOOP]` output still delivers normally so failures are never hidden.
- `/cron` shows a `quiet` badge on quiet crons and `(noop)` / `(error)` on the last run outcome.

### Use Fire-and-Forget for Maintenance Jobs

For maintenance tasks where you do not want a follow-up result injected back into chat, ask for fire-and-forget behavior:

> Run a background memory cleanup task as fire-and-forget.

This is a good fit for housekeeping work where a completion notification is enough. See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for a concrete example.

### Understand Cron Lifetime

Cron tasks have two scopes, chosen by the `--persist` flag:

| Scope | Stored in | Survives Pi exit | Runs from |
|---|---|---|---|
| session (default) | The session store under `.pi/tmp/` | No | That session only |
| project (`--persist`) | `.pi/cron/crons.json` in the project | Yes | Any session opened in that project |

Session-scoped tasks survive `/reload` inside the running process but are deleted on a real exit. Project-scoped tasks are reloaded by later sessions, and a leader lease in the same directory guarantees only one session executes a given task — other sessions show it as `project (waiting for leader)`.

> **Note:** If you need to confirm what is still scheduled, run `/cron` after reconnecting instead of assuming an older schedule is still active.

> **Tip:** The LLM manages crons via `cron_manage` (`add`, `list`, `edit`, `pause`, `resume`, `remove`). Schedules must have an `interval_seconds` of at least 10, and `at_minute` is only valid together with `at_hour` (or alone when editing an existing daily schedule). `model` accepts `provider/model-id` or a bare `model-id`; leaving it out uses the worker's normal model resolution, and passing `model: ""` on `edit` clears a pinned model back to inherited. Pass `quiet_on_noop: true` on `add` or `edit` so monitoring crons stay silent on successful `[NOOP]` replies while still delivering errors and findings. Use `edit` to update a cron in place (preserving its ID, run history, and paused state) and `pause`/`resume` to toggle execution without deleting it.

## Troubleshooting

- **Async job does not start:** Confirm you asked for it in the background (`async: true`) and that you ended your turn — Pi delivers results automatically and does not expect a polling loop. Agents declared async-only force `async: true` and refuse sync chain mode.
- **You want the result to update a task automatically:** Pass a numeric `taskId` from the task tools. It is optional; when set, the finished job marks that task `completed` for you.
- **You want live output but nothing appears:** Use `/async` from a TUI session. The fullscreen overlay is the supported live-view interface. A sync row has no output pane — everything it printed is already in your transcript.
- **The footer counts an agent you cannot find in `/async`:** A sync agent registers for exactly as long as its child process lives. A count that does not fall back to `0` means a child is still alive — open `/async`, find the `sync` row and press `x` to abort it.
- **A cron task seems stuck or outdated:** Open `/cron` to inspect, edit, pause, or delete it, or ask Pi to update it in place with `cron_manage` (`edit`, `pause`, `resume`).
- **You want browser-based monitoring instead of terminal overlays:** See [Using the Web Dashboard](using-the-web-dashboard.html) for details.

## Related Pages

- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Managing Custom Agents](managing-custom-agents.html)
- [Configuration & Settings](configuration.html)
