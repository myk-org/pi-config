# Monitoring Sessions with the Web Dashboard

Monitor multiple pi sessions from your browser, stream conversations in real time, and respond to agent questions — all without switching terminal windows.

## Prerequisites

- A running pi session (Pidash starts automatically with your first session)
- A modern browser (Chrome, Firefox, Safari, or Edge)

## Quick Start

Open your browser and navigate to:

```
http://localhost:19190
```

That's it. The Pidash dashboard launches automatically when your first pi session starts. Every session you open registers itself with the dashboard in real time.

## Viewing Sessions

The sidebar on the left lists all active sessions, grouped by project name. Each entry shows:

- **Model name** currently in use
- **Git branch** and working tree status (clean or dirty with change count)
- **Activity indicator** — a pulsing green dot means the agent is actively working
- **Container badge** — shows when a session runs inside Docker

Click any session to watch it. The message list loads the full conversation history, including user messages, assistant responses, thinking blocks, and tool executions.

> **Tip:** Sessions remain visible in the sidebar for 5 minutes after disconnecting, so you won't lose track of recently closed terminals.

## Streaming Conversations

When you select a session, the dashboard streams its conversation in real time:

- **User messages** appear as they're sent from the terminal
- **Assistant text** streams token by token, just like in the terminal
- **Thinking blocks** are displayed when the model uses extended thinking
- **Tool calls** show inline with execution status (checkmark for success, X for failure)
- **Async agent output** streams inline as sub-messages

Use the search bar at the top to filter messages by role (user, assistant, tool results) or search for specific text.

## Sending Messages from the Browser

Type a message in the input bar at the bottom and press **Enter** to send it to the active session. The agent processes it exactly as if you typed it in the terminal.

The input bar supports:

- **Multi-line input** — press **Shift+Enter** for a new line
- **Slash commands** — type `/` to see a filtered list of available commands, then press **Tab** or **Enter** to autocomplete
- **Image attachments** — click the paperclip icon or drag and drop image files into the input area
- **Text file attachments** — attach code files, logs, or config files (`.py`, `.ts`, `.json`, `.yaml`, `.md`, and many more)
- **Input history** — press the **Up/Down** arrow keys to cycle through your last 50 messages

> **Note:** Attached images are sent as base64-encoded data. Text files are inserted into the message body with filename headers.

## Responding to Agent Questions

When an agent needs input — a confirmation, a selection from options, or a free-form answer — the question appears inline in the message list with interactive controls.

You can answer from either the browser or the terminal. Whichever responds first wins; the other side dismisses automatically.

The dashboard sends a browser notification when input is needed, so you'll know even if you're in another tab.

## Controlling the Model and Thinking Level

The info bar at the top of the message area shows the current model, token usage, and context window consumption.

**Switch models:**

1. Click the model name in the info bar
2. Search or scroll through available models
3. Click to switch — the change takes effect immediately

**Adjust thinking level:**

1. Click the thinking level indicator in the info bar
2. Choose from: off, minimal, low, medium, or high

## Keyboard Shortcuts

Navigate sessions quickly without touching the mouse:

| Shortcut | Action |
|----------|--------|
| **Ctrl+K** | Open session switcher |
| **Ctrl+Up** | Previous session |
| **Ctrl+Down** | Next session |
| **Ctrl+1** through **Ctrl+9** | Jump to session by number |
| **Escape** | Stop the current operation or close modals |

All shortcuts are customizable. Click the gear icon in the sidebar header to open keybinding settings, where you can reassign any shortcut.

## Notifications

The dashboard sends browser push notifications for important events so you can work in other tabs or windows. Click the gear icon in the sidebar to toggle individual notification types:

| Notification | Default | Description |
|-------------|---------|-------------|
| Turn complete | On | Agent finished processing |
| Agent complete | On | Subagent finished |
| Test results | On | Test pass/fail with status |
| Session error | On | Error in the session |
| Input needed | On | Agent is waiting for your response |
| Tool complete | Off | Individual tool call finished |

Notifications only fire when the dashboard tab is not focused or you're watching a different session, so they never interrupt your active work.

> **Note:** Your browser will ask for notification permission the first time. Grant it once and the preference persists.

## Monitoring Context and Token Usage

The info bar displays real-time token counters:

- **Input tokens** (up arrow) — tokens sent to the model
- **Output tokens** (down arrow) — tokens generated by the model
- **Cache tokens** (box icon) — tokens served from cache, shown only when caching is active
- **Context usage** — percentage of the model's context window consumed, color-coded green (under 50%), orange (50–80%), or red (over 80%)

## Monitoring Async Agents and Cron Tasks

When background agents or scheduled tasks are running, counters appear in the info bar:

- **Async agents** — click to see agent names, task descriptions, elapsed time, and a kill button for each
- **Cron tasks** — click to see schedules, last/next run times, and a kill button for each

You can stop any background agent or cron task directly from the dashboard.

## Advanced Usage

### Custom Port

Set the `PI_PIDASH_PORT` environment variable before starting your first session:

```bash
export PI_PIDASH_PORT=9999
```

The dashboard will be available at `http://localhost:9999` instead of the default port 19190.

### Managing the Server

Use the `/pidash` command inside any pi session to manage the dashboard server:

```
/pidash status     # Check if the server is running
/pidash start      # Start the server
/pidash stop       # Stop the server
/pidash restart    # Restart the server
```

### Disabling Pidash

To prevent the dashboard from starting automatically:

```bash
export PI_PIDASH_ENABLE=false
```

### Accessing from Other Devices

The dashboard binds to `0.0.0.0`, so you can access it from any device on your local network using your machine's IP address:

```
http://192.168.1.x:19190
```

This is especially useful for monitoring sessions from a phone or tablet.

### Discord Bot Integration

You can bridge your dashboard to Discord for mobile monitoring and remote interaction. Create a file at `~/.pi/discord.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_ALLOWED_USERS=123456789,987654321
```

Once configured, restart the dashboard server. The bot provides:

- `/sessions` — list active sessions and tap a button to watch one
- `/status` — show info about the watched session
- `/stop` — interrupt the current agent operation
- **DM prompts** — send messages (including images and text files) directly to the watched session
- **Ask-user responses** — answer agent questions via Discord DM

> **Warning:** If you omit `DISCORD_ALLOWED_USERS`, the bot accepts DMs from anyone. Always set this in shared environments.

### Diff Viewer

When the diff viewer (Pidiff) is running, a "diff" link appears in the info bar. Click it to open the diff viewer in a new tab, showing git changes for the active session.

## Troubleshooting

**Dashboard shows "disconnected" (red dot in sidebar)**

The WebSocket connection to the server was lost. The dashboard reconnects automatically — wait a few seconds. If it persists, restart the server with `/pidash restart`.

**Session appears but shows no messages**

The session may have started before the dashboard. Send any message in that session's terminal to trigger event forwarding, or restart the session to replay its history.

**Dashboard won't start**

Check the server log for errors:

```bash
cat ~/.pi/pidash-server.log
```

Common issues include port conflicts (another process using port 19190) and missing dependencies on first run (the UI builds automatically, which can take up to 60 seconds).

**Notifications not appearing**

- Verify browser notification permission is granted (check browser settings)
- Ensure notifications are enabled in the dashboard sidebar settings (gear icon)
- Notifications are suppressed while the dashboard tab is focused and you're watching the active session

**Port already in use**

If another service uses port 19190, set a custom port:

```bash
export PI_PIDASH_PORT=9999
```

Then restart the server with `/pidash restart`.
