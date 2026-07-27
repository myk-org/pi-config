# Running Background Agents and Scheduled Tasks

This guide explains how to offload long-running tasks to non-blocking background agents and schedule recurring workflows. Using background tasks keeps your main session free for active development while AI handles research, tests, or code reviews concurrently.

## Prerequisites

- A running Pi session in your project repository.
- Familiarity with the web dashboard (See [Using the Web Dashboard](using-the-web-dashboard.html)).

## Quick Example

To run a task in the background, simply ask Pi to do it asynchronously:

> "Run the `security-auditor` on the `src/` directory in the background. Let me know when it's done."

Pi will spawn the agent asynchronously. Your terminal remains unblocked, and Pi will notify you when the agent finishes.

To schedule a recurring task, use the `/cron` command with natural language:

```bash
/cron Run the test-automator every 30 minutes
```

## Spawning and Managing Async Agents

Background agents are managed natively by Pi. They run in a separate process and report their results back to your chat automatically.

### 1. Spawning Agents

You can instruct Pi to run any specialist agent in the background. Certain agents (like code reviewers) are enforced to always run asynchronously to prevent blocking your session.

When you ask Pi to run a background agent, it automatically links the job to a Task ID to track completion.

> **Tip:** You can ask Pi to spawn multiple agents at once: "Run `python-expert` on the backend and `ts-expert` on the frontend in the background."

### 2. Monitoring Background Tasks

To view active background tasks, their elapsed time, and live logs, open the async status dashboard:

```bash
/async-status
```

This opens a fullscreen overlay. You can navigate through the queued and running tasks to see what the agents are currently processing.

### 3. Killing Misbehaving Agents

If an agent gets stuck or you no longer need its result, you can terminate it directly from the chat:

```bash
/async-kill code-reviewer
```

You can target agents by their exact name, ID prefix, or use `all` to cancel everything:

```bash
/async-kill all
```

Alternatively, you can press `x` while highlighting a job inside the `/async-status` overlay.

## Scheduling Recurring Tasks (Cron)

The `/cron` command allows you to define recurring jobs using plain English. Pi interprets your request and sets up the appropriate timers.

### Adding a Scheduled Task

To schedule a new task, pass your requirements directly to the `/cron` command:

```bash
/cron Every day at 9:00 AM, run the git-expert to generate a daily summary.
```

Pi will parse the time ("9:00 AM") and the action, start the timer, and confirm the schedule.

> **Note:** Cron tasks are scoped to your active session process. If you exit Pi, the timers stop. They resume automatically when you start a new session in the same project directory.

### Listing and Removing Tasks

To see what tasks are currently scheduled in your local session:

```bash
/cron list
```

To see tasks scheduled across all active Pi sessions on your machine:

```bash
/cron list-all
```

If you want to stop a recurring task, find its ID from the list command and remove it:

```bash
/cron remove 1
```

## Advanced Usage

### Persistent Sessions

Normally, async agents start with a fresh memory state (an ephemeral session). If you want an agent to retain context across multiple background runs, you can ask Pi to enable session persistence:

> "Run the code reviewer in the background and persist its session so it remembers previous feedback."

This is heavily utilized by automated code reviews to maintain context over iterative PR improvements. See [Automating Code Reviews](automating-code-reviews.html) for more details.

### Fire and Forget Mode

For background maintenance tasks (like memory consolidation or cache cleanup), results don't need to clutter your active chat. Ask Pi to run the task in "fire and forget" mode:

> "Run a background memory cleanup task as fire-and-forget."

The task will execute silently. You will only see a lightweight terminal notification when it completes. See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for an example of this pattern.

## Troubleshooting

- **Agent skips execution:** If an async agent immediately fails or skips, ensure your provider supports async LLM invocation. Some ACPX integrations cannot spawn child processes. See [ACPX Provider Integration](acpx-provider.html) for compatibility details.
- **Missing Task IDs:** If Pi refuses to spawn an agent, complaining about a "missing taskId", ensure your prompt asks Pi to either link the background agent to an existing task list item, or explicitly tell it the task is independent.
- **Zombie processes:** Pi automatically cleans up orphaned background agents on startup. If you notice high CPU usage after a crash, restart your session to trigger the cleanup sequence.

## Related Pages

- [Background Memory Consolidation (Dreaming)](background-dreaming.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
