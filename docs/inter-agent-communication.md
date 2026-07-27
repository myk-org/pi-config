# Inter-Agent Communication Network

The Inter-Agent Communication Network (often referred to as `coms-net`) is the backbone that enables multiple independent agent sessions to discover each other, broadcast state, and securely pass messages. Instead of relying on direct inter-process communication (IPC) or complex shared memory, agents coordinate through a lightweight HTTP/SSE (Server-Sent Events) hub.

By standardizing how agents talk to each other, `coms-net` enables true multi-agent orchestration. Developers can spawn specialist agents (like a planner and a researcher), and those agents can delegate tasks, share context, and aggregate results without blocking the user interface.

---

## The Big Picture: Architecture and Flow

The network operates on a hub-and-spoke model. A single central server acts as the directory and message broker, while individual agents act as clients.

| Component | Responsibility | Underlying Tech |
| :--- | :--- | :--- |
| **Coms Hub** | Central message broker and registry server. Manages routing, TTLs, and queue depth. | Bun HTTP server (`coms-net-server.ts`) |
| **Registry Directory** | Ephemeral storage for hub state, active session JSONs, and authentication secrets. | `~/.pi/coms-net/` |
| **Agent Client** | Connects to the hub, registers its identity, handles heartbeats, and processes incoming SSE events. | TypeScript Extension (`coms-net.ts`) |
| **Tool Interface** | Exposes the network to the LLM via `coms_net_send`, `coms_net_get`, and `coms_net_list`. | Standard Agent Tools |

### Message Lifecycle Flow

When Agent A delegates a question to Agent B, the flow works like this:

1. **Initiation:** Agent A calls the `coms_net_send` tool with a target name and prompt.
2. **Dispatch:** Agent A's extension intercepts the tool call and POSTs the payload to the Coms Hub. The hub generates a `msg_id` and marks it `queued`.
3. **Delivery:** The Hub pushes the payload down Agent B's open SSE connection. Agent B's extension intercepts the event and injects a hidden message into Agent B's context window.
4. **Resolution:** Agent B generates a normal conversational response. At the end of the turn, Agent B's extension captures the text and POSTs it back to the Hub as the resolution.
5. **Callback:** The Hub pushes the response down Agent A's SSE connection. Agent A's extension receives it and injects it as a follow-up message so Agent A knows the task is complete.

---

## Key Concepts

### The Hub and Authentication

The network is secured via a Bearer token generated at startup. The hub binds to a port and writes its connection details to `~/.pi/coms-net/projects/<project>/server.json` and its secure token to `server.secret.json` (chmod `0600`).

When an agent extension starts up, it automatically discovers these files and authenticates.

> **Warning:** You should never commit or log the authentication token. The hub enforces strict token handling and will terminate connections missing valid Bearer headers.

### Agent Registration and Heartbeats

When an agent joins, it registers with a name, model identifier, and color. To ensure the registry remains accurate, agents must send a heartbeat (default every 10 seconds).

The heartbeat contains telemetry:
- `context_used_pct`: How full the agent's context window is.
- `queue_depth`: How many pending messages it has.
- `tasks_summary`: Progress on its current task list (total, completed, in-progress).

If the Hub misses heartbeats, the agent transitions from `online` to `stale`, and eventually to `offline` where it is removed from the registry.

### Message Queues and Hop Limits

To prevent infinite loops of agents talking to each other forever, the network implements **hop limits** (default: 5). Every time an agent forwards a delegated request, the hop count increments. Once the limit is hit, the Hub rejects the send request.

Additionally, to prevent an agent from being overwhelmed, the Hub enforces an **inbox cap** (default: 100 messages).

### Task Delegation

Agents can send more than just raw text strings. The `coms_net_send` payload supports a `tasks` array. When Agent B receives a message containing tasks, its extension renders them as explicit work items, encouraging Agent B to use its `TaskCreate` tools to track the work formally.

---

## How It Affects the User

The technical details of SSE streams and Bearer tokens are completely abstracted away from the end user. Here is how `coms-net` surfaces in the application:

* **The Coms-Net Pool Widget:** At the bottom of the user's terminal, a live dashboard shows all connected agents. It updates in real-time as heartbeats arrive, showing their context window usage (`--%`), model type, and queue depth (`📨1`).
* **Non-Blocking Execution:** Because messages are resolved via SSE push events rather than blocking HTTP polls, users can continue chatting with Agent A while Agent B works in the background. When Agent B finishes, the result cleanly injects into Agent A's chat history.
* **Agent Transparency:** The Hub broadcasts state changes to all peers. If Agent A wants to know who is available, it can call `coms_net_list` to see exactly what the user sees in their terminal dashboard.

> **Tip:** If you see an infinite ping-pong loop (where agents keep saying "I am sending this back to you"), it means an agent's prompt instructions are incorrectly telling it to call `coms_net_send` to *reply*. Agents should always reply by simply speaking normally in their context window. The extension automatically extracts the reply.

---

## Extending the Network

If you are writing a custom provider or external daemon, you can interact with the Coms Hub directly via its HTTP API.

* **Registering:** POST `/v1/agents/register` with your `session_id`, `name`, and `project`.
* **Connecting:** Open an EventSource connection to the `sse_url` returned from the register call.
* **Sending:** POST `/v1/messages` with `sender_session`, `target`, and `prompt`.
* **Replying:** Listen for `prompt` events on your SSE stream, process the text, and POST back to `/v1/messages/<msg_id>/response`.

By adhering to this contract, non-Pi systems (like a dedicated python background worker) can masquerade as peer agents on the network.

---

## Related Pages

* See [Managing Custom Agents](managing-custom-agents.html) to learn how to assign specific roles to agents on the network.
* See [Daemon & Websocket Networking](daemon-and-websockets.html) to understand how the broader application manages async tasks alongside the `coms-net` hub.
* See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) to learn how to spawn background peers that wait for network messages.

## Related Pages

- [Managing Custom Agents](managing-custom-agents.html)
- [External AI Agents & CLI](external-ai-agents.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
