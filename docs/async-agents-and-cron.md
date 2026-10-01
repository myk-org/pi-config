# Running Background Agents and Scheduled Tasks

Run long tasks without blocking your main session, and schedule recurring work so Pi can keep checking, reviewing, or cleaning up in the background. This is useful when you want to keep coding while another agent works, or when you want a workflow to run on a timer.

## Prerequisites

- A running Pi session in your project repository
- A TUI session if you want to use the fullscreen status overlays
- `git` available if your background task depends on repository state
- If you use ACPX-backed models for detached work, `internal_operations_provider` and `internal_operations_model` may be required. See [Configuration & Settings](configuration.html) for details.

## Quick Example

Start a background agent with a plain-English request:

> Run the `security-auditor` on the `src/` directory in the background. Let me know when it's done.

Schedule a recurring task with `/cron`:

```bash
/cron Run the test-automator every 30 minutes
```

Use these when you want non-blocking work right away: one-off jobs through natural language, recurring jobs through `/cron`.

## Step-by-Step

1. Start a background job.

Ask Pi to run a specialist in the background:

> Run the `security-auditor` on the `src/` directory in the background. Let me know when it's done.

Pi can keep your main session free while the background job runs and report back when it finishes.

2. Monitor running async work.

Open the async overlay:

```bash
/async-status
```

This shows queued and running jobs, elapsed time, and live output. Press `Enter` to inspect a job, or press `x` to kill the selected job.

3. Stop async work when needed.

Open the interactive kill picker:

```bash
/async-kill
```

Or cancel everything at once:

```bash
/async-kill all
```

> **Tip:** If you only need to stop one job, the interactive picker is safer because it shows the exact running entries before you kill them.

4. Create a recurring schedule.

Use `/cron` with natural language:

```bash
/cron Every day at 9:00 AM, run the git-expert to generate a daily summary.
```

Pi turns that into a recurring task for the current session.

5. Review or remove scheduled tasks.

List tasks in the current session:

```bash
/cron list
```

List tasks across active Pi sessions:

```bash
/cron list-all
```

Remove a task by ID:

```bash
/cron remove 1
```

`/cron rm <id>` and `/cron delete <id>` are accepted aliases. In the cron overlays, you can also press `x` to remove the selected task.

6. Make a schedule survive a Pi restart.

Prefix any `/cron` request with `--persist`:

```bash
/cron --persist Every day at 9:00 AM, run the git-expert to generate a daily summary.
```

Persisted tasks are written to `.pi/cron/crons.json` in the project and reloaded by later sessions.

## Advanced Usage

### Pick the Right Monitoring Command

| Goal | Command | What you get |
|---|---|---|
| Watch async jobs | `/async-status` | Fullscreen list, live output, kill with `x` |
| Kill async jobs | `/async-kill` | Interactive kill picker |
| Kill one job by name or id prefix | `/async-kill <name\|id-prefix>` | Direct kill without opening the picker |
| Kill every running job | `/async-kill all` | Kills all running and queued jobs |
| See local schedules | `/cron list` | Fullscreen list of this session's recurring tasks |
| See only persisted schedules | `/cron --persist list` | Filters the overlay down to project-scoped crons |
| See all session schedules | `/cron list-all` | Cross-session view of active cron files |
| Remove a known cron | `/cron remove <id>` | Direct removal by task ID |

### Pick the Model for Background Work

Detached agents are resolved through the same chain as any other subagent
(`explicit > agent_overrides[name] > agent frontmatter > agent_provider/agent_model > parent`),
so a plain `agent_model` setting is all you need to pin background work to a specific model.
It is a `string` setting, default `""`, meaning "inherit the parent session's model".

To pin one schedule without moving the whole session, name the model in the request:

```bash
/cron --persist Every hour, check upstream releases using openrouter/anthropic/claude-opus-5.
```

`cron_manage` stores that on the task and passes it as the subagent `explicit` override for
that run only. A bare `model-id` keeps the normal provider resolution chain. An unpinned cron
uses the worker's own chain (`agent_overrides[worker]` → worker frontmatter →
`agent_provider`/`agent_model`) and does not inherit the session model. Pinning an `acpx-*`
provider does not work — child processes cannot register those providers, so the cron runs on
`internal_operations_provider`/`internal_operations_model` when both are set, and is skipped
with a logged error when they are not (see ACPX Compatibility below).

### Keep Background Context Between Runs

If you want a background agent to remember previous work, ask Pi to persist that session:

> Run the code reviewer in the background and persist its session so it remembers previous feedback.

This is most useful for iterative review loops and repeated follow-up work. See [Automating Code Reviews](automating-code-reviews.html) for a full review workflow.

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

> **Note:** If you need to confirm what is still scheduled, run `/cron list` or `/cron list-all` after reconnecting instead of assuming an older schedule is still active.

> **Tip:** `/cron` with free text does not schedule anything by itself. It re-enters the conversation with a request to call the `cron_manage` tool, and `persist` is set to `true` only when you passed `--persist`. Schedules must have an `interval_seconds` of at least 10, and `at_minute` is only valid together with `at_hour`. `model` accepts `provider/model-id` or a bare `model-id`; leaving it out uses the worker's normal model resolution.

### ACPX Compatibility

Detached LLM work is more restricted when your parent session is using an `acpx-*` provider. Child Pi processes launched as async agents skip ACPX provider registration, so Pi decides between three outcomes:

| Case | Behavior |
|---|---|
| Parent is native or `cli-*` | Async work runs detached as normal. |
| Parent is `acpx-*`, work is not must-async | The request is coerced to run synchronously instead. |
| Parent is `acpx-*`, work is must-async (dreaming, `fireAndForget`) | Runs detached on `internal_operations_provider`/`internal_operations_model`; if those are unset, the work is skipped with a warning. |

Set `internal_operations_provider` and `internal_operations_model` to cover that last case. Both are `string` settings, default `""`, and the provider must not itself be an `acpx-*` id.

See [ACPX Provider Integration](acpx-provider.html) and [Configuration & Settings](configuration.html) for the exact setup.

## Troubleshooting

- **Async job does not start:** Confirm you asked for it in the background (`async: true`) and that you ended your turn — Pi delivers results automatically and does not expect a polling loop. Agents declared async-only force `async: true` on a native provider and refuse chain mode.
- **Job starts but immediately skips:** If your session is using an ACPX-backed provider, configure `internal_operations_provider` and `internal_operations_model` before retrying.
- **You want the result to update a task automatically:** Pass a numeric `taskId` from the task tools. It is optional; when set, the finished job marks that task `completed` for you.
- **You want live output but nothing appears:** Use `/async-status` from a TUI session. The fullscreen overlay is the supported live-view interface.
- **A cron task seems stuck or outdated:** Run `/cron list` or `/cron list-all`, then remove the old task and create a fresh one.
- **You want browser-based monitoring instead of terminal overlays:** See [Using the Web Dashboard](using-the-web-dashboard.html) for details.

## Related Pages

- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Managing Custom Agents](managing-custom-agents.html)
- [Configuration & Settings](configuration.html)
