# Discord Bot

The pidash daemon can log in to Discord and act as a remote control for your Pi sessions: pick a session, send prompts and attachments, answer the agent's questions with buttons, and watch the turn stream back. There is no separate Discord service — the bot runs inside the pidash daemon and stays off unless a bot token is present.

## Prerequisites

- A running pidash daemon (`/pidash start`) — see [Using the Web Dashboard](using-the-web-dashboard.html)
- A Discord bot application with a token, and the **Message Content Intent** enabled
- The bot invited to your server with the `application.commands` scope if you want slash commands there

## Setup

### 1. Credentials

```env
# ~/.pi/discord.env
DISCORD_BOT_TOKEN=MTE...your.token.here...
DISCORD_ALLOWED_USERS=123456789012345678
```

`DISCORD_ALLOWED_USERS` is a comma-separated list of Discord user IDs.

**The bot fails closed.** If the allowlist is empty it refuses to start and says so in the log, because a token without an allowlist used to mean "anyone who can DM the bot controls your agent". If you genuinely want open access, set:

```env
DISCORD_ALLOW_ALL=true
```

Both `~/.pi/discord.env` and `~/.pi/discord-state.json` are tightened to `0600` on startup — they hold a token and your user IDs.

### 2. Restart the daemon

```text
/pidash restart
```

Credentials are read at startup only.

## Picking a session

| Command | What it does |
|---|---|
| `/sessions` | Paginated, ephemeral list of active sessions with buttons to watch one |
| `/watch session:<name>` | Watch a session by name, with autocomplete |
| `/status` | The watched session's model, branch, state and cwd |
| `/stop` | Interrupt the running turn |

`/sessions` is **ephemeral** — session names, branches and models are yours, not the channel's. Lists paginate 20 at a time, and the buttons never exceed Discord's five-row limit (the old bot produced six rows and Discord rejected the whole message once you had more than 20 sessions).

In a server, watching a session **creates a thread** named after it, so each session keeps its own history and several people can watch different sessions without sharing one stream. In DMs — or if thread creation fails — it falls back to the DM channel.

## Sending prompts

Once you are watching a session, the bot's thread or DM behaves like the Pi prompt:

- plain text is forwarded as a prompt
- attachments are handled per type (see below)
- `/stop` also works as a plain DM message

## Answering the agent

When the agent asks something, the question arrives with controls:

- **confirm prompts** (including dangerous-command approvals) get **Approve** / **Deny** buttons, and you can also reply `yes` / `no`
- **select prompts** get a dropdown, and you can also reply with `1`…`N`, the option text, or an unambiguous prefix
- **input prompts** take your text

Any prompt can be dismissed with `/cancel`. A prompt that is not answered **expires after 10 minutes** instead of silently consuming your next message, and pending prompts are never written to disk — a restart cannot leave one waiting.

## What you see while it works

- assistant output is posted as one message **edited as it streams** (throttled), rather than only arriving when the turn ends
- every tool call is announced (`🔧 bash — cargo test`), so a long command does not look like a hang
- messages sent from the TUI are echoed once; prompts you sent from Discord are not echoed back to you
- `/notify on` sends a DM when a turn finishes in a session you are *not* watching, with a Watch button — useful when Discord is your monitor rather than your remote

## Other commands

| Command | What it does |
|---|---|
| `/compact` | Compact the watched session's context |
| `/model [value]` | Show or switch the model |
| `/thinking [value]` | Show or set `off`…`max` |
| `/tasks` | Task list of the watched session |
| `/coms` | Coms peers of the watched session's project |
| `/memory` | Memory status of the watched session |
| `/diff` | Link to the session's diff viewer |
| `/file path:<rel>` | Send a file from the session's working directory |

`/file` is confined to the session cwd — `..` and absolute paths are refused, since this is a chat command, not a file server. Files up to 8MB are sent as Discord attachments.

## Attachments from Discord

| Kind | Behaviour |
|---|---|
| Images ≤ 8MB | forwarded to the agent as images |
| Text-like files ≤ 100KB | inlined into the prompt |
| Larger or binary files | named in the prompt, with the reason they were not included |

The image cap matters: the previous version had no limit and base64'd any image into memory and over the websocket.

## Troubleshooting

- **Bot never comes online:** `DISCORD_BOT_TOKEN` missing, or the allowlist is empty and `DISCORD_ALLOW_ALL` is not set — the log states which. Run `/pidash restart` after editing the file.
- **"Not authorized." in DM:** your ID is not in `DISCORD_ALLOWED_USERS`. You get exactly one reply, then silence.
- **Slash commands missing in a server:** commands are registered globally and per guild at startup, and again whenever the bot joins a guild; if they are still missing, check the `application.commands` invite scope.
- **"Not watching any session":** run `/sessions` or `/watch` first.
- **A prompt stalls:** it expires after 10 minutes; answer with the buttons or `/cancel` and retry.
- **No streaming edits:** very short turns are posted once at the end rather than edited mid-flight.

## Related Pages

- [Chat Clients (Signal, Telegram, …)](chat-clients.html) — the shared adapter contract this bot implements
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
