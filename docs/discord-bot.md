# Discord Bot

The pidash daemon can log in to Discord and act as a remote control for your Pi sessions: pick a session, send prompts and attachments, answer the agent's questions with buttons, and watch the turn stream back. There is no separate Discord service — the bot runs inside the pidash daemon and stays off unless a bot token is present.

## Prerequisites

- A running pidash daemon (`/pidash start`) — see [Using the Web Dashboard](using-the-web-dashboard.html)
- A Discord bot application with a token, and the **Message Content Intent** enabled
- The invite permissions: `Send Messages`, `Read Message History`, `Add Reactions`,
  and for threads/board `Create Public Threads` + `Send Messages in Threads`.
  Reaction intents (`⏹ 🔁 🗑`) are **not** portal toggles — the bot requests them in
  code; only *Message Content* is a privileged intent you must switch on
- The bot invited to your server with the `application.commands` scope if you want slash commands there
- Optional: a **forum channel** for `/board` (see [Forum session board](#forum-session-board))

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

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Enables the bot. Without it the integration stays off. |
| `DISCORD_ALLOWED_USERS` | empty | Comma-separated Discord user IDs allowed to control sessions. |
| `DISCORD_ALLOW_ALL` | `false` | Open access without an allowlist. Only for a bot nobody else can reach. |
| `DISCORD_PROMPT_TTL_MS` | `600000` | How long a pending agent question waits before expiring (min 30s, max 24h). |
| `DISCORD_FORUM_CHANNEL_ID` | unset | Forum channel used by `/board`. Unset leaves `/board` inactive with an instruction, nothing else changes. |
| `PIDASH_DISCORD_ENV_FILE` | `~/.pi/discord.env` | Where the credentials are read from. |
| `PIDASH_DISCORD_STATE_FILE` | `~/.pi/discord-state.json` | Where watches, threads and remembered prompts are kept (`0600`). |

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

## From a phone

Commands work **in a DM** as well as in a server — the bot registers them with the
`BotDM` and `PrivateChannel` contexts, and as a user-installable app an allowed
user can add PI without an admin. No server is required for a one-handed workflow.

`/status` is rendered as a card (session, state, model, branch, cwd, image
capability) with **link buttons**. Links point at the machine's LAN address and
are only offered when a phone can actually reach them — the dashboard listens on
all interfaces, while the diff viewer binds `127.0.0.1`, so its button is omitted
rather than being a dead link.

**React to a bot message** instead of typing — one tap, no keyboard:

| Reaction | Action |
|---|---|
| ⏹ or 🛑 | stop the watched session's current turn |
| 🔁 | resend the last prompt for that session (kept in the state file, capped at 4 000 chars) |
| 🗑 | delete the bot message |

A reaction on a message that does not belong to any watched session does nothing,
and an unrecognised emoji is ignored. The bot already requests the reaction
intents; the only portal toggle involved is *Message Content*.

**Right-click or long-press any message → Apps → "Ask PI about this"** sends that
message to the watched session as a prompt. A stack trace or a log line in any
channel becomes the task, without copying it.

Files you send are also copied into `<session cwd>/.pi/tmp/discord-inbox/`, and the
prompt carries the path — so the agent can open, re-read or move what your phone
uploaded with its normal file tools instead of receiving an opaque blob.

A reply **notifies once**, when it starts: the first message is sent normally and
every later delta arrives as a silent edit, so a long turn never buzzes per chunk.

## Forum session board

A Discord **forum channel** turns threads into titled posts. `/board` uses one as a
per-session home, so sessions stop competing for a single scrolling chat:

```text
# pi-sessions            ← forum channel
  ├─ pi-config          (post body: the session cwd)
  ├─ mtv-api-tests
  └─ rootcoz
```

Setup:

1. Create a **forum** channel (not a text channel) in your server, e.g. `pi-sessions`
2. Give the bot **Create Public Threads** and **Send Messages in Threads** there
3. Enable Developer Mode → right-click the channel → **Copy Channel ID**
4. Add it to `~/.pi/discord.env` and restart the bot:

```env
DISCORD_FORUM_CHANNEL_ID=123456789012345678
```

Then:

```
/board
```

It creates one post per active session that does not have one (title = session
name, body = the cwd), and replies with a picker. Choosing a session opens its post
and makes it your watch target, so that session's output lands there. The session
id is stored in the post's topic, so re-running `/board` reuses posts instead of
duplicating them.

The bot **never creates channels**: with no `DISCORD_FORUM_CHANNEL_ID`, `/board`
replies with that instruction and nothing else is affected.

## Sending prompts

Once you are watching a session, the bot's thread or DM behaves like the Pi prompt:

- plain text is forwarded as a prompt
- attachments are handled per type (see below)
- `/stop` also works as a plain DM message

## Answering the agent

Questions arrive with **attached controls**: approve/deny buttons for a confirm,
a dropdown for a choice, and an **Answer** button that opens a modal (multi-line,
paste-friendly) for free text. Typed replies still work — `yes`/`no`, a number,
the option text, or `/cancel` — but you should not have to type when a button
will do.

- **confirm prompts** (including dangerous-command approvals) get **Approve** / **Deny** buttons, and you can also reply `yes` / `no`
- **select prompts** get a dropdown, and you can also reply with `1`…`N`, the option text, or an unambiguous prefix
- **input prompts** get an **Answer** button that opens a modal; typing the reply also works

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
| `/board` | Forum session board — opens a thread per session (`DISCORD_FORUM_CHANNEL_ID`) |
| `/disconnect` | Stop watching everything — clears the watch, its threads and pending questions |
| `/model [value]` | Open a **model picker** (your current provider first), or switch directly by id |
| `/thinking [value]` | Show or set `off`…`max` |
| `/async` | Background async agents, with Stop buttons |
| `/cron` | Scheduled cron jobs, with Stop buttons |
| `/tasks` | Task list of the watched session |
| `/coms` | Coms peers of the watched session's project |
| `/memory` | Memory status of the watched session |
| `/diff` | Link to the session's diff viewer |
| `/file path:<rel>` | Send a file from the session's working directory |

`/file` is confined to the session cwd — `..` and absolute paths are refused, since this is a chat command, not a file server. Files up to 8MB are sent as Discord attachments.

## Attachments from Discord

| Kind | Behaviour |
|---|---|
| Images ≤ 8MB | forwarded to the agent as images — **only if the watched session's model accepts image input**; otherwise you are told they were not sent. A copy is written to `<session cwd>/.pi/tmp/discord-inbox/` and the prompt names the path |
| Text-like files ≤ 100KB | inlined into the prompt, and also saved to the inbox so the agent can read or move it |
| Larger or binary files | named in the prompt, with the reason they were not included |

The image cap matters: the previous version had no limit and base64'd any image into memory and over the websocket.

## Troubleshooting

- **Bot never comes online:** `DISCORD_BOT_TOKEN` missing, or the allowlist is empty and `DISCORD_ALLOW_ALL` is not set — the log states which. Run `/pidash restart` after editing the file.
- **"Not authorized." in DM:** your ID is not in `DISCORD_ALLOWED_USERS`. You get exactly one reply, then silence.
- **Slash commands missing in a server:** commands are registered globally and per guild at startup, and again whenever the bot joins a guild; if they are still missing, check the `application.commands` invite scope.
- **"Not watching any session":** run `/sessions` or `/watch` first.
- **A prompt stalls:** it expires after 10 minutes; answer with the buttons or `/cancel` and retry.
- **No streaming edits:** very short turns are posted once at the end rather than edited mid-flight.
- **"The application did not respond":** the daemon (and the bot inside it) is not running — start it with `/pidash start`. Check `~/.pi/logs/pidash-discord/<session>/main.log` for `bot connected`.
- **"This command is outdated":** your Discord client cached an older command definition. The bot only re-registers commands when their definitions change, so this clears after the client refreshes — restarting the Discord app forces it.
- **`/board` says no board is configured:** `DISCORD_FORUM_CHANNEL_ID` is not set, or the id is not a forum channel.
- **Reaction shortcuts do nothing:** the bot lacked the `Add Reactions` permission in that channel, or the message is not one of the bot's own.

## Related Pages

- [Chat Clients (Signal, Telegram, …)](chat-clients.html) — the shared adapter contract this bot implements
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
