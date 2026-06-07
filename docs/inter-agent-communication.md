# Communicating Between Pi Sessions

Enable multiple pi sessions to send messages to each other and collaborate on tasks — useful for patterns like a manager agent reviewing a coder agent's work, or distributing work across specialized agents.

## Prerequisites

- Two or more pi sessions running in the same project directory (or accessible via network)
- For `/coms-net`: [Bun](https://bun.sh) must be installed (used to run the hub server)

## Quick Example

Open two terminals in the same project directory.

**Terminal 1** — start a pi session and activate P2P communication:

```
/coms start --name reviewer --purpose "code reviewer"
```

**Terminal 2** — start another pi session and activate P2P communication:

```
/coms start --name coder --purpose "implements features"
```

The agent now has tools to list peers and send messages. Ask pi to "send a message to reviewer asking for feedback on the login module" and it will use the `coms_send` and `coms_await` tools automatically.

## Choosing Between P2P and Networked

| | P2P (`/coms`) | Networked (`/coms-net`) |
|---|---|---|
| **Transport** | Direct Unix socket connections | HTTP/SSE hub server |
| **Scope** | Same machine only | Same machine or across a LAN |
| **Setup** | No extra processes needed | Requires a hub server (auto-started) |
| **Server management** | None | Server auto-managed by `/coms-net start` |
| **Tool prefix** | `coms_*` | `coms_net_*` |
| **Best for** | Quick local multi-agent work | Teams, remote collaboration, persistent hubs |

Both systems can run simultaneously without conflicts.

## Setting Up P2P Communication (`/coms`)

### Step 1: Start coms in each session

Run this in each pi session that should participate:

```
/coms start --name <agent-name>
```

Available flags:

| Flag | Description |
|---|---|
| `--name <name>` | Agent name (auto-generated if omitted) |
| `--purpose <text>` | Short description of this agent's role |
| `--project <name>` | Project namespace for peer discovery (defaults to current directory) |
| `--color #RRGGBB` | Hex color for the pool widget |
| `--explicit` | Hide from auto-discovery (only reachable by exact name) |

### Step 2: Verify peers are visible

A pool widget appears below the editor showing connected peers with their names, models, and context usage.

You can also check status at any time:

```
/coms status
```

### Step 3: Send messages between agents

Ask pi to communicate with a peer naturally — for example: "ask the coder to implement a retry mechanism." Pi will use the communication tools (`coms_list`, `coms_send`, `coms_await`) automatically.

### Stop P2P communication

```
/coms stop
```

## Setting Up Networked Communication (`/coms-net`)

### Step 1: Start the hub and connect

```
/coms-net start --name <agent-name>
```

This automatically:

1. Starts a hub server (via Bun) if one isn't already running
2. Registers your session with the hub
3. Opens a real-time SSE connection for instant message delivery

Available flags (in addition to those listed for `/coms`):

| Flag | Description |
|---|---|
| `--port <number>` | Server port (OS picks a free port by default) |
| `--host <address>` | Server bind address (default: `127.0.0.1`) |

### Step 2: Connect additional sessions

In other terminals, run:

```
/coms-net start --name <another-name>
```

Additional sessions auto-discover the running server — no URL or token configuration needed for local use.

### Connecting to an existing server

If a hub is already running (started by another session or manually), connect without starting a new one:

```
/coms-net connect --name <agent-name>
```

To connect to a remote server:

```
/coms-net connect --name <agent-name> --url http://host:port --auth-token <token>
```

### Disconnecting vs stopping

| Command | Effect |
|---|---|
| `/coms-net disconnect` | Disconnect from the hub but leave the server running (for sessions that used `connect`) |
| `/coms-net stop` | Disconnect and shut down the hub server (for the session that used `start`) |

### Check status

```
/coms-net status
```

Shows whether coms-net is active, the server URL, and whether this session started the server.

## The Coms Feature Manager Pattern

For structured multi-agent workflows, generate a project-specific coms feature manager prompt:

```
/create-coms-feature-manager
```

This creates a `.pi/prompts/coms-feature-manager.md` file customized for your project. The pattern sets up:

- A **manager** agent that reviews code and directs implementation
- A **coder** agent that implements changes and responds to feedback
- A review → feedback → fix → re-review loop over coms

After generating the prompt, run `/reload`, then start a coms session and use `/coms-feature-manager` to activate the manager role.

## Available Tools

When coms is active, pi gains these tools (used automatically based on your requests):

| Action | P2P Tool | Networked Tool |
|---|---|---|
| List connected peers | `coms_list` | `coms_net_list` |
| Send a message to a peer | `coms_send` | `coms_net_send` |
| Poll for a reply (non-blocking) | `coms_get` | `coms_net_get` |
| Wait for a reply (blocking, ESC to cancel) | `coms_await` | `coms_net_await` |

> **Tip:** You don't need to call these tools directly. Just tell pi what you want — for example, "ask the reviewer to check my changes" — and it will use the right tools.

## Advanced Usage

### Project isolation

Sessions are scoped by project namespace. By default, the project is derived from the current working directory. Sessions in different directories won't see each other.

To override the project namespace:

```
/coms start --name agent1 --project my-shared-project
```

### Running the coms-net hub server manually

Instead of letting `/coms-net start` auto-manage the server, you can run it yourself:

```bash
bun ~/.pi/agent/git/github.com/myk-org/pi-config/extensions/coms/upstream-coms/coms-net-server.ts
```

Then connect sessions with `/coms-net connect`.

### LAN access

By default, the hub binds to `127.0.0.1` (localhost only). To allow connections from other machines:

1. Set an explicit auth token (required for non-loopback binds):

   ```bash
   export PI_COMS_NET_AUTH_TOKEN="your-secret-token"
   ```

2. Start with `--host 0.0.0.0`:

   ```
   /coms-net start --name agent1 --host 0.0.0.0 --port 9000
   ```

3. On remote machines, connect with the server URL and token:

   ```
   /coms-net connect --name agent2 --url http://<server-ip>:9000 --auth-token your-secret-token
   ```

> **Warning:** Always set `PI_COMS_NET_AUTH_TOKEN` when binding to non-loopback addresses. The server refuses to start on `0.0.0.0` without an explicit token.

### Hiding agents from discovery

Use `--explicit` to create agents that are only reachable by exact name — they won't appear in peer listings unless the caller passes `include_explicit=true`:

```
/coms start --name secret-agent --explicit
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_COMS_TIMEOUT_MS` | `1800000` (30 min) | P2P message response timeout |
| `PI_COMS_MAX_HOPS` | `5` | Maximum message forwarding hops (P2P) |
| `PI_COMS_PING_INTERVAL_MS` | `10000` | Peer health check interval (P2P) |
| `PI_COMS_NET_AUTH_TOKEN` | auto-generated | Bearer token for coms-net hub authentication |
| `PI_COMS_NET_HOST` | `127.0.0.1` | Hub server bind address |
| `PI_COMS_NET_PORT` | `0` (auto) | Hub server port |
| `PI_COMS_NET_SERVER_URL` | auto-discovered | Override hub server URL for clients |
| `PI_COMS_NET_MAX_HOPS` | `5` | Maximum message forwarding hops (networked) |
| `PI_COMS_NET_MESSAGE_TTL_MS` | `1800000` (30 min) | Message TTL on the hub |
| `PI_COMS_NET_HEARTBEAT_MS` | `10000` | Client heartbeat interval |
| `PI_COMS_NET_STALE_AFTER_MS` | `30000` | Time without heartbeat before agent marked stale |
| `PI_COMS_NET_OFFLINE_AFTER_MS` | `60000` | Time without heartbeat before agent marked offline |

### Hop limits and message forwarding

Messages include a hop counter that increments each time a message is forwarded between agents. This prevents infinite loops when agents forward messages to each other. The default limit is 5 hops — if reached, the send fails with a "hop limit reached" error.

### Reload resilience

Both `/coms` and `/coms-net` survive `/reload`. When you reload pi's configuration, the communication session is automatically re-established with the same flags. You don't need to re-run `/coms start` or `/coms-net start`.

## Troubleshooting

**Peers not visible after starting coms:**
- Ensure both sessions are in the same project directory (or use `--project` to set the same namespace)
- Run `/coms status` to confirm coms is active
- P2P sessions must be on the same machine

**`coms-net: failed to start server. Is Bun installed?`**
- Install Bun: `curl -fsSL https://bun.sh/install | bash`
- Bun is required for the coms-net hub server (already included in the Docker container)

**`coms-net: no auth token`**
- For local use, the token is auto-generated and stored in `~/.pi/coms-net/projects/<project>/server.secret.json`
- For remote connections, set `PI_COMS_NET_AUTH_TOKEN` or pass `--auth-token`

**Agent name collisions:**
- If a name is already taken, a numeric suffix is added automatically (e.g., `coder` becomes `coder2`)
- Use unique `--name` values across sessions to avoid this

**Stale peers in the pool widget:**
- Stale entries from crashed sessions are cleaned up automatically on session start
- Run `/coms` or `/coms-net` (bare command) to force-refresh the pool widget

See [Slash Commands and Extension Commands Reference](commands-reference.html) for the full `/coms` and `/coms-net` command syntax. See [Configuration and Environment Variables Reference](configuration-reference.html) for all environment variable details. See [Orchestrator Rules Reference](rules-reference.html) for the coms protocol rules that govern how the orchestrator interacts with coms tools.

## Related Pages

- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Orchestrator Rules Reference](rules-reference.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
