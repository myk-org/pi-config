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

## Activation

Tools are unavailable until the user runs `/coms start` (P2P) or `/coms-net start` (networked).
Use `coms_list` / `coms_net_list` to see connected peers.

## Tool Reference

| Action | P2P (coms) | Networked (coms-net) |
|--------|-----------|---------------------|
| List peers | `coms_list` | `coms_net_list` |
| Send message | `coms_send` | `coms_net_send` |
| Poll for response | `coms_get` | `coms_net_get` |

## Inbound Messages — How to Reply

Inbound messages appear as `[from <peer> @ <cwd>] <message>`. Your assistant text IS the reply — the `agent_end` hook captures it and sends it back automatically.

❌ **Never call `coms_send` to reply** — that starts a new outbound conversation instead of replying.

## Outbound Messages — How to Initiate

To start a conversation: call the send tool, then **end your turn**.
The peer's response auto-delivers as a followUp message — no polling needed.
Use `coms_get` / `coms_net_get` only for non-blocking status checks.

## Message Queue

Inbound messages process in FIFO order. If multiple arrive while the peer is busy, they queue — each gets its own turn and response, nothing is dropped.

## Structured Task Delegation

Use the `tasks` parameter to delegate structured work items alongside messages. Tasks appear in the peer's task widget (requires `@tintinweb/pi-tasks`):

```text
coms_send(target="coder", prompt="Implement these features", tasks=[
  {"subject": "Add auth middleware", "description": "JWT validation for all /api routes"},
  {"subject": "Write tests", "description": "Unit tests for auth middleware"}
])
```

## Key Rules

1. **Responses auto-deliver** — after send, end your turn; the reply arrives as a followUp
2. **Never call send tools to reply** to inbound messages — your assistant text is the reply
3. **Always check peers first** — use list tools before sending
4. **Try both systems** — try `coms_` and `coms_net_` when system isn't specified
5. **Messages are never lost** — busy peers queue messages in FIFO order
6. **Use tasks for structured work** — use `tasks` parameter instead of prose lists
