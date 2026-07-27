# Daemon & Websocket Networking

Modern project automations require continuous background work, real-time UI updates, and isolated execution scopes. `pi-config` achieves this through a robust inter-process communication (IPC) architecture built on background daemons, WebSockets, and asynchronous LLM states.

Understanding this networking architecture is crucial if you are troubleshooting port collisions, monitoring background agent execution, or trying to understand how the web dashboard stays perfectly in sync with your terminal session.

## The Big Picture: Architecture & Data Flow

The architecture is divided into three distinct layers that communicate over WebSockets and file-system watchers.

| Layer | Responsibility | State Location |
|-------|----------------|----------------|
| **Interactive Client (`pi`)** | Triggers workflows, intercepts terminal events, and routes subagent requests. | In-memory, per-terminal session. |
| **Daemon Servers** | Centralized hubs (like `pidash-server` and `pidiff-server`) that aggregate data from multiple interactive clients. | Runs in background; tracks state in `.pi/tmp/` lockfiles. |
| **Web Dashboard** | Subscribes to the daemon via WebSockets to visualize diffs, prompts, and agent activity. | Browser UI. |

**The WebSocket Data Flow:**
1. You run a command in the `pi` terminal.
2. The active extension (e.g., `pidash.ts`) checks the lockfile in `.pi/tmp/` to see if a daemon is running.
3. If no daemon exists, it spawns one dynamically via `daemon-manager.ts` and waits for it to bind to a free port.
4. The `pi` client connects to the daemon's WebSocket and begins buffering and forwarding terminal events (prompts, git status, agent logs).
5. The local React dashboard connects to the same daemon, instantly receiving the buffered real-time events.

## Key Concepts

### Daemon Management & Lifecycle
Daemons in this project are long-lived, per-project background Node servers.
- **Auto-Spawning:** Tools like the web dashboard will automatically spawn their required daemon (e.g., `pidash-server.ts`) upon initialization.
- **Lockfiles & Ports:** Daemons track their active Process ID (PID) and port dynamically in `.pi/tmp/` (e.g., `.pi/tmp/pidiff.pid`, `.pi/tmp/pidiff.port`). This prevents port collisions between different projects.
- **Health Checks:** Interactive clients periodically ping the daemon's HTTP endpoints. If the daemon crashes, the client gracefully buffers outgoing events and attempts a respawn.

### Async Agent States
When you run complex tasks that take a long time, the orchestrator delegates them to asynchronous "subagent children."
- **Isolated Execution:** Each async task spins up a detached `pi` child process with a unique `PI_SUBAGENT_CHILD=1` flag.
- **Zombie Cleanup:** The daemon orchestrator tracks the parent PID and start time. If the parent process crashes or is killed abruptly, the daemon sweeps through and eliminates any lingering "zombie" child processes to free system resources.
- **Persistent Context:** Async tasks write their ongoing context, system prompts, and completion results into isolated project-scoped folders under `.pi/tmp/worker-<id>/`.

### The WebSocket Bridge
Because the LLM providers stream their output chunk-by-chunk, `pi-config` relies on WebSockets rather than REST APIs to bridge the gap between the LLM and the UI.
- All real-time text generations are emitted as local events inside the `pi` core.
- Extension hooks intercept these events and forward them via WebSocket.
- The web UI maintains active WebSocket listeners, updating the browser DOM iteratively as each token arrives.

## How it Affects the User

The internal daemon and networking logic drives several distinct behaviors you might notice while working in your project:

- **Instant Reconnections:** If you refresh your web browser or close your laptop and reopen it, the dashboard instantly catches up. This happens because the daemon acts as a central buffer, storing recent events until the UI reconnects.
- **Cross-Terminal Syncing:** You can run `pi` in multiple terminal panes, and the shared `pidash` daemon will aggregate all of their activity into a single unified web dashboard.
- **Temporary File Accumulation:** You will occasionally notice `.pi/tmp/` populating with debug logs, worker folders, and JSON state files. The system automatically prunes these over time, but they remain highly useful for investigating failed async agent runs.
- **Graceful Degradation:** If the daemon fails to spawn (due to strict firewalls or extreme system load), your terminal session will not crash. The interactive UI continues working normally, simply logging that real-time features are currently disconnected.

## Related Pages
- [Using the Web Dashboard](using-the-web-dashboard.html) — See how to view the real-time WebSocket data in the local React UI.
- [Configuration & Settings](configuration.html) — Learn how to tweak project settings that interact with daemon behavior.
- [Memory Architecture](memory-architecture.html) — Understand how the data gathered by background agents is permanently embedded into your project.

## Related Pages

- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Neovim Integration](neovim-integration.html)
- [Discord Bot Notifications](discord-bot.html)
