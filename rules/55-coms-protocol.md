# Coms Protocol — Inter-Agent Communication

## Overview

P2P communication system for talking to other pi sessions on the same machine.

| System | Activation | Tool prefix | Transport |
|--------|-----------|-------------|-----------|
| **P2P** (coms) | `/coms start` | `coms_` | Direct peer-to-peer |

## Activation

Tools are unavailable until the user runs `/coms start`.
Use `coms_list` to see connected peers.

## Tool Reference

| Action | Tool |
|--------|------|
| List peers | `coms_list` |
| Send message | `coms_send` |
| Poll for response | `coms_get` |
| Clear your queued msgs | `coms_queue_clear` |
| Delete queued msg | `coms_queue_delete` |
| Edit queued msg | `coms_queue_edit` |
| Prioritize queued msg | `coms_queue_prioritize` |
| View local queue | `/coms-queue` |
| Create task on peer | `coms_task_create` |
| Delete task on peer | `coms_task_delete` |
| List peer's tasks | `coms_task_list` |
| Get peer's task | `coms_task_get` |
| Update task on peer | `coms_task_update` |

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

### Manual queue operations

| Action | Tool |
|--------|------|
| Clear all your pending | `coms_queue_clear(target)` |
| Delete specific message | `coms_queue_delete(target, msg_id)` |
| Edit queued message | `coms_queue_edit(target, msg_id, new_content)` |
| Move to front | `coms_queue_prioritize(target, msg_id)` |

**Rules:**

- You can only manage YOUR OWN messages in a peer's queue
- Cannot touch messages from other senders
- Cannot touch the message currently being processed
- `msg_id` is returned by `coms_send` — track it to manage later
- Use `clearPrevious` when sending corrections — it's the most common pattern

**Note:** `coms_queue_edit` has a race window — if the peer dequeues the message before the edit arrives, the original content is delivered. This is inherent to async queues.

## Structured Task Delegation

Use the `tasks` parameter to delegate structured work items alongside messages. Tasks appear in the peer's task widget:

```text
coms_send(target="coder", prompt="Implement these features", tasks=[
  {"subject": "Add auth middleware", "description": "JWT validation for all /api routes"},
  {"subject": "Write tests", "description": "Unit tests for auth middleware"}
])
```

### Recommended Pattern

1. Create tasks silently on the peer via `coms_task_create` (no message sent)
   - Always add a final "Report completion to sender" task, blocked by all other tasks
2. Send ONE message: `coms_send(target="peer", prompt="You have tasks to work on. Check TaskList and start.")`
3. Monitor progress via `coms_task_list` / `coms_task_get` (no message sent)
4. The peer works through tasks, updates status, reports when done via the final report task

## Remote Task Management

Manage tasks on peer sessions directly — no message sent, no peer notification:

| Tool | Description |
|------|-------------|
| `coms_task_create` | Create a task on peer's session (with coms_origin tracking) |
| `coms_task_update` | Update a task YOU created on peer's session |
| `coms_task_delete` | Delete a task YOU created on peer's session |
| `coms_task_list` | List all tasks on peer's session |
| `coms_task_get` | Get a specific task from peer's session |

Ownership: update/delete only work on tasks with matching `coms_origin` — you can only modify tasks you created.

Tasks are written directly to the peer's task store file. The peer's fs.watch detects the change and updates their task widget instantly.

## Key Rules

1. **Responses auto-deliver** — after send, end your turn; the reply arrives as a followUp
2. **Never call send tools to reply** to inbound messages — your assistant text is the reply
3. **Always check peers first** — use list tools before sending
4. **Messages are never lost** — busy peers queue messages in FIFO order
5. **Use tasks for structured work** — use `tasks` parameter instead of prose lists
