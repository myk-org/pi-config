# Daemon & Websocket Networking

Background daemons and WebSockets keep your terminal session, browser dashboard, and long-running agents in sync without blocking your chat. Understanding this networking model helps when ports collide, a dashboard looks empty after a refresh, or an async agent keeps running after a crash.

## The Big Picture

Two complementary servers handle real-time UI and IPC. They share the same WebSocket patterns but differ in scope and how they pick ports.

| Component | Scope | Port | What users see |
|-----------|-------|------|----------------|
| **pidash** | Shared across all `pi` sessions on the machine | Fixed (default `19190`, overridable) | Global web dashboard — sessions, prompts, async status |
| **pidiff** | One instance per project working directory | Free port chosen at start | Project diff viewer with review comments |

| Layer | Role | Typical state |
|-------|------|----------------|
| **Interactive `pi` client** | Starts/stops daemons, forwards session events over WebSocket | In-memory per terminal |
| **Daemon HTTP + WebSocket server** | Aggregates clients, serves UI, health checks | Background Node process |
| **Browser UI** | Subscribes to the daemon for live updates | React app talking to `/ws/browser` |

**Typical connect flow:**

1. You start `pi` (or run `/pidash start` / `/pidiff start`).
2. The extension checks whether a healthy daemon already answers `/api/health`.
3. If not, it spawns the server script and waits until health checks succeed.
4. The terminal connects on `/ws/pi` and begins forwarding session events.
5. The browser connects on `/ws/browser` and receives the same live stream (plus buffered catch-up when needed).

> **Tip:** Check daemon health with `/pidash status` or `/pidiff status`. See [Using the Web Dashboard](using-the-web-dashboard.html) for day-to-day UI usage.

## Key Concepts

### Shared dashboard vs per-project diff server

**pidash** listens on a configured port (`pidash_port`, default `19190`). Every project session can attach to the same daemon, so one browser window can switch across terminals. Logs for spawn failures live under `~/.pi/pidash-server.log`.

**pidiff** binds a free local port for the current project and records that port (and PID when known) under the project’s `.pi/tmp/` directory as `pidiff.port` / `pidiff.pid`. That avoids collisions when several projects run diffs at once.

> **Note:** Toggle either server with `pidash_enable` / `pidiff_enable` (or their env vars). See [Configuration & Settings](configuration.html).

### Health checks, heartbeats, and reconnect

Clients probe `http://127.0.0.1:<port>/api/health` before trusting a daemon. WebSocket connections use ping/pong heartbeats; a missed pong forces reconnect. A periodic reconnect poller also re-attaches sessions that started before the daemon was ready.

While disconnected, the pidash client buffers recent events and replays them when the socket comes back — so a browser refresh usually catches up instead of starting blank.

### Async agent isolation

Long-running specialist work can spawn a detached child `pi` process with `PI_SUBAGENT_CHILD=1`. That flag tells extensions to skip UI mounts and other parent-only behavior so background work does not steal focus from your editor or chat.

Each job keeps status, prompts, and output under a unique directory in the project’s `.pi/tmp/` tree (named from the agent and a unique suffix). Results surface back to the parent session when the job finishes. For spawning, monitoring, and killing these jobs, see [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

### Event bridge to the browser

Token streams and tool activity originate inside the `pi` session. Extensions forward those events over the daemon WebSocket so the React UI can update live. The daemon also exposes session lists and other small HTTP APIs for the UI — the hot path for streaming remains WebSockets, not REST polling.

## How it Affects the User

- **Refresh without losing context:** Closing the laptop or reloading the dashboard usually reconnects to the same pidash daemon and replays buffered activity.
- **Multiple terminals, one dashboard:** Several `pi` sessions can share pidash; the UI lists them so you can jump between projects.
- **Project-local diffs:** Opening pidiff in repo A does not collide with repo B, because each project owns its lockfiles and port under `.pi/tmp/`.
- **Files appear under `.pi/tmp/`:** Expect job folders, result JSON, debug logs, and pidiff lockfiles. They are project-scoped working state, not source code — keep `.pi/` out of git (the installer can configure this; see [Installation & Quickstart](quickstart.html)).
- **Graceful degradation:** If a daemon cannot start (port busy, slow first compile, firewall), the terminal session keeps working; real-time dashboard features simply stay disconnected until `/pidash start` or `/pidiff start` succeeds.

> **Warning:** pidash requires TUI mode. Headless or non-UI invocations will not keep a dashboard connection.

## Related Pages

- [Using the Web Dashboard](using-the-web-dashboard.html) — Start, stop, and use pidash / pidiff day to day.
- [Configuration & Settings](configuration.html) — `pidash_port`, enable flags, and related env vars.
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — Spawn, monitor, and kill async agents that use this IPC path.
- [Installation & Quickstart](quickstart.html) — First-time install and daemon startup.

## Related Pages

- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Installation & Quickstart](quickstart.html)
- [Discord Bot Notifications](discord-bot.html)
- [Inter-Agent Communication Network](inter-agent-communication.html)
