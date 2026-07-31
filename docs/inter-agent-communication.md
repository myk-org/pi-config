# Inter-Agent Communication Network

`pi-config` includes an on-demand inter-agent messaging system so multiple Pi sessions can discover each other, exchange prompts, and hand work back and forth without leaving the terminal. You should care because this is what makes peer review loops, planner/worker splits, and background helper sessions feel like one coordinated workspace instead of a pile of disconnected terminals.

## The Big Picture

Two communication modes exist in the codebase:

| System | How it is activated | Transport | Tool names | Best fit |
| :--- | :--- | :--- | :--- | :--- |
| `coms` | `/coms start` | Direct peer-to-peer | `coms_list`, `coms_send`, `coms_get` | Simple local session-to-session messaging |
| `coms-net` | `/coms-net start` or `/coms-net connect` | Local HTTP + SSE hub | `coms_net_list`, `coms_net_send`, `coms_net_get` | More durable multi-session coordination |

This page focuses on `coms-net`, the networked mode built around a local hub server.

### Main Components

| Component | What it does | User-visible effect |
| :--- | :--- | :--- |
| `/coms-net` wrapper | Starts, connects to, disconnects from, or stops the hub | You can bring the network up only when you need it |
| Hub server | Tracks peers, queues messages, and pushes updates over SSE | Replies arrive automatically while you keep working |
| Client in each Pi session | Registers identity, sends heartbeats, and receives inbound work | Each session can appear as a named peer |
| Pool widget | Renders connected peers, status, queue depth, and context usage | You can see who is online and busy at a glance |
| Messaging tools | `coms_net_list`, `coms_net_send`, `coms_net_get` | Agents can discover peers, delegate work, and inspect message state |

### Message Flow

1. A session activates `coms-net` and registers with the hub.
2. The hub assigns that session a project-scoped identity and opens an SSE stream.
3. Another session calls `coms_net_send` with a peer name and prompt.
4. The hub either delivers the message immediately or queues it if the target is busy.
5. The receiving session gets the prompt as a follow-up turn in Pi.
6. The receiver answers normally in chat.
7. The extension captures that final assistant reply and posts it back to the hub.
8. The original sender receives the result as a follow-up message automatically.

> **Tip:** In normal use, you send with `coms_net_send`, then end the turn. You do not need a polling loop unless you explicitly want a non-blocking status check with `coms_net_get`.

## Key Concepts

### Project-Scoped Peer Discovery

`coms-net` isolates peers by project namespace. If you do not pass `--project`, the wrapper derives one from the current working directory, so sessions in different repos do not accidentally see each other.

That is why `/coms-net` only shows peers from the same project group by default. The effect for users is simple: start multiple Pi sessions in one repo, and they naturally discover one another.

### Named Identities

Each session registers with a peer identity: name, purpose, model, color, cwd, and status. The wrapper uses `--cname` for peer naming so it does not conflict with Pi's own `--name` behavior.

This is what makes peer lists readable instead of showing only opaque session IDs. A user can target `planner`, `worker`, or another named peer directly rather than guessing which terminal to message.

### Heartbeats and Presence

Every connected session sends heartbeat updates on a fixed interval. Those updates include context-window usage, queue depth, and optional task summary data.

For users, that turns into a live presence model:
- `online` means the peer is healthy and actively reporting
- `stale` means heartbeats stopped recently
- `offline` means the peer was removed from the active registry

The pool widget and peer list output reflect those states, so you can avoid delegating work to a dead or overloaded session.

### Automatic Reply Capture

Inbound messages are delivered into Pi as follow-up turns. The important rule is that the receiver should answer normally in chat, because the extension captures that reply automatically and returns it to the sender.

> **Warning:** Do not use `coms_net_send` to reply to an inbound `coms-net` message. That starts a brand-new outbound conversation and can create a ping-pong loop.

This behavior matters because it keeps the experience conversational. To the user, cross-session messaging feels like asking a peer for help and getting a normal reply back in the same session.

### Structured Task Delegation

`coms_net_send` supports a `tasks` array alongside the prompt. Those task objects are shown to the receiving peer as structured work items instead of a loose prose blob.

This makes delegation clearer and easier to track when the receiving session uses the task system. For users, it means you can send a prompt plus a checklist, not just a paragraph.

### Hidden vs Discoverable Peers

Peers launched with `--explicit` stay off the default discovery list. They still exist, but they are meant to be contacted intentionally rather than advertised broadly.

This is useful when a helper session should not clutter the shared pool. Users see a cleaner peer list by default, while advanced workflows can still reveal explicit peers when needed.

### Local Server Discovery and Authentication

The hub writes project-local connection details under `~/.pi/coms-net/projects/<project>/`. That includes `server.json`, and for local loopback setups, a `server.secret.json` bearer token file with restricted permissions.

The user-visible effect is convenience with reasonable safety:
- local sessions can auto-discover the hub
- the wrapper can reconnect after reloads
- tokens are kept out of normal command output

> **Note:** By default, the hub is a local service. The wrapper starts it on loopback unless you intentionally change the bind settings.

### Queueing and Hop Limits

The hub enforces queue depth and hop limits. Queueing prevents dropped messages when a peer is busy, while hop limits stop agents from forwarding work forever.

For users, that shows up as more predictable behavior:
- busy peers do not lose messages
- runaway agent-to-agent loops stop instead of spiraling forever
- queue depth is visible in pool output and peer listings

## How It Affects the User

The internals mostly stay out of your way, but they explain several behaviors you will notice in daily use.

| What you see | What is happening underneath |
| :--- | :--- |
| `/coms-net start` brings peers online | The wrapper starts or reuses the local hub, then registers the current session |
| A live peer pool appears in the TUI | The client receives SSE updates and re-renders the widget from hub snapshots |
| A reply shows up later without polling | The receiver's normal assistant reply was captured and pushed back over the hub |
| A peer shows `stale` instead of disappearing immediately | Heartbeats stopped, but the server has not yet fully expired that peer |
| A delegated task arrives with structure | The sender included `tasks`, and the receiver rendered them as assigned work |
| Reconnecting after reload feels automatic | The wrapper persists activation state and re-registers on reload |

A few practical implications are worth remembering:

- `coms-net` is best when you want named peer sessions that stay coordinated over time.
- It is especially useful when one session should keep coding while another handles planning, review, or background work.
- If you only need a lightweight direct link, the older `coms` mode is still available alongside `coms-net`.

## Related Pages

- See [Managing Custom Agents](managing-custom-agents.html) for details.
- See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.
- See [Daemon & Websocket Networking](daemon-and-websockets.html) for details.
- See [Creating Slash Commands](custom-slash-commands.html) for details.

## Related Pages

- [Managing Custom Agents](managing-custom-agents.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
- [Built-in Workflow Commands](built-in-workflows.html)
