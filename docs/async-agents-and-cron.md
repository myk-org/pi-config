# Running Background Agents and Scheduled Tasks

Offload long-running work — code reviews, memory consolidation, research — to background agents so your session stays responsive, and set up recurring tasks that run on a schedule.

## Prerequisites

- A running pi session with the orchestrator extension loaded
- At least one specialist agent available (check with `/status`)

## Quick Example

Ask pi to run a code review in the background while you keep working:

```
Review the changes on this branch for security issues — run it in the background
```

The orchestrator dispatches the review agent asynchronously. You'll see `⏳ async: 1` in your status bar, and the result appears in your conversation when it finishes.

Check on it anytime:

```
/async-status
```

## How Async Agents Work

When the orchestrator delegates a task with `async: true`, it spawns a detached pi process that runs independently. Your session stays free for other work.

There are two delivery modes:

| Mode | Result Delivery | Use Case |
|------|----------------|----------|
| **Tracked** (default) | Result injected into your conversation when complete | Code reviews, research, analysis |
| **Fire-and-forget** | Terminal notification only, no conversation injection | Memory dreaming, maintenance tasks |

### What Happens When an Async Agent Finishes

1. A desktop/terminal notification fires: *"Async agent Code Review completed (2m34s)"*
2. For tracked agents, the full output appears in your conversation as a follow-up message
3. The status bar updates from `⏳ async: 1` to `⏳ async: 0`

## Monitoring Background Agents

### Checking Status

Run `/async-status` to see all running and recently completed agents:

```
/async-status
```

If agents are running, you'll get an interactive selector. Pick one to see its **live output** — a scrollable view that updates in real time as the agent works.

| Key | Action |
|-----|--------|
| ↑/↓ | Scroll line by line |
| PgUp/PgDn | Scroll by page |
| Home/End | Jump to top/bottom |
| Esc | Close the viewer |

> **Tip:** The status bar always shows the current async agent count (`⏳ async: N`). You can also see async status via `/status` for a unified snapshot.

### Killing Background Agents

To stop a runaway or unwanted agent:

```
/async-kill
```

This opens an interactive selector. Pick the agent to terminate.

You can also kill by name or kill all:

```
/async-kill code-reviewer-security
/async-kill all
```

## Async-Only Agents

Certain agents are enforced to **always** run asynchronously. If the orchestrator tries to dispatch them synchronously, the system automatically promotes the call to async. These agents are:

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

This prevents your session from blocking on long-running reviews. See [Running the Automated Code Review Loop](code-review-loop.html) for how reviews use async agents.

> **Note:** Async-only agents cannot be used in chain mode (sequential steps with `{previous}` placeholder). They must be dispatched as separate async tasks.

## Scheduling Recurring Tasks with /cron

Use `/cron` to schedule tasks that run on a repeating interval or at a specific time each day.

### Creating a Scheduled Task

Use natural language — the orchestrator parses your intent:

```
/cron run tests every 30 minutes
/cron check for new PRs every 2 hours
/cron summarize git log daily at 09:00
```

You can also schedule slash commands:

```
/cron run /dream every 4 hours
```

### Listing Scheduled Tasks

```
/cron list
```

Output:

```
#1 | every 30m  | run tests                    | last run: 14:30:00
#2 | every 2h   | check for new PRs            | last run: 13:00:00
#3 | at 09:00   | summarize git log            | last run: never
```

To see cron tasks across all active pi sessions:

```
/cron list-all
```

### Removing a Scheduled Task

```
/cron remove 2
```

You can remove multiple at once:

```
/cron remove 1 3
```

### How Cron Tasks Execute

| Task Type | Behavior |
|-----------|----------|
| Starts with `/` | Runs as a slash command in your session |
| Plain text prompt | Spawns a `worker` async agent with the prompt |

> **Note:** Cron tasks are scoped to the pi process. They survive `/reload`, `/resume`, and `/new` but stop when you exit pi. The minimum interval is 10 seconds.

### Schedule Types

| Type | Description | Example |
|------|-------------|---------|
| **Interval** | Runs every N seconds/minutes/hours | `/cron run tests every 15 minutes` |
| **Daily time** | Runs once per day at a specific time | `/cron deploy status at 08:30` |

## Automatic Memory Dreaming

Pi includes a built-in background task that consolidates session memories on a timer. See [Working with Project Memory](memory-system.html) for the full picture.

By default, dreaming runs every **3 hours** as a fire-and-forget async agent and also triggers on session quit.

Toggle it:

```
/dream-auto off
/dream-auto on
```

Trigger a dream manually:

```
/dream
```

Configure the interval per-project in `.pi/pi-config-settings.json`:

```json
{
  "dream_interval_hours": 4
}
```

Valid range: 0.5–24 hours. You can also set it globally with the `PI_DREAM_INTERVAL_HOURS` environment variable. See [Configuration and Environment Variables Reference](configuration-reference.html) for all settings.

## Advanced Usage

### Sync vs Async Decision

The orchestrator enforces a **30-second sync limit**. Tasks estimated to take 30 seconds or longer must use `async: true`. The orchestrator handles this automatically, but understanding the rule helps:

| Duration | Mode | Orchestrator Blocks? |
|----------|------|---------------------|
| < 30s estimated | Sync (default) | Yes — waits for result |
| ≥ 30s estimated | Async required | No — returns immediately |
| Any code reviewer | Always async | No — auto-promoted |

For sync tasks, the orchestrator also enforces:
- Maximum **4 concurrent** sync agents in parallel mode
- Maximum **8 parallel tasks** total per subagent call

### Parallel Async Dispatch

The orchestrator can spawn multiple async agents in a single turn. This is how the code review loop works — all three reviewers launch simultaneously:

```
Review the current changes — run all three reviewers in parallel
```

Each gets its own status entry and delivers results independently.

### Using /status for a Unified View

The `/status` command gives you a snapshot of everything running:

```
/status
```

```
⏳ Async agents: 2 running
   • Code Review Quality — 1m23s — Review changes on feat/issue-42
   • Code Review Security — 1m23s — Review changes on feat/issue-42
⏰ Cron tasks: 1 active
   • #1 every 30m — run tests (last: 14:30:00)
🌿 Git: feat/issue-42 ● 3 changed files (my-project)
```

See [Using Slash Commands and Prompt Templates](slash-commands.html) for details on `/status` and other commands.

### Viewing Async Agents in the Web Dashboard

If you have the pidash web dashboard running, async agents appear there in real time — including live event streaming from each background agent. See [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html) for setup.

## Troubleshooting

**Async agent stuck as "running" forever**
The poller checks if the agent's process is still alive. If the process died, the agent is automatically marked as failed. Zombie agents from previous sessions are cleaned up on session start. If you see a stuck agent, use `/async-kill` to terminate it.

**Cron tasks disappeared after restarting pi**
Cron tasks are tied to the pi process. When you exit pi and start a new session, previous crons are gone. Re-create them with `/cron`.

**Async results not appearing in conversation**
Fire-and-forget agents don't inject results — they only send a terminal notification. If a tracked agent's result is missing, check `/async-status` to see if it's still running or if it failed.

**Debug logging for async agents**
Set the `PI_ASYNC_DEBUG` environment variable to enable detailed logging:

```bash
PI_ASYNC_DEBUG=1 pi
```

Logs are written to the project temp directory under `debug.log`.

## Related Pages

- [Running the Automated Code Review Loop](code-review-loop.html)
- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html)
- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
