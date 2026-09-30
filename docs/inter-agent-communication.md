# Inter-Agent Communication Network

`pi-config` includes an on-demand inter-agent messaging system so multiple Pi sessions can discover each other, exchange prompts, and hand work back and forth without leaving the terminal. You should care because this is what makes peer review loops, planner/worker splits, and background helper sessions feel like one coordinated workspace instead of a pile of disconnected terminals.

## The Big Picture

`coms` is a peer-to-peer messaging system. Each Pi session opens its own local endpoint and registers it in a project-scoped registry, so sessions in the same repository find each other directly. There is no central hub.

| Aspect | How it works |
| :--- | :--- |
| Transport | Unix domain socket on POSIX, named pipe on Windows |
| Registry | `~/.pi/coms/projects/<project>/agents/<name>.json` |
| Sockets | `~/.pi/coms/sockets/<session-id>.sock` |
| Heartbeat | Every 30 seconds |
| Inactivity timeout | `coms_timeout_ms`, default 30 minutes |
| Max relay hops | `coms_max_hops`, default 5 |

### Main Components

| Component | What it does | User-visible effect |
| :--- | :--- | :--- |
| Launcher wrapper | Registers a session with its name, purpose, model, color, and cwd | Each session appears as a named peer |
| Registry files | One JSON entry per live session, grouped by project | Peers from other repos stay invisible |
| Pool widget | Renders connected peers, queue depth, and context usage | You can see who is online and busy at a glance |
| Messaging tools | `coms_list`, `coms_send`, `coms_get` | Agents can discover peers, delegate work, and inspect message state |
| Queue and task tools | `coms_queue_*` and `coms_task_*` | Queued messages and delegated tasks can be inspected and edited |

### Message Flow

1. A session starts and registers itself under `~/.pi/coms/projects/<project>/agents/`.
2. It opens a local socket and begins sending heartbeats.
3. Another session calls `coms_send` with a target peer name and a prompt.
4. The message is delivered over the target's socket, or queued if the target is mid-turn.
5. The receiving session gets the prompt as a follow-up turn in Pi.
6. The receiver answers normally in chat.
7. The extension captures that final assistant reply and sends it back over the socket.
8. The original sender receives the result as a follow-up message automatically.

> **Tip:** In normal use, you send with `coms_send`, then end the turn. You do not need a polling loop unless you explicitly want a non-blocking status check with `coms_get`.

## Key Concepts

### Project-Scoped Peer Discovery

`coms` isolates peers by project namespace. If you do not pass `--project`, the wrapper derives one from the current working directory, so sessions in different repos do not accidentally see each other.

That is why the pool only shows peers from the same project group by default. The effect for users is simple: start multiple Pi sessions in one repo, and they naturally discover one another. Use `coms_list` with `project: "*"` to see across all projects.

### Named Identities

Each session registers with a peer identity: name, purpose, model, color, and cwd. The wrapper uses `--cname` for peer naming so it does not conflict with Pi's own `--name` behavior; passing `--name` is rejected with a "use --cname instead of --name" error.

This is what makes peer lists readable instead of showing only opaque session IDs. A user can target `planner`, `worker`, or another named peer directly rather than guessing which terminal to message.

### Heartbeats and Presence

Every connected session sends heartbeat updates every 30 seconds. Those updates include context-window usage, queue depth, and optional task summary data.

Dead peers are removed from the registry in two phases. A newly registered entry gets a grace period (`coms_entry_grace_period_ms`, default 30 seconds) so a just-booted session is never pruned early. After that, the entry is probed by connecting to its socket: peers that respond are kept, peers that do not are removed from the registry. Timestamp staleness alone never prunes an entry, which is what keeps laptop suspend/resume from wiping out live peers.

For users, that turns into a live presence model:
- a peer in the list answered a probe and is reachable
- a peer missing from the list was pruned or never registered in this project

The pool widget and peer list output reflect that, so you can avoid delegating work to a dead or overloaded session.

### Automatic Reply Capture

Inbound messages are delivered into Pi as follow-up turns. The important rule is that the receiver should answer normally in chat, because the extension captures that reply automatically and returns it to the sender.

If a user message lands in the same turn as an inbound peer message, the reply cannot be attributed. Pi re-injects the inbound message for a clean dedicated turn, up to two times, before giving up and erroring back to the sender.

> **Warning:** Do not use `coms_send` to reply to an inbound `coms` message. That starts a brand-new outbound conversation and can create a ping-pong loop.

This behavior matters because it keeps the experience conversational. To the user, cross-session messaging feels like asking a peer for help and getting a normal reply back in the same session.

### Structured Task Delegation

`coms_send` supports a `tasks` array alongside the prompt. Each task object has a `subject` and a `description`, and is shown to the receiving peer as structured work items instead of a loose prose blob.

This makes delegation clearer and easier to track when the receiving session uses the task system. For users, it means you can send a prompt plus a checklist, not just a paragraph.

### Hidden vs Discoverable Peers

Peers launched with `--explicit` stay off the default discovery list. They still exist, but they are meant to be contacted intentionally rather than advertised broadly.

This is useful when a helper session should not clutter the shared pool. Users see a cleaner peer list by default, while advanced workflows can still reveal explicit peers when needed.

### On-Disk Layout and Cleanup

Sessions write two kinds of files under `~/.pi/coms/`, overridable with the `coms_dir` setting (`PI_COMS_DIR`):

- `projects/<project>/agents/<name>.json` — the registry, one file per live session
- `sockets/<session-id>.sock` — the per-session endpoint

Directory creation is restricted to the owner (`0o700`). Because each peer owns its own socket, a peer that is pruned from the registry does not have its socket deleted by anyone else; the owning process is responsible for that.

> **Note:** The whole registry is local to your machine and your user account. There is no shared server, no bearer token, and no network listener — peers are reached over a local socket or named pipe only.

### Queueing and Hop Limits

Queueing prevents dropped messages when a peer is busy, while hop limits stop agents from forwarding work forever. The hop ceiling is the `coms_max_hops` setting (`PI_COMS_MAX_HOPS`, integer, default `5`, range 1–50).

For users, that shows up as more predictable behavior:
- busy peers do not lose messages
- runaway agent-to-agent loops stop instead of spiraling forever
- queue depth is visible in pool output and peer listings, and can be managed with `/coms-queue`

## How It Affects the User

The internals mostly stay out of your way, but they explain several behaviors you will notice in daily use.

| What you see | What is happening underneath |
| :--- | :--- |
| A live peer pool appears in the TUI | The session registered a registry entry and opened its socket |
| A reply shows up later without polling | The receiver's normal assistant reply was captured and sent back over the socket |
| A peer disappeared from the list | Its registry entry was removed after failing a socket probe |
| A delegated task arrives with structure | The sender included `tasks`, and the receiver rendered them as assigned work |
| `/coms` shows a different set of peers | You toggled `include_explicit` or switched the displayed project |

A few practical implications are worth remembering:

- Start sessions with `--cname` so peers are addressable by a readable name instead of a session id.
- The pool is project-scoped, so open every coordinating session in the same repository.
- `--explicit` keeps a helper session out of the default discovery list without making it unreachable.

## Commands

| Command | What it does |
| :--- | :--- |
| `/coms` | Force-refresh the pool widget. `--all` toggles `include_explicit`; `--project <name>` switches the displayed project. |
| `/coms-queue` | View and manage queued inbound messages, including killing them. |

## Related Pages

- See [Managing Custom Agents](managing-custom-agents.html) for details.
- See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details.
- See [Daemon & Websocket Networking](daemon-and-websockets.html) for details.
- See [Creating Slash Commands](custom-slash-commands.html) for details.
- See [Using the Web Dashboard](using-the-web-dashboard.html) for details.
