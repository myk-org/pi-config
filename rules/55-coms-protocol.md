# Coms Protocol — Inter-Agent Communication

## Overview

Two communication systems are available for talking to other pi sessions:

| System | Activation | Tool prefix | Transport |
|--------|-----------|-------------|-----------|
| **P2P** (coms) | `/coms start` | `coms_` | Direct peer-to-peer |
| **Networked** (coms-net) | `/coms-net start` | `coms_net_` | Hub server relay |

Both systems can be active. When asked to list peers, send messages, or interact with coms —
**try both** `coms_list` and `coms_net_list`. If one fails, use the other.
Don't assume which system is active.

---

## Activation

Tools are unavailable until the user activates a system:

```text
/coms start        # Start P2P communication
/coms-net start    # Start networked communication
```

To see connected peers:

```text
coms_list          # P2P peers
coms_net_list      # Networked peers
```

---

## Tool Reference

| Action | P2P (coms) | Networked (coms-net) |
|--------|-----------|---------------------|
| List peers | `coms_list` | `coms_net_list` |
| Send message | `coms_send` | `coms_net_send` |
| Poll for response | `coms_get` | `coms_net_get` |

---

## Inbound Messages — How to Reply

When you receive an inbound message, it appears as:

```text
[from <peer> @ <cwd>] <message content>
```

**Your assistant text IS the reply.** The `agent_end` hook automatically captures your final assistant message and sends it back to the peer. You do NOT need to call any send tool.

❌ **WRONG:** Receive inbound → call `coms_send` to reply

```text
# This creates a NEW outbound conversation instead of replying.
# The response never reaches the original peer.
# The send call blocks waiting for a reply to this new message.
```

✅ **RIGHT:** Receive inbound → write your answer as normal assistant text

```text
# The hook captures your response and delivers it to the peer automatically.
# No tool calls needed — just answer the question.
```

---

## Outbound Messages — How to Initiate

To START a new conversation with a peer, use the send tool then **end your turn**. The response auto-delivers as a followUp message when the peer replies — no polling or blocking needed.

### Example: Outbound conversation (P2P)

```text
1. coms_list                          # Find available peers
2. coms_send(peer="pi-2", msg="...")  # Send the question
3. (end turn)                         # Response arrives as followUp automatically
```

### Example: Outbound conversation (Networked)

```text
1. coms_net_list                          # Find available peers
2. coms_net_send(peer="pi-2", msg="...")  # Send the question
3. (end turn)                             # Response arrives as followUp automatically
```

Use `coms_get` / `coms_net_get` for non-blocking status checks if needed.

---

## Message Queue Behavior

Inbound messages are processed in **FIFO order** (oldest first). When multiple messages arrive while the peer is busy:

1. First message is processed immediately
2. Subsequent messages are **queued** — not lost, not superseded
3. After responding to the current message, the next queued message is automatically injected
4. Each message gets its own dedicated turn and response
5. The sender receives a response for every message sent — nothing is dropped

---

## Structured Task Delegation

Send structured tasks alongside messages using the `tasks` parameter. Tasks appear in the peer's task widget (requires `@tintinweb/pi-tasks`).

```text
coms_send(target="coder", prompt="Implement these features", tasks=[
  {"subject": "Add auth middleware", "description": "JWT validation for all /api routes"},
  {"subject": "Write tests", "description": "Unit tests for auth middleware"}
])
```

The peer sees the tasks in their task widget and can track progress. Tasks are created immediately — even if the message itself is queued.

---

## Key Rules

1. **Responses auto-deliver** — after `coms_send` / `coms_net_send`, end your turn. The peer's response arrives as a followUp message automatically.
2. **Never call send tools to reply** to inbound messages — your assistant text is the reply
3. **Always check peers first** — use list tools before sending to verify the peer exists
4. **Try both systems** — when asked to interact with peers without specifying which system, try `coms_` first, then `coms_net_` if it fails (or vice versa)
5. **Messages are never lost** — if the peer is busy, messages queue and process in order
6. **Use tasks for structured work** — when delegating multiple items, use the `tasks` parameter instead of listing them in prose
