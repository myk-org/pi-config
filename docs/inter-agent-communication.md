# Communicating Between Pi Sessions

Coordinate work across multiple pi sessions by enabling them to discover each other, exchange messages, and delegate tasks — useful for multi-agent workflows like manager/coder splits, parallel code review, and collaborative feature development.

## Prerequisites

- Two or more pi sessions running in the same project directory (or on the same machine for P2P)
- For networked mode (`/coms-net`): [Bun](https://bun.sh) installed (used to run the hub server)

## Quick Example

Open two terminals in the same project directory. In the first:

```
/coms start --cname reviewer --purpose "Code reviewer"
```

In the second:

```
/coms start --cname coder --purpose "Feature implementer"
```

Now either agent can ask pi to send a message to the other. The orchestrator uses the `coms_send` tool to send prompts and `coms_await` to wait for replies. A live pool widget appears below the editor showing connected peers with their context usage.

## Choosing Between P2P and Networked Mode

| | P2P (`/coms`) | Networked (`/coms-net`) |
|---|---|---|
| Transport | Direct Unix sockets between sessions | HTTP/SSE hub server |
| Scope | Same machine only | Same machine or across a network |
| Server required | No | Yes (auto-started by default) |
| Tool prefix | `coms_` | `coms_net_` |
| Best for | Quick local pairing | Multi-session teams, remote collaboration |

Both modes can run simultaneously in the same session. They use separate tool names so there's no conflict.

## Setting Up P2P Communication

### Starting

In each pi session, run:

```
/coms start --cname <agent-name> --purpose "<what this agent does>"
```

Available flags for `/coms start`:

| Flag | Description |
|---|---|
| `--cname` | Agent name (used by peers to address this session) |
| `--purpose` | Short description of the agent's role |
| `--project` | Project namespace for discovery (defaults to current directory) |
| `--color` | Hex color `#RRGGBB` for the pool widget |
| `--explicit` | Hide from auto-discovery (only addressable by exact name) |

> **Note:** The project namespace defaults to the current working directory. Sessions in different directories won't see each other unless you set `--project` explicitly.

### Checking Status

```
/coms status
```

### Stopping

```
/coms stop
```

## Setting Up Networked Communication

Networked mode uses a hub server that sessions connect to. The server is auto-managed — `/coms-net start` launches one if none is running.

### Starting

```
/coms-net start --cname planner --purpose "Architecture planning"
```

This automatically:
1. Checks for a running hub server for the current project
2. Starts one if none is found (requires Bun)
3. Connects the session to the hub

Available flags for `/coms-net start`:

| Flag | Description |
|---|---|
| `--cname` | Agent name |
| `--purpose` | Short description of the agent's role |
| `--project` | Project namespace |
| `--color` | Hex color `#RRGGBB` |
| `--explicit` | Hide from auto-discovery |
| `--port` | Server port (default: OS picks a free port) |
| `--host` | Server bind address (default: `127.0.0.1`) |

### Connecting to an Existing Server

If another session already started the server, use `connect` instead of `start`:

```
/coms-net connect --cname coder --purpose "Feature implementer"
```

To connect to a remote server:

```
/coms-net connect --cname coder --url http://192.168.1.50:8080 --auth-token <token>
```

### Checking Status

```
/coms-net status
```

Shows whether coms-net is active, the server URL, and whether this session started the server.

### Disconnecting vs Stopping

- **`/coms-net disconnect`** — Disconnects from the server but leaves it running (use when you joined someone else's server)
- **`/coms-net stop`** — Disconnects and kills the server (use when you started the server)

> **Tip:** The server is shared — if Session A started it, Session B should use `disconnect`, not `stop`. Pi enforces this and shows a warning if you try the wrong one.

## Sending Messages Between Sessions

Once coms is active, pi's orchestrator has access to communication tools. You can ask pi to talk to a peer directly:

> "Ask the coder to implement the login form"

Or be explicit:

> "Use coms_send to ask reviewer to check the auth module"

### The Message Flow

1. **List peers** — Pi discovers available agents
2. **Send message** — Pi sends a prompt to the target peer
3. **Peer processes** — The target session receives the message as a follow-up and generates a response
4. **Receive reply** — The response is automatically returned to the sender

### How Replies Work

When a session receives an inbound message, it appears as:

```
[from reviewer @ /home/user/project] Please check the auth implementation
```

The receiving session writes its answer as a normal response. The coms extension automatically captures the assistant's output at the end of the turn and sends it back to the sender. No extra tool calls are needed to reply.

> **Warning:** Peers should never call `coms_send` to reply to an inbound message — that creates a new outbound conversation instead of a reply, leading to infinite ping-pong loops.

### Message Queue Behavior

Messages are processed in FIFO order. When a session is busy handling one message:

1. Additional incoming messages are queued, not dropped
2. After the current message is answered, the next one is automatically injected
3. Each message gets its own dedicated turn and response
4. Senders always get a reply — nothing is silently lost

## Delegating Structured Tasks

When coordinating multi-step work, use structured task delegation. This creates trackable tasks in the peer's task widget:

> "Send the coder these tasks: 1) Add JWT auth middleware for /api routes, 2) Write unit tests for the middleware"

Pi passes these as structured `tasks` alongside the message. The peer receives them as actionable items in their task tracking widget (requires `@tintinweb/pi-tasks`).

## The Feature Manager Pattern

A common multi-agent workflow pairs a **manager** (reviewer) session with a **coder** (implementer) session. The manager reviews work, provides feedback, and gates PR creation. The coder writes code and responds to feedback.

Generate a project-specific feature manager prompt with:

```
/create-coms-feature-manager
```

This creates a customized prompt at `.pi/prompts/coms-feature-manager.md` that defines the manager role, review workflow, and coder coordination protocol for your project.

## Advanced Usage

### Project Namespaces

Sessions are isolated by project namespace. By default, the namespace is derived from the working directory. To create a custom namespace shared across directories:

```
/coms start --cname agent-a --project my-team
```

All sessions using `--project my-team` will discover each other regardless of their working directory.

### Hidden Agents

Use `--explicit` to hide an agent from auto-discovery:

```
/coms start --cname secret-reviewer --explicit
```

Explicit agents don't appear in peer lists by default. Other sessions can still reach them by exact name. To include hidden agents when listing peers, pi uses the `include_explicit` parameter on the list tool.

### Hop Limits

Messages can chain between agents (A sends to B, B forwards to C). A hop counter prevents infinite forwarding. The default limit is 5 hops, configurable via the `PI_COMS_MAX_HOPS` environment variable (P2P) or `PI_COMS_NET_MAX_HOPS` (networked).

### Network Configuration for coms-net

For LAN access, bind the server to all interfaces:

```
/coms-net start --host 0.0.0.0 --port 9000
```

> **Warning:** When binding to a non-loopback address, you must set the `PI_COMS_NET_AUTH_TOKEN` environment variable explicitly. The server refuses to start on a public interface without an explicit token for security.

Remote sessions connect with:

```
/coms-net connect --url http://<server-ip>:9000 --auth-token <token>
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PI_COMS_MAX_HOPS` | `5` | Maximum message forwarding hops (P2P) |
| `PI_COMS_TIMEOUT_MS` | `1800000` (30 min) | Response timeout (P2P) |
| `PI_COMS_PING_INTERVAL_MS` | `10000` | Peer health check interval (P2P) |
| `PI_COMS_NET_MAX_HOPS` | `5` | Maximum message forwarding hops (networked) |
| `PI_COMS_NET_MESSAGE_TTL_MS` | `1800000` (30 min) | Message time-to-live (networked) |
| `PI_COMS_NET_HEARTBEAT_MS` | `10000` | Heartbeat interval (networked) |
| `PI_COMS_NET_HOST` | `127.0.0.1` | Server bind address |
| `PI_COMS_NET_PORT` | `0` (auto) | Server port |
| `PI_COMS_NET_AUTH_TOKEN` | Auto-generated | Bearer token for hub authentication |
| `PI_COMS_NET_SERVER_URL` | Auto-discovered | Override server URL for clients |

### Server Lifecycle

The coms-net hub server is automatically managed:

- **Auto-start:** `/coms-net start` launches a server if one isn't running
- **Shared:** Multiple sessions connect to the same server
- **Auto-cleanup:** The server is killed when the session that started it shuts down (unless other peers are connected)
- **Crash recovery:** Stale registry entries and dead sockets are pruned automatically on session start

Server logs are written to `~/.pi/coms-net/projects/<project>/server.log`.

### Authentication

Token resolution follows a priority chain:

1. `--auth-token` flag (highest priority)
2. `PI_COMS_NET_AUTH_TOKEN` environment variable
3. Auto-discovered from `~/.pi/coms-net/projects/<project>/server.secret.json` (local servers only, file must be mode `0600`)

For local-only servers, the token is auto-generated and stored securely. For remote servers, always set the token explicitly.

## Troubleshooting

**"coms not active" when trying to send messages**
Run `/coms start` or `/coms-net start` first. Communication tools are unavailable until explicitly activated.

**Peers can't see each other (P2P)**
Verify both sessions are in the same project namespace. Run `/coms status` in each session. Check that both are running from the same directory, or set `--project` to match.

**"bun not found" when starting coms-net**
The hub server requires [Bun](https://bun.sh). Install it with `curl -fsSL https://bun.sh/install | bash`. Use P2P mode (`/coms start`) as an alternative that doesn't need Bun.

**Server port/host mismatch**
If you change `--port` or `--host` on a restart, `/coms-net start` automatically detects the mismatch and restarts the server with the new settings.

**Session shows stale peers in the pool widget**
Stale peers (marked with `✗`) are sessions that stopped responding to health checks. They're automatically removed after several missed checks. Run `/coms` or `/coms-net` to force-refresh the pool.

See [Slash Commands and Extension Commands Reference](commands-reference.html) for the complete `/coms` and `/coms-net` command syntax. See [Configuration and Environment Variables Reference](configuration-reference.html) for all coms-related environment variables.

## Related Pages

- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Customization and Extension Recipes](customization-recipes.html)
