# Discord Bot Notifications

Setting up the background Discord bot allows you to receive live event broadcasts, respond to agent prompts, and control running background sessions directly from your Discord client.

## Prerequisites
* Node.js package `discord.js` installed globally.
* A Discord Developer account with a registered bot application.
* Your personal Discord User ID.

## Quick Example

Create a `.pi/discord.env` file in your home directory to enable the bot:

```env
# ~/.pi/discord.env
DISCORD_BOT_TOKEN=MTE...your.token.here...
DISCORD_ALLOWED_USERS=123456789012345678
```

## Step-by-Step Setup

1. **Install the Discord library**
   The bot requires `discord.js` to run in the background. Install it globally:
   ```bash
   npm install -g discord.js
   ```

2. **Create the Discord App**
   Go to the Discord Developer Portal, create a new Application, and navigate to the **Bot** tab. Under **Privileged Gateway Intents**, enable the **Message Content Intent**. Generate and copy your bot token.

3. **Get your User ID**
   In Discord, enable Developer Mode in your Advanced settings. Right-click your profile and select **Copy User ID**.

4. **Configure the environment**
   Create the environment file at `~/.pi/discord.env` and populate it with your token and user ID (comma-separated for multiple users).

5. **Restart the daemon**
   Restart your background pi process so it picks up the new credentials. The daemon will automatically log in to Discord on startup.

## Interacting with the Bot

Once connected, you can interact with the bot in any server it is invited to or via Direct Messages.

### Slash Commands

The bot registers guild-scoped slash commands for instant control:

| Command | Description |
|---|---|
| `/sessions` | Lists all active background sessions. Click the interactive buttons to connect and start watching a session. |
| `/status` | Shows the model, branch, and active status of the session you are currently watching. |
| `/stop` | Sends an abort signal to interrupt the currently running agent. |

### Sending Prompts and Attachments

When you are "watching" a session via `/sessions`, you can interact with the agent directly in your Direct Messages.

* **Text Prompts:** Send a DM to the bot. It forwards your message to the running session as if you typed it in the terminal.
* **File Attachments:** Upload text files (under 100KB) or images directly in the DM. The bot automatically parses text file contents and encodes images for the agent.
* **Interactive Dialogs:** When an agent prompts you for a choice (like an ask-user dialog), the bot will DM you the options. Reply with the number or text to continue.

> **Tip:** The bot displays a typing indicator in Discord while the agent is processing a request, so you always know when it is actively working.

## Advanced Usage

### Handling Multiple Authorized Users

You can allow multiple team members to control background sessions by adding their User IDs to `DISCORD_ALLOWED_USERS`:

```env
# ~/.pi/discord.env
DISCORD_ALLOWED_USERS=111111111111111111,222222222222222222,333333333333333333
```

> **Warning:** Anyone not listed in this variable will receive a "Not authorized" response if they attempt to click buttons or use slash commands. If the variable is entirely omitted, *all* users are accepted (not recommended).

## Troubleshooting

* **Bot fails to start:** Check the background daemon logs. If you see `[discord] discord.js not installed`, verify your global npm install path is accessible to the daemon.
* **Slash commands not appearing:** Ensure your bot was invited to the server with the `application.commands` scope enabled in your OAuth2 URL generator.
* **No responses in DM:** Verify you are actively watching a session using `/sessions`. The bot ignores text messages if you are not tethered to an active background job.

For more information on configuring your global paths and environment variables, see [Configuration & Settings](configuration.html).

## Related Pages

- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
