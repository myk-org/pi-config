# ACPX Provider Integration

## ACPX Agent Configuration

Settings that determine which external agents are loaded via the ACPX runtime.

**Configuration Key:** `acpx_agents`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `acpx_agents` | Array<string> \| string | `[]` | Comma-separated list of agent identifiers (e.g., `cursor`, `claude`) to initialize via the ACPX runtime. |

```json
{
  "acpx_agents": ["cursor", "claude"]
}
```

## ACPX Runtime Module

The runtime integration requires the `acpx` package to be resolvable on the system.

**Method:** `loadAcpxRuntime()`

| Property | Type | Description |
| :--- | :--- | :--- |
| `createAcpRuntime` | Function | Instantiates the core ACP runtime instance. |
| `createFileSessionStore` | Function | Initializes persistent session storage on the filesystem. |
| `createAgentRegistry` | Function | Provides the registry of available ACPX agents. |

> **Note:** The module searches for a global `npm install -g acpx` first, followed by local package dependencies.

```typescript
import { loadAcpxRuntime } from "./load-runtime.js";

const { createAcpRuntime, createFileSessionStore, createAgentRegistry } = await loadAcpxRuntime();
```

## Model Discovery

Synchronously queries an agent for its available models using a temporary session.

**Method:** `discoverAcpxModels(agent, cwd?)`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `agent` | string | (required) | The identifier of the agent (e.g., `cursor`). |
| `cwd` | string | `process.cwd()` | Directory to use as the base for the discovery session context. |

**Returns:** `Array<{ id: string, name: string, provider: string }>`

> **Tip:** Model discovery operations automatically time out after 30 seconds if the external agent fails to respond.

```typescript
import { discoverAcpxModels } from "pi-orchestrator-config/extensions/acpx-provider";

const models = await discoverAcpxModels("cursor", "/path/to/project");
// Returns: [{ id: "cursor:gpt-5.4[...]", name: "Gpt 5.4 (cursor)", provider: "acpx-cursor" }]
```

## Ambient Authentication

Handles the `/login` flow for ACPX agents by validating the ambient runtime presence.

**Method:** `buildAmbientLoginAuth(opts)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `displayName` | string | (required) | The UI name for the authentication prompt. |
| `isConfigured` | Function | (required) | Callback returning boolean if the agent state/runtime is present. |
| `sourceLabel` | string | (required) | Human-readable string indicating where the auth comes from (e.g., "cursor acpx runtime"). |

**Returns:** A `ProviderAuth["apiKey"]` object compatible with `createProvider()`.

```typescript
import { buildAmbientLoginAuth } from "../shared/create-runtime-provider.js";
import { isAcpxAgentConfigured } from "./configured.js";

const auth = buildAmbientLoginAuth({
  displayName: "ACPX cursor",
  isConfigured: () => isAcpxAgentConfigured("cursor"),
  sourceLabel: "cursor acpx runtime",
});
```

## Stream Execution

Processes LLM requests through the persistent ACPX agent session via `streamAcpx()`.

**Execution Mechanics:**
*   **Context:** Maintains conversation history entirely within the remote ACPX agent side.
*   **Prompting:** Extracts and sends only the latest user message from the incoming context.
*   **System Prompt:** Injected exactly once per session handle during initialization.
*   **Tokens:** Maps remote `text_delta` and `thought` streams into native text/thinking content blocks.

> **Warning:** Context arrays with historical messages are not forwarded to the ACPX runtime on subsequent turns.

```typescript
// Internal ACPX startTurn request mapping
const turn = state.runtime.startTurn({
  handle: sessionHandle,
  text: extractLatestUserMessage(context),
  mode: "prompt",
  requestId: `pi-${Date.now()}-${randomId}`,
  signal: abortController.signal,
});
```

## Session Management

Persistent handles map specific working directories and model IDs to long-running ACPX agent sessions.

**Method:** `runtime.ensureSession(options)`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `sessionKey` | string | (required) | Unique hash of agent, model ID, and cwd identifier. |
| `agent` | string | (required) | The target agent identifier. |
| `mode` | string | (required) | `persistent` for standard streams, `oneshot` for model discovery. |
| `cwd` | string | (required) | Project working directory captured at init time. |
| `sessionOptions` | Object | `{}` | Key-value options for model selection and system prompt initialization. |

> **Note:** All active ACPX runtime sessions are actively terminated and closed during the primary `session_shutdown` hook.

```typescript
const handle = await runtime.ensureSession({
  sessionKey: "pi-cursor-gpt-4-cwdSlug123",
  agent: "cursor",
  mode: "persistent",
  cwd: "/home/user/project",
  sessionOptions: {
    model: "cursor:gpt-4",
    systemPrompt: "You are being used as a backend LLM..."
  }
});
```

## Related Pages

- [External AI Agents & CLI](external-ai-agents.html)
- [Configuration & Settings](configuration.html)
