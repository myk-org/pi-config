# Running Background Agents and Scheduled Tasks

Run long tasks without blocking your main session, and schedule recurring work so Pi can keep checking, reviewing, or cleaning up in the background. This is useful when you want to keep coding while another agent works, or when you want a workflow to run on a timer.

## Prerequisites

- A running Pi session in your project repository
- A TUI session if you want to use the fullscreen status overlays
- `git` available if your background task depends on repository state
- If you use ACPX-backed models for detached work, `async_llm_provider` and `async_llm_model` may be required. See [Configuration & Settings](configuration.html) for details.

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

In the cron overlays, you can also press `x` to remove the selected task.

## Advanced Usage

### Pick the Right Monitoring Command

| Goal | Command | What you get |
|---|---|---|
| Watch async jobs | `/async-status` | Fullscreen list, live output, kill with `x` |
| Kill async jobs | `/async-kill` | Interactive kill picker |
| See local schedules | `/cron list` | Fullscreen list of this session’s recurring tasks |
| See all session schedules | `/cron list-all` | Cross-session view of active cron files |
| Remove a known cron | `/cron remove <id>` | Direct removal by task ID |

### Keep Background Context Between Runs

If you want a background agent to remember previous work, ask Pi to persist that session:

> Run the code reviewer in the background and persist its session so it remembers previous feedback.

This is most useful for iterative review loops and repeated follow-up work. See [Automating Code Reviews](automating-code-reviews.html) for a full review workflow.

### Use Fire-and-Forget for Maintenance Jobs

For maintenance tasks where you do not want a follow-up result injected back into chat, ask for fire-and-forget behavior:

> Run a background memory cleanup task as fire-and-forget.

This is a good fit for housekeeping work where a completion notification is enough. See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for a concrete example.

### Understand Cron Lifetime

Cron tasks belong to the current Pi process. They survive session refreshes inside that process, but they do not keep running after a full Pi exit.

> **Note:** If you need to confirm what is still scheduled, run `/cron list` or `/cron list-all` after reconnecting instead of assuming an older schedule is still active.

### ACPX Compatibility

Detached LLM work is more restricted when your parent session is using an `acpx-*` provider. In that case, some async work may be skipped or require a separate async LLM provider/model to be configured first.

See [ACPX Provider Integration](acpx-provider.html) and [Configuration & Settings](configuration.html) for the exact setup.

## Troubleshooting

- **Async job does not start:** If Pi complains about a missing `taskId`, the workflow is expecting the background work to be linked to a tracked task or explicitly marked as independent.
- **Job starts but immediately skips:** If your session is using an ACPX-backed provider, configure `async_llm_provider` and `async_llm_model` before retrying.
- **You want live output but nothing appears:** Use `/async-status` from a TUI session. The fullscreen overlay is the supported live-view interface.
- **A cron task seems stuck or outdated:** Run `/cron list` or `/cron list-all`, then remove the old task and create a fresh one.
- **You want browser-based monitoring instead of terminal overlays:** See [Using the Web Dashboard](using-the-web-dashboard.html) for details.

## Related Pages

- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Managing Custom Agents](managing-custom-agents.html)
- [Configuration & Settings](configuration.html)
