# Coms Protocol — Inter-Agent Communication

## Overview

Two communication systems are available for talking to other pi sessions:

| System | Activation | Tool prefix | Transport |
|--------|-----------|-------------|-----------|
| **P2P** (coms) | `/coms start` | `coms_` | Direct peer-to-peer |
| **Networked** (coms-net) | `/coms-net start` | `coms_net_` | Hub server relay |

Only one system is active at a time. **Don't mix tool prefixes** — check which is active first.

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
| Block until response | `coms_await` | `coms_net_await` |

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

To START a new conversation with a peer, use the send tool then poll for the response.

❌ **WRONG:** `coms_send` → `coms_await` (blocks the entire session — user can't interact)

✅ **RIGHT:** `coms_send` → continue working → `coms_get` to check later

### Example: Outbound conversation (P2P)

```text
1. coms_list                          # Find available peers
2. coms_send(peer="pi-2", msg="...")  # Send the question
3. ... continue other work ...        # Don't block
4. coms_get                           # Poll for response
```

### Example: Outbound conversation (Networked)

```text
1. coms_net_list                          # Find available peers
2. coms_net_send(peer="pi-2", msg="...")  # Send the question
3. ... continue other work ...            # Don't block
4. coms_net_get                           # Poll for response
```

`coms_await` / `coms_net_await` are also available — they block until the response arrives
but the user can press ESC to interrupt. Use when you need the response before continuing.

---

## Key Rules

1. **Avoid `coms_await` / `coms_net_await`** — they block the session.
   Use `coms_get` / `coms_net_get` to poll instead.
   If the user explicitly asks to await, `coms_await` is interruptible via ESC.
2. **Never call send tools to reply** to inbound messages — your assistant text is the reply
3. **Always check peers first** — use list tools before sending to verify the peer exists
4. **Don't mix prefixes** — `coms_` tools only work with `/coms`, `coms_net_` tools only work with `/coms-net`
5. **Poll, don't block** — use `coms_get` / `coms_net_get` to check for responses non-blockingly
