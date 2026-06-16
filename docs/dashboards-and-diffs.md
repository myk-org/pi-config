# Using the Web Dashboard and Diff Viewer

Monitor all your pi sessions from a browser and review code diffs with inline comments — without leaving your workflow. Pidash gives you a real-time web dashboard, and pidiff gives you a rich diff viewer that sends review comments back to pi.

## Prerequisites

- Pi is installed and running in TUI mode (interactive terminal)
- Your project is inside a git repository (required for pidiff)

## Quick Start

Both dashboards auto-start when you launch a pi session. Open them in your browser:

- **Dashboard:** [http://localhost:19190](http://localhost:19190)
- **Diff viewer:** [http://localhost:19290](http://localhost:19290)

The URLs appear in your pi status line automatically once the daemons are ready.

> **Tip:** If the daemons didn't auto-start (e.g., first run with cold compilation), use `/pidash start` and `/pidiff start` in your pi session.

## Managing the Dashboard (pidash)

### Checking Status

```
/pidash status
```

This shows whether the server is running, the port it's listening on, and whether your session is connected.

### Starting, Stopping, and Restarting

```
/pidash start
/pidash stop
/pidash restart
```

### What You Can Do in the Browser

Once you open `http://localhost:19190`, the dashboard shows:

- **Session sidebar** — all active pi sessions, grouped by project. Click any session to watch it live.
- **Message stream** — user prompts, AI responses (including thinking blocks), tool calls and results, all in real-time.
- **Input bar** — type prompts directly from the browser. They're delivered to the pi session as follow-up messages.
- **Info bar** — model name, thinking level, token usage, git branch/status, async agent count, and cron tasks.
- **Search** — filter messages by content or by role (user, assistant, tool, thinking).

### Sending Prompts from the Browser

Type in the input bar at the bottom. Your message is forwarded to the active pi session. If the AI is currently streaming a response, a "prompt queued" banner appears — your message will run after the current turn.

You can also send slash commands (e.g., `/status`, `/btw what's the test coverage?`) directly from the browser input bar.

> **Note:** You can attach images via the browser input bar. They're sent as base64 to the pi session alongside your text prompt.

### Switching Between Sessions

The sidebar lists all active sessions. Click one to watch it. The dashboard replays the session's message history so you can catch up.

Keyboard shortcuts for fast switching:

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Open session switcher (fuzzy search) |
| `Ctrl+↑` / `Ctrl+↓` | Previous / next session |
| `Ctrl+1` through `Ctrl+9` | Jump to session by position |
| `Escape` | Abort the current AI turn |

> **Tip:** Keybindings are customizable. Click the settings icon in the sidebar to rebind any shortcut.

### Changing Model and Thinking Level

Click the model name or thinking level in the info bar to open a dropdown. Selecting a new value takes effect immediately in the pi session.

- **Model:** searchable list of all available models
- **Thinking level:** off, minimal, low, medium, high

### Monitoring Background Agents and Cron Tasks

The info bar shows async agent and cron task counts. Click them to expand:

- **Async agents** — see each running agent's name, task, elapsed time. Click "Kill" to terminate one, or "Kill All" to stop all.
- **Cron tasks** — see schedules, last/next run times. Kill individual tasks or all at once.

See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for more on async agents and cron.

### Responding to Dialogs

When pi asks a question (via `ask_user`), the dialog appears inline in the message stream. You can respond from either the terminal or the browser — whichever answers first wins.

### Browser Notifications

The dashboard sends browser notifications for events in non-watched sessions (or when the tab is unfocused):

| Notification | Default |
|---|---|
| AI turn complete | On |
| Agent finished | On |
| Test results | On |
| Session errors | On |
| Input needed | On |
| Tool complete | Off |

Click the bell icon in the sidebar to toggle individual categories. Grant browser notification permission when prompted.

## Using the Diff Viewer (pidiff)

### Checking Status

```
/pidiff status
```

### Starting, Stopping, and Restarting

```
/pidiff start
/pidiff stop
/pidiff restart
```

### Viewing Diffs

Open `http://localhost:19290` in your browser. The diff viewer shows:

- **Session selector** — pick which pi session's repository to view
- **File tree** — left panel with all changed files, color-coded by git status (added, modified, deleted, renamed)
- **Diff panes** — syntax-highlighted side-by-side or unified diffs

Diffs are categorized into three areas:

| Area | Description |
|------|-------------|
| **Committed** | Changes between the branch's merge base and HEAD |
| **Staged** | Files added to the git index (`git add`) |
| **Unstaged** | Working tree modifications and untracked files |

### Branch vs. Commit Mode

Two diff modes are available via the header buttons:

- **Branch** (default) — shows all changes on the current branch relative to the default remote branch (e.g., `origin/main`)
- **Commits** — select two commits from a dropdown to compare them directly

### Worktree Support

If your project uses git worktrees, tabs appear in the header — one per worktree. Click a tab to switch between worktree views. A yellow dot on a tab indicates that worktree has changed since you last looked at it.

### Leaving Review Comments

Click any line number gutter in a diff to open an inline comment form. Write your review comment and click "Comment" (or press `Ctrl+Enter`).

Comments accumulate in the "Pending" panel below the file tree. You can:

- **Edit** — click a pending comment to re-open its form
- **Delete** — hover and click the ✕ icon
- **Reply** — add threaded replies to existing comments
- **Resolve** — mark a comment as addressed

### Publishing Review Comments

Click the green **Publish** button in the header (or in the pending panel) to send all comments to the pi session. Pi receives them as a structured code review and will address the feedback.

> **Note:** Publishing clears all pending comments. The comments are delivered to the pi session as a follow-up message containing the review in JSON format.

### Real-Time Change Detection

The diff viewer watches your file system using chokidar. When files change, an amber "Files have changed" banner appears. Click **Refresh** to reload the diffs.

### Customizing Diff Display

The settings toolbar lets you adjust:

| Setting | Options |
|---------|---------|
| **Diff style** | Split (side-by-side) or Unified |
| **Indicators** | Bars, Classic (+/-), or None |
| **Line diff** | word-alt, word, char, none |
| **Hunk separators** | line-info, line-info-basic, metadata, simple |
| **Theme** | 30+ themes including pierre-dark, github-dark, dracula, monokai, tokyo-night, catppuccin, and more |
| **Font size** | 11px – 16px |
| **Backgrounds** | Toggle diff background colors |
| **Wrapping** | Scroll or wrap long lines |
| **Line numbers** | Toggle visibility |

## Advanced Usage

### Custom Ports

Override the default ports with environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_PIDASH_PORT` | `19190` | Pidash dashboard port |
| `PI_PIDIFF_PORT` | `19290` | Pidiff diff viewer port |

Set these before starting your pi session:

```bash
PI_PIDASH_PORT=8080 PI_PIDIFF_PORT=8081 pi
```

### Disabling Auto-Start

If you don't want the daemons to start automatically:

```bash
PI_PIDASH_ENABLE=false pi    # Disable dashboard
PI_PIDIFF_ENABLE=false pi    # Disable diff viewer
```

When disabled, the `/pidash` and `/pidiff` commands still exist but will tell you the extension is disabled.

### Linking Pidash and Pidiff

The dashboard info bar includes a direct link to the diff viewer when both are running. Look for the "diff" link next to the git branch indicator — clicking it opens the diff viewer for the currently watched session.

### Discord Bot Integration

Pidash includes an optional Discord bot that bridges DMs to pi sessions. This lets you monitor and interact with pi from your phone.

To enable it, create `~/.pi/discord.env`:

```
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_ALLOWED_USERS=your-discord-user-id
```

Once configured, the bot starts with the pidash daemon. Use these Discord commands:

| Command | Description |
|---------|-------------|
| `/sessions` | List active sessions — tap a button to watch one |
| `/status` | Show current watched session info |
| `/stop` | Interrupt the current AI turn |

You can also send prompts by DM'ing the bot directly (including image attachments). Responses stream back to Discord.

> **Warning:** If you omit `DISCORD_ALLOWED_USERS`, the bot accepts DMs from everyone. Always restrict access in production.

### Network Access

Pidash binds to `0.0.0.0` (accessible from your LAN) while pidiff binds to `127.0.0.1` (localhost only). The pidash server validates the `Origin` header, accepting only localhost and RFC 1918 private IP ranges.

### Session Switching from the Browser

Click the "sessions" dropdown in the info bar to see all saved sessions for the current project. Selecting a different session tells pi to switch to it (equivalent to `/resume` in the terminal).

### Session History on Reconnect

If the pidash daemon restarts, sessions automatically reconnect. The dashboard loads full session history from pi's session file (the source of truth), so you never lose context.

## Troubleshooting

**Dashboard shows "← Select a session" but sessions are running**

The daemon may be starting for the first time (cold compilation can take up to 60 seconds). Wait for the status line URL to appear in your pi terminal, then refresh the browser.

**Diff viewer shows "Waiting for pi sessions…"**

Your pi session must be in a git repository. Non-git directories won't register with pidiff.

**Commands from the browser don't work**

Make sure you've typed at least one command in the terminal first. The browser command handler needs to capture pi's command context from the first interactive use.

**Server logs**

Check the daemon logs for errors:

- `~/.pi/pidash-server.log` — pidash daemon output
- `~/.pi/pidash-debug.log` — pidash extension debug log
- `~/.pi/pidiff-debug.log` — pidiff extension debug log

**Stale diffs after branch switch**

The amber banner may not appear immediately for branch-level changes. Click the "Refresh" button manually or switch modes to force a reload.

## Related Pages

- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Controlling Pi Sessions from Discord](discord-bot.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
