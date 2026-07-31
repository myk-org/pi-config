# ~/.pi/discord.env
DISCORD_BOT_TOKEN=MTE...your.token.here...
DISCORD_ALLOWED_USERS=123456789012345678
```

Start the dashboard daemon from Pi:

```text
/pidash start
```

Then, in Discord, run `/sessions`, pick a session, and continue the conversation in a DM with the bot.

## Step-by-Step

### 1. Create the Discord credentials file

```env
# ~/.pi/discord.env
DISCORD_BOT_TOKEN=MTE...your.token.here...
DISCORD_ALLOWED_USERS=123456789012345678
```

`DISCORD_BOT_TOKEN` enables the bot. `DISCORD_ALLOWED_USERS` is optional, but recommended, and accepts a comma-separated list of Discord user IDs.

### 2. Create and configure the Discord bot

Set up your bot in the Discord Developer Portal, then:

- copy the bot token
- enable **Message Content Intent**
- invite the bot to your server with the `application.commands` scope if you want slash commands there

If you only want DM-based control, the bot can still work without using server chat for prompts.

### 3. Start or restart the pidash daemon

```text
/pidash start
```

If pidash is already running, restart it so it reloads the Discord credentials:

```text
/pidash restart
```

The Discord integration is attached to the pidash daemon, so the bot logs in when pidash starts.

> **Note:** If you are already using the web dashboard, you do not need a separate Discord-specific service. The same pidash daemon handles both.

### 4. Choose a session from Discord

Use these slash commands in a Discord server where the bot is present:

| Command | What it does |
|---|---|
| `/sessions` | Lists active Pi sessions and shows buttons to connect or disconnect |
| `/status` | Shows the currently watched session, model, branch, and current state |
| `/stop` | Sends an interrupt to the watched session |

A typical flow is:

1. Run `/sessions`
2. Click the session you want to watch
3. Open a DM with the bot
4. Send prompts there

### 5. Send prompts from Discord DMs

Once you are watching a session, send a DM to the bot just like you would type into Pi.

- Plain text messages are forwarded as prompts
- If the agent asks a question, reply in the same DM
- `/stop` also works as a DM message

Use this split to stay oriented:

| Use Discord server slash commands for | Use Discord DMs for |
|---|---|
| picking a session | sending prompts |
| checking status | replying to agent questions |
| sending stop signals | uploading files or images |

### 6. Send attachments when needed

You can DM attachments to the bot along with your prompt.

Supported behavior:

- text-like files under 100KB are inlined into the prompt
- images are forwarded for the agent to inspect
- larger or binary files are only mentioned, not embedded

This is useful for quick log review, screenshots, small configs, or error snippets.

> **Tip:** If you want the agent to focus on an uploaded file, include a short instruction in the same DM, such as “Review this log and summarize the failure.”

## Advanced Usage

### Authorize multiple people

```env
# ~/.pi/discord.env
DISCORD_ALLOWED_USERS=111111111111111111,222222222222222222,333333333333333333
```

Use this when a small team needs access to the same running sessions.

> **Warning:** If `DISCORD_ALLOWED_USERS` is omitted, the bot accepts DMs from any user who can reach it. Set this variable unless you intentionally want open access.

### Understand how “watching” works

The bot only forwards prompts to the session you are currently watching. If you switch sessions in Discord, new prompts go to the newly selected one.

This makes it easy to keep one DM thread per active task without guessing where your next message will land.

### Use the bot with agent questions

If the running agent triggers an interactive choice, the bot forwards that prompt into your DM and waits for your reply. You can respond with either:

- a number, when options are listed
- free text, when the prompt expects a typed answer

### Change the pidash port if needed

If port `19190` is already taken, configure pidash with either:

- `PI_PIDASH_PORT`
- `pidash_port` in project settings

Then start pidash again. See [Using the Web Dashboard](using-the-web-dashboard.html) and [Configuration & Settings](configuration.html) for details.

## Troubleshooting

- **Bot does not come online:** Make sure `DISCORD_BOT_TOKEN` is present in `~/.pi/discord.env`, then run `/pidash restart`.
- **Slash commands do not appear:** Confirm the bot was invited with the `application.commands` scope, then restart pidash so commands are registered again.
- **Your DM gets “Not watching any session”:** Run `/sessions` first and click a session button before sending prompts.
- **Another user cannot control the bot:** Add their Discord user ID to `DISCORD_ALLOWED_USERS`, comma-separated, then restart pidash.
- **Uploaded file does not seem to reach the agent:** Keep text files under 100KB for inline forwarding. Very large or binary files are only referenced, not embedded.

See [Using the Web Dashboard](using-the-web-dashboard.html) for details on starting and managing pidash. See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details on the kinds of long-running work you can monitor from Discord.

## Related Pages

- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
