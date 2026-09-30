# Using the Web Dashboard

Monitor multiple active terminal sessions, interact with background tasks, and perform visual code reviews without leaving your workflow. Using the local React UI allows you to manage long-running agents and inspect git diffs across multiple projects from a single browser window.

- **Prerequisites:**
  - An active Terminal UI (TUI) session (the web features cannot be launched from CLI-only modes).
  - Port `19190` available on your machine (the default port for the global dashboard).

## Quick Example

Start the global dashboard directly from your active TUI session:

```text
/pidash start
```

Once the background server launches, the TUI status line shows a clickable `pi-dash` link to `http://localhost:<pidash_port>`. Click the label or open that URL in your web browser to manage your workspace.

## Step-by-Step Guide

1. **Launch the Dashboard:** Run the `/pidash start` command inside your active session. The background server will initialize and establish a WebSocket connection with your terminal.
2. **Navigate Sessions:** Open the dashboard URL in your browser. The interface displays a list of all active sessions across your system. Clicking a session name switches the dashboard to that session's live stream; the `sessions` dropdown in the info bar additionally loads the current project's saved session files and can switch the terminal itself onto one.
3. **Adjust Agent Settings:** The info bar at the bottom has two dropdowns. The model dropdown lists every model your `modelRegistry` reports as available (each row shows its provider) and switches the session to the one you pick. The thinking-level dropdown appears only for reasoning-capable models and sets the level directly. Both changes are applied to the running terminal session immediately. The same bar also shows token counts, context-window usage, the git branch, and links to the project's diff viewer.
4. **Monitor Background Tasks:** The `⏳ N async` and `⏰ N crons` popovers list running async agents and scheduled cron jobs with per-item **Kill** buttons, plus **Kill All** when more than one is present.
5. **Send Prompts:** You can type prompts directly into the web UI, including images. The dashboard forwards them to the watched session as follow-up instructions for the agent. Slash commands registered by extensions show up in the input bar's command palette, `ask_user` prompts render inline and accept answers, and queued prompts wait for the current turn to finish. **Stop** (or the `abort` keybinding) interrupts the running turn.
6. **Rename a Session:** Hover a session in the sidebar and click the pencil icon to rename it in place (`Enter` to save, `Esc` to cancel).
7. **Stop the Dashboard:** When you are finished, shut down the web server by running `/pidash stop` in your terminal.

## Advanced Usage

### Dashboard vs. Diff Viewer

The project uses two distinct web interfaces depending on what you need to accomplish:

| Feature | `/pidash` (Web Dashboard) | `/pidiff` (Diff Viewer) |
|---------|---------------------------|-------------------------|
| **Scope** | Global (sees all active sessions) | Local (tied to the current project) |
| **Port Mapping** | Fixed (`19190` by default) | Dynamic (allocates a random free port) |
| **Primary Use** | Session switching, model/thinking config, background task monitoring | Visualizing git diffs, publishing inline code review comments |
| **Commands** | `/pidash start`, `/pidash stop`, `/pidash restart`, `/pidash status` | `/pidiff start`, `/pidiff stop`, `/pidiff restart`, `/pidiff status` |

### Using the Project Diff Viewer

While the main dashboard monitors your global state, the `pidiff` extension provides a dedicated interface for reviewing code changes within a specific repository. It runs a separate server to isolate project context.

Launch the diff viewer from your project session:

```text
/pidiff start
```

1. The TUI status line will display a clickable `pi-diff` label and dynamically allocated port for this specific project's diff viewer (`http://localhost:<port>`).
2. Click the `pi-diff` label or open the URL to inspect local git diffs side-by-side and annotate specific lines of code.
3. Once you publish review comments from the web UI, they are automatically injected into your TUI session as formatted instructions. The active agent will read the comments and begin resolving them.

To check the health and port of your active diff server at any time, run:

```text
/pidiff status
```

> **Tip:** If you need to forcefully reset the project diff viewer, run `/pidiff restart`. This kills the local server and allocates a new random port.

### Running in Containers

The pidash extension detects whether a session is running inside a container (it checks for `/.dockerenv` and `/run/.containerenv`) and shows a 📦 marker on that session in the dashboard. Ensure you expose the necessary ports when launching your container so your host machine's browser can connect:
- Map port `19190` for the global dashboard. Note that the daemon itself listens on `0.0.0.0`, so the mapping is what makes it reachable from the host.
- If using the diff viewer, map a specific port range and ensure your environment is configured to allow dynamic port allocation.

> **Note:** To disable the web dashboard extensions entirely in headless environments or CI pipelines, set `PI_PIDASH_ENABLE=false` and `PI_PIDIFF_ENABLE=false` in your environment variables (or set `pidash_enable: false` and `pidiff_enable: false` in `pi-config-settings.json`).

## Troubleshooting

- **Dashboard fails to start:** Check if another application is using port `19190`. You can change the port by setting the `PI_PIDASH_PORT` environment variable (or `pidash_port` in `pi-config-settings.json`) before starting your session.
- **Session not showing in UI:** Ensure your terminal is running in TUI mode. The web interface relies on the TUI's event hooks to synchronize state.
- **Cannot connect to diff viewer:** The `pidiff` server uses local lockfiles in your project's `.pi/tmp/` directory (`pidiff.port`, `pidiff.pid`) to track the active port. If the server becomes unresponsive or port conflicts occur, run `/pidiff stop` to clear the lockfiles before starting it again. If a crashed run left a `pidiff.spawning` guard behind, it is cleared automatically after `pidiff_stale_lock_timeout_ms` (default 60s).
- **Session controls greyed out:** a session that is not active is shown dimmed, and the info-bar controls are disabled. Start or activate the session in Pi first.

See [Installation & Quickstart](quickstart.html) to learn more about basic chat commands, or read [Managing Custom Agents](managing-custom-agents.html) to understand how background async tasks operate.

## Related Pages

- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Installation & Quickstart](quickstart.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Discord Bot Notifications](discord-bot.html)
- [Automating Code Reviews](automating-code-reviews.html)
