---
requires: coms_active
---
# Coms Protocol — Inter-Agent Communication

## Overview

P2P communication system for talking to other pi sessions on the same machine.

| System | Activation | Tool prefix | Transport |
|--------|-----------|-------------|-----------|
| **P2P** (coms) | `coms_start` tool (or `/coms start`, or `pi --coms`) | `coms_` | Direct peer-to-peer |

## Activation

Call `coms_start` yourself when a task needs another agent — an already-open session enables coms
with no slash command and no new process. `coms_stop` ends it. `/coms start` and `pi --coms
--cname <name> --project <p>` do the same for humans and for spawned sessions.

## Two different things — do not confuse them

| You want | Call | What happens |
|---|---|---|
| **This** chat to become a peer | `coms_start` | The session you are already in registers an identity and gains `coms_send`/`coms_list`. No new process, no new model. |
| **Another** pi to work for you | supervisor + `scripts/coms-peer-supervisor.mjs` | A NEW pi process with its own session, model and context. It is a peer, not this session. |

Starting coms costs nothing and is reversible with `coms_stop`. Spawning a peer costs a process and
a model context that stays warm until it is killed.

**Never spawn a peer without work to give it.** A peer that is not told what to do is not dead — it
is idle: it holds a process and a model session, answers nothing, and quietly disappears from
anyone's attention. Spawn with a `--purpose` AND assign tasks (`coms_tasks_create`) or send the first
prompt in the same breath; otherwise do not spawn.

## Spawning more agents

You can grow the pool instead of doing everything yourself:

| Action | How |
|---|---|
| Start a peer as its own real pi, with its own session | `pi --mode rpc --coms --cname <name> --project <p>` under `scripts/coms-peer-supervisor.mjs` (`~/.pi/agent/npm/node_modules/pi-orchestrator-config/scripts/`, falling back to this checkout): it holds the peer's stdin, records pids in `~/.pi/coms/peers/<name>.json`, and has no lifetime of its own |
| Spawn a peer | `coms_peer_spawn` with `cname` (+ optional `purpose`, `project`, `cwd`) — starts a supervised `pi --coms` process with its own session. It registers in ~20-30s; `coms_peers` then lists it. No human needed and no shell command to remember |
| See spawned peers | `coms_peers` (human: `/coms list`) scoped to THIS project by default; pass `project: "*"` (tool) or `/coms list --all` for every project. `/coms list` overlays like `/async-status`: ↑↓ navigate, x kill, X kill all, plain text when there is no UI |
| Stop one peer / all peers | `coms_peer_kill` with `name` (add `project` when the name exists in several) or `all:true` (human: `/coms kill <name>` / `/coms kill all`). Only peers a supervisor started are killable — never your own session. |

Rules for spawning: a peer is an independent process that outlives this session, so **always**
report what you spawned (`coms_peers` output) and stop peers you no longer need. Never spawn more
than the task justifies — each peer is a real model burning real tokens. Scrub
`__PI_CONFIG_SESSION_ID` from the peer's env or coms adopts your session id and its socket bind
fails. Use `coms_list` for connected peers.

## Tool Reference

| Action | Tool |
|--------|------|
| List connected peers | `coms_list` |
| Send message / structured tasks | `coms_send` |
| Poll for response | `coms_get` |
| Clear / delete / edit / prioritize your queued msgs | `coms_queue_clear` / `coms_queue_delete` / `coms_queue_edit` / `coms_queue_prioritize` |
| View local queue | `/coms-queue` |
| Create / update / delete / list / get peer tasks | `coms_tasks_create` / `coms_task_update` / `coms_task_delete` / `coms_task_list` / `coms_task_get` |

## Inbound Messages — How to Reply

Inbound messages appear as `[from <peer> @ <cwd>] <message>`. Your assistant text IS the reply — the `agent_end` hook captures it and sends it back automatically.

❌ **Never call `coms_send` to reply** — that starts a new outbound conversation instead of replying.

## Outbound Messages — How to Initiate

To start a conversation: call the send tool, then **end your turn**.
The peer's response auto-delivers as a followUp message — no polling needed.
Use `coms_get` only for non-blocking status checks.

## Message Queue

Inbound messages process in FIFO order. If multiple arrive while the peer is busy, they queue — each gets its own turn and response, nothing is dropped.

## Queue Management

When sending corrected or updated instructions that supersede previous messages, use queue management to prevent peers from processing stale messages:

### Clear previous messages before sending

```text
coms_send(target="peer", prompt="Updated instructions", clearPrevious=true)
```

This clears all YOUR pending (unprocessed) messages from the peer's queue before delivering the new one. Use when previous messages are outdated.

**Queue Rules:**

- You can only manage YOUR OWN pending messages (never other senders' or the currently processing message)
- `msg_id` is returned by `coms_send` — track it to manage later
- Use `clearPrevious` when sending corrections — it's the most common pattern
- `coms_queue_edit`, `coms_queue_delete`, and `coms_queue_prioritize` are fire-and-forget (transport ack only;
  dequeue races, missing `msg_id`, or ownership mismatches can silently no-op — verify via subsequent responses)

## Structured Task Delegation

Use the `tasks` parameter to delegate structured work items alongside messages. Tasks appear in the peer's task widget:

```text
coms_send(target="coder", prompt="Implement these features", tasks=[
  {"subject": "Add auth middleware", "description": "JWT validation for all /api routes"},
  {"subject": "Write tests", "description": "Unit tests for auth middleware"}
])
```

### Recommended Pattern

1. Create tasks on the peer via `coms_tasks_create`
   - Automatically adds a "Report completion to sender" task, blocked by all other tasks
   - Automatically sends a message to the peer to start working
2. Monitor progress via `coms_task_list` / `coms_task_get` (no message sent)
3. The peer works through tasks, updates status, reports when done via the final report task

## Remote Task Management

`coms_task_update` and `coms_task_delete` only work on tasks with matching `coms_origin` — you can only modify tasks you created.
Tasks write directly to the peer's task store file, and the peer's `fs.watch` updates their task widget instantly (no message sent, no notification).
