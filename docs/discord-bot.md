# Controlling Pi Sessions from Discord

Send prompts, answer agent questions, and monitor your pi sessions from anywhere — including your phone — by connecting a Discord bot to the pidash server.

## Prerequisites

- A running pidash server (see [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html))
- A Discord account with a server you control
- `discord.js` installed (included in pi-config's dependencies by default)

## Quick Start

```bash
# Create the Discord configuration file
cat > ~/.pi/discord.env << 'EOF'
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_ALLOWED_USERS=your-discord-user-id
EOF

# Restart the pidash server to pick up the new config
/pidash restart
```

Once connected, open a DM with your bot in Discord and type `/sessions` to see your active pi sessions.

## Step-by-Step Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g., "pi-agent")
3. Go to **Bot** → click **Reset Token** → copy the token
4. Enable **Message Content Intent** under **Privileged Gateway Intents**
5. Go to **OAuth2 > URL Generator** → select scope `bot` → select these permissions:
   - Send Messages
   - Read Message History
   - Add Reactions
   - View Channels
6. Open the generated URL in your browser → add the bot to your server

### 2. Find Your Discord User ID

1. In Discord, go to **Settings > Advanced** and turn on **Developer Mode**
2. Right-click your own username anywhere in Discord
3. Click **Copy User ID**

### 3. Configure the Bot

Create `~/.pi/discord.env` with your bot token and user ID:

```bash
cat > ~/.pi/discord.env << 'EOF'
DISCORD_BOT_TOKEN=MTIz...your-bot-token
DISCORD_ALLOWED_USERS=123456789012345678
EOF
```

To allow multiple users, separate IDs with commas:

```
DISCORD_ALLOWED_USERS=123456789012345678,987654321098765432
```

> **Note:** These variables can also be set in your regular environment instead of `~/.pi/discord.env`. The pidash server reads the env file at startup and loads any variables not already set in the environment.

### 4. Start the Bot

Restart the pidash server so it picks up the new configuration:

```
/pidash restart
```

The bot logs in automatically. Check the pidash log for confirmation:

```
[discord] bot connected as pi-agent#1234
[discord] allowed users: 123456789012345678
```

## Using Discord Slash Commands

The bot registers three slash commands in every Discord server it joins. These are available immediately — no propagation delay.

| Command | Description |
|---------|-------------|
| `/sessions` | List all active pi sessions with interactive buttons |
| `/status` | Show details of the session you're currently watching |
| `/stop` | Interrupt the current agent (equivalent to pressing Esc in the terminal) |

### Listing and Watching Sessions

Type `/sessions` in any channel where the bot is present. The bot responds with a list of all active sessions and a button for each one:

- **Blue buttons** — active, idle sessions
- **Green button** — the session you're currently watching
- **Red "Disconnect" button** — stop watching all sessions

Tap a session button to start watching it. The bot's activity status updates to show the session name and model.

### Checking Session Status

Use `/status` to see details about the session you're watching:

- Project name and working directory
- Current model
- Git branch
- Active/idle status
- Whether it's running in a container

## Sending Prompts via DM

Once you're watching a session, open a DM with the bot. Any text you send is forwarded directly to the watched pi session as a user prompt — exactly as if you typed it in the terminal.

```
Refactor the auth middleware to use JWT tokens instead of session cookies
```

The bot shows a typing indicator while pi is processing your prompt. When the assistant responds, the full response text is forwarded back to your DM.

> **Tip:** User messages sent from the TUI terminal also appear in your Discord DM (prefixed with `▶ USER:`), so you can follow along from Discord even when someone else is typing in the terminal.

### Sending Images

Attach an image to your DM message. The bot downloads it, converts it to base64, and forwards it to the pi session alongside any text you include. This works for screenshots, diagrams, or any visual context pi's model can interpret.

### Sending Text Files

Attach text files (`.txt`, `.md`, `.json`, `.py`, `.ts`, `.go`, `.yaml`, `.sh`, and many more) to your DM. The bot reads files under 100KB and appends their contents to your prompt. Binary files or files over 100KB are mentioned but not included.

### Using /stop in DMs

Type `/stop` as a plain DM message to interrupt the current agent. This works the same as the `/stop` slash command.

## Receiving ask_user Prompts

When pi's `ask_user` tool presents a question (approvals, selections, confirmations), the bot forwards it to your DM. You see:

- The question text in bold
- Numbered options (if applicable)
- A prompt to reply with your choice

Reply with the option number or type a free-text response. Your answer is sent back to the pi session, resolving the dialog.

> **Note:** The `ask_user` dialog races between the TUI and Discord — whichever responds first wins. If someone answers in the terminal, the Discord prompt becomes stale.

## Advanced Usage

### Multiple Users

Each Discord user has independent state — they can watch different sessions simultaneously. User state includes:

- Which session they're watching
- Their DM channel for responses
- Any pending `ask_user` dialog

State persists across pidash restarts (stored in `~/.pi/discord-state.json`), so you don't lose your watched session if the daemon restarts.

### Bot Activity Display

The bot's Discord "activity" shows the name and model of the currently watched session (displayed as "Watching project-name (model-name)"). This gives you an at-a-glance view of what the bot is connected to.

### How Events Flow

The Discord bot runs inside the pidash server daemon — no separate process, no extra ports to open:

1. **Discord app** (phone/desktop) connects outbound to Discord's cloud API
2. **Discord cloud** routes messages to the pidash server's bot client
3. **Pidash server** has direct access to all connected pi sessions
4. **Pi sessions** send events back through the same path

No inbound ports need to be opened. The bot initiates all connections to Discord's API.

### Echo Suppression

When you send a prompt from Discord, the bot suppresses the echo of your own message that would normally appear when pi receives it. You only see the assistant's response, not a duplicate of what you typed.

### Forwarded Event Types

The bot forwards these events from your watched session to your Discord DM:

| Event | What You See |
|-------|-------------|
| User message (from TUI) | `▶ USER: <message text>` |
| Assistant response complete | Full response text (chunked to fit Discord's 2000-char limit) |
| `ask_user` dialog | Question + numbered options |
| Agent working | Typing indicator in DM |

## Security Considerations

> **Warning:** If you omit `DISCORD_ALLOWED_USERS`, the bot accepts DMs from **anyone** who can message it. Always set this variable, especially in shared environments.

- **`DISCORD_ALLOWED_USERS`** is checked on every interaction — slash commands, button clicks, and DM messages. Unauthorized users receive a "Not authorized" response.
- The bot token grants full control over your pi sessions to allowed users — treat it like a password.
- Store `~/.pi/discord.env` with restrictive file permissions (`chmod 600`).
- Slash commands are registered per-guild (Discord server), so they only appear in servers the bot has joined.
- The bot only processes DMs (`d.guild_id` is checked) — messages in server channels are ignored for prompt forwarding.

```bash
# Lock down the config file
chmod 600 ~/.pi/discord.env
```

## Troubleshooting

**Bot doesn't connect:**
- Check `~/.pi/pidash-debug.log` for `[discord]` entries
- Verify `DISCORD_BOT_TOKEN` is correct in `~/.pi/discord.env`
- Confirm `discord.js` is installed (`npm list discord.js` in the pi-config package directory)

**Slash commands don't appear:**
- The bot registers commands per-guild on startup. If you added the bot to a new server, restart pidash: `/pidash restart`
- Guild-scoped commands are available immediately (no propagation delay unlike global commands)

**"Not authorized" on every interaction:**
- Double-check your Discord user ID in `DISCORD_ALLOWED_USERS` — it should be a numeric snowflake ID, not your username
- Make sure there are no extra spaces or quotes around the ID

**Messages not forwarded to DM:**
- You must be watching a session first — use `/sessions` and tap a button
- The watched session must be active and connected to pidash

**Bot shows "Watched session is disconnected":**
- The pi session you were watching has ended. Use `/sessions` to pick a new one

For pidash server management, see [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html). For all Discord-related environment variables, see [Configuration and Environment Variables Reference](configuration-reference.html).

## Related Pages

- [Using the Web Dashboard and Diff Viewer](dashboards-and-diffs.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
