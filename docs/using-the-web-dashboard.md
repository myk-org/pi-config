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

Once the background server launches, the TUI status line will display a clickable `pi-dash` label and web link (e.g., `🌐 http://localhost:19190`). Click the label or open this URL in your web browser to manage your workspace.

## Step-by-Step Guide

1. **Launch the Dashboard:** Run the `/pidash start` command inside your active session. The background server will initialize and establish a WebSocket connection with your terminal.
2. **Navigate Sessions:** Open the dashboard URL in your browser. The interface displays a list of all active sessions across your system. Clicking a session name will automatically switch your terminal's context to that project directory.
3. **Adjust Agent Settings:** Use the dropdowns in the web UI to change the active LLM provider or adjust the thinking level dynamically. Setting changes are immediately reflected in your terminal.
4. **Monitor Background Tasks:** View the status of asynchronous agents and scheduled cron jobs. If a background task is stuck, you can terminate it directly from the dashboard using the kill controls.
5. **Send Prompts:** You can type prompts directly into the web UI. The dashboard forwards these commands to your terminal session as follow-up instructions for the agent.
6. **Stop the Dashboard:** When you are finished, shut down the web server by running `/pidash stop` in your terminal.

## Advanced Usage

### Dashboard vs. Diff Viewer

The project uses two distinct web interfaces depending on what you need to accomplish:

| Feature | `/pidash` (Web Dashboard) | `/pidiff` (Diff Viewer) |
|---------|---------------------------|-------------------------|
| **Scope** | Global (sees all active sessions) | Local (tied to the current project) |
| **Port Mapping** | Fixed (`19190` by default) | Dynamic (allocates a random free port) |
| **Primary Use** | Session switching, agent config, background task monitoring | Visualizing git diffs, publishing inline code review comments |
| **Commands** | `/pidash start\|stop\|restart\|status` | `/pidiff start\|stop\|restart\|status` |

### Using the Project Diff Viewer

While the main dashboard monitors your global state, the `pidiff` extension provides a dedicated interface for reviewing code changes within a specific repository. It runs a separate server to isolate project context.

Launch the diff viewer from your project session:

```text
/pidiff start
```

1. The TUI status line will display a clickable `pi-diff` label and dynamically allocated port for this specific project's diff viewer.
2. Click the `pi-diff` label or open the URL to inspect local git diffs side-by-side and annotate specific lines of code.
3. Once you publish review comments from the web UI, they are automatically injected into your TUI session as formatted instructions. The active agent will read the comments and begin resolving them.

To check the health and port of your active diff server at any time, run:

```text
/pidiff status
```

> **Tip:** If you need to forcefully reset the project diff viewer, run `/pidiff restart`. This kills the local server and allocates a new random port.

### Running in Containers

The web dashboard automatically detects if your session is running inside a Docker or Podman container. Ensure you expose the necessary ports when launching your container so your host machine's browser can connect:
- Map port `19190` for the global dashboard.
- If using the diff viewer, map a specific port range and ensure your environment is configured to allow dynamic port allocation.

> **Note:** To disable the web dashboard extensions entirely in headless environments or CI pipelines, set `PI_PIDASH_ENABLE=false` and `PI_PIDIFF_ENABLE=false` in your environment variables (or set `pidash_enable: false` and `pidiff_enable: false` in `pi-config-settings.json`).

## Troubleshooting

- **Dashboard fails to start:** Check if another application is using port `19190`. You can change the port by setting the `PI_PIDASH_PORT` environment variable (or `pidash_port` in `pi-config-settings.json`) before starting your session.
- **Session not showing in UI:** Ensure your terminal is running in TUI mode. The web interface relies on the TUI's event hooks to synchronize state.
- **Cannot connect to diff viewer:** The `pidiff` server uses local lockfiles in your project's `.pi/tmp/` directory to track active ports. If the server becomes unresponsive or port conflicts occur, run `/pidiff stop` to clear the lockfiles before starting it again.

See [Installation & Quickstart](quickstart.html) to learn more about basic chat commands, or read [Managing Custom Agents](managing-custom-agents.html) to understand how background async tasks operate.

## Related Pages

- [Configuration & Settings](configuration.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
