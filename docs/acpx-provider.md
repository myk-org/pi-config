# ACPX Provider Integration

> **Note:** `extensions/acpx-provider/` is a backward-compatible shim for consumers such as pi-sidecar. It exports `discoverAcpxModels`, `mapAcpxDiscoveredModels`, `modelIdToDisplayName`, and a no-op extension entry. Provider registration and streaming run through `extensions/providers/` (`AcpxDriver` + `ProviderDriverRegistry`). See [Configuration & Settings](configuration.html) for settings file locations and [External AI Agents & CLI](external-ai-agents.html) for CLI usage of external agents.

## `acpx_agents`

Agents registered as ACPX providers at session start.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `acpx_agents` | `string[]` \| `string` | `[]` | Agent identifiers to create via `AcpxDriver`. Accepts a JSON array or a comma-separated string. Names are trimmed, lowercased, and filtered to `/^[a-z0-9_-]+$/`. |

**Resolution order:** project settings → global settings → `ACPX_AGENTS` env → `[]`.

**Driver mapping (`ACPX_AGENT_TO_DRIVER`):** `cursor` → `acpx`. Any other listed name falls back to driver kind `acpx` with `config.agent` set to that name.

```json
{
  "acpx_agents": ["cursor"]
}
```

```bash
export ACPX_AGENTS=cursor
```

**Effect:** For each agent, `extensions/providers/` creates a `ProviderInstance`, registers provider id `acpx-<agent>`, and exposes models under that provider.

> **Note:** During extension startup, each agent races `registry.createInstance` against `DISCOVERY_TIMEOUT_MS` (`30000`). Timed-out creates are torn down if they finish later.

## `loadAcpxRuntime()`

Resolves the `acpx/runtime` module. Memoized across calls; failed loads clear the cache.

**Module:** `extensions/acpx-provider/load-runtime.ts`

| Return field | Type | Description |
| :--- | :--- | :--- |
| `createAcpRuntime` | `Function` | Builds an ACP runtime for a cwd / session store / agent registry. |
| `createFileSessionStore` | `Function` | Filesystem session store factory. |
| `createAgentRegistry` | `Function` | ACPX agent registry factory. |

**Resolution order:**
1. Global npm root (`npm root -g`) package `acpx` → `dist/runtime.js`
2. Candidate roots: `/usr/local/lib/node_modules`, `~/.npm-global/lib/node_modules`
3. Package import `acpx/runtime`

```typescript
import { loadAcpxRuntime } from "./load-runtime.js";

const { createAcpRuntime, createFileSessionStore, createAgentRegistry } =
  await loadAcpxRuntime();
```

**Throws:** `Error` if runtime cannot be resolved (`npm install -g acpx` or package dependency `acpx` required).

## `discoverAcpxModels(agent, cwd?)`

Async discovery of available model ids for one ACPX agent. Creates a temporary oneshot session, reads `getStatus().models.availableModelIds`, closes the session, and deletes the temp state dir.

**Module:** `extensions/acpx-provider/index.ts`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `agent` | `string` | (required) | Agent id. Must match `/^[a-z0-9_-]+$/i`. |
| `cwd` | `string` | `process.cwd()` | Working directory for the discovery session. |

**Returns:** `Promise<Array<{ id: string; name: string; provider: string }>>`

| Field | Description |
| :--- | :--- |
| `id` | `<agent>:<modelId>` |
| `name` | Display name from `modelIdToDisplayName(modelId)` plus ` (<agent>)` |
| `provider` | `acpx-<agent>` |

On discovery failure, returns `[]` (does not throw). Invalid `agent` throws `Error`.

```typescript
import { discoverAcpxModels } from "pi-orchestrator-config/extensions/acpx-provider";

const models = await discoverAcpxModels("cursor", "/path/to/project");
// [{ id: "cursor:gpt-5.4[...]", name: "Gpt 5.4 (cursor)", provider: "acpx-cursor" }]
```

> **Note:** Discovery uses `permissionMode: "deny-all"` and state under `~/.acpx/discover-<pid>-<uid>/`.

## `mapAcpxDiscoveredModels(agent, modelIds)`

Maps raw model id strings to pi-ai runtime `Model` objects for provider registration.

**Module:** `extensions/acpx-provider/runtime-models.ts`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `agent` | `string` | (required) | Agent id used in model/provider ids. |
| `modelIds` | `readonly string[]` | (required) | Raw ids from ACPX status / snapshot. |

**Returns:** `Model[]` with `api: "acpx"` and `provider: "acpx-<agent>"`.

| Condition | Effect |
| :--- | :--- |
| `modelIds.length === 0` | Single fallback model `{ id: "<agent>:default", name: "<agent> (default)" }` |
| otherwise | One model per id: `{ id: "<agent>:<m>", name: "<Display> (<agent>)" }` |

```typescript
import { mapAcpxDiscoveredModels } from "pi-orchestrator-config/extensions/acpx-provider";

const models = mapAcpxDiscoveredModels("cursor", ["gpt-5.4[context=272k]"]);
// id: "cursor:gpt-5.4[context=272k]", name: "Gpt 5.4 (cursor)", provider: "acpx-cursor"
```

## `modelIdToDisplayName(modelId)`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `modelId` | `string` | (required) | Raw ACPX model id. |

**Returns:** `string` — bracket suffix stripped, hyphens → spaces, title-cased.

```typescript
import { modelIdToDisplayName } from "pi-orchestrator-config/extensions/acpx-provider";

modelIdToDisplayName("gpt-5.4[context=272k]"); // "Gpt 5.4"
```

## `buildAmbientLoginAuth(opts)`

Builds `/login` api-key auth that stores a configured marker when `isConfigured()` is true.

**Module:** `extensions/shared/create-runtime-provider.ts`  
**Wired by:** `registerAcpxAgent()` in `extensions/providers/index.ts`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `displayName` | `string` | (required) | Label in the `/login` prompt (`ACPX <agent>`). |
| `isConfigured` | `() => boolean \| Promise<boolean>` | (required) | Gate for login/resolve/check. For ACPX: `acpxInstances.has(agent)`. |
| `sourceLabel` | `string` | (required) | Auth source string (e.g. `"cursor acpx runtime"`). |

**Returns:** `ProviderAuth["apiKey"]` for `createRuntimeProvider()` / `createProvider()`.

```typescript
import { buildAmbientLoginAuth } from "../shared/create-runtime-provider.js";

// Wired in extensions/providers/index.ts during registerAcpxAgent()
const auth = buildAmbientLoginAuth({
  displayName: "ACPX cursor",
  isConfigured: () => acpxInstances.has("cursor"),
  sourceLabel: "cursor acpx runtime",
});
```

## `AcpxDriver`

Built-in `ProviderDriver` (`driverKind: "acpx"`) in `extensions/providers/acpx-driver.ts`. Listed in `BUILT_IN_DRIVERS` and created through `ProviderDriverRegistry` in `extensions/providers/index.ts`.

### Config (`AcpxConfig`)

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `agent` | `string` | `"cursor"` | ACPX agent name passed to `ensureSession`. |
| `enabled` | `boolean` | `true` | Instance enabled flag. |

### `AcpxDriver.probe(config)`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `config` | `AcpxConfig` | (required) | Passed by the registry; availability checks `loadAcpxRuntime()` only. |

**Returns:** `{ available: true }` if `loadAcpxRuntime()` resolves; otherwise `{ available: false, reason: string }`.

### `AcpxDriver.create(input)`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `input.instanceId` | `string` | (required) | Registry instance id (`acpx-<agent>`). |
| `input.config` | `AcpxConfig` | (required) | Agent + enabled. |
| `input.cwd` | `string` | (required) | Project cwd; hashed to 12-char `cwdSlug` for state/session keys. |
| `input.displayName` | `string` | `` `ACPX ${agent}` `` | UI display name. |
| `input.enabled` | `boolean` | from input | Instance enabled flag. |

**Returns:** `ProviderInstance` with managed model snapshot, adapter, and `dispose` → `adapter.stopAll()`.

**Create side effects:**
- Runtime state dir: `~/.acpx/pi-<cwdSlug>/`
- `permissionMode: "approve-all"`
- Initial persistent session key: `pi-<agent>-default`
- Snapshot refresh uses a separate oneshot discovery helper

```typescript
const instance = await registry.createInstance(
  "acpx-cursor",
  { driver: "acpx", config: { agent: "cursor" }, enabled: true },
  projectCwd,
);
```

### Adapter: `startSession(opts)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `model` | `string` | `"default"` | ACPX model id (suffix of pi model id after `:`). |
| `systemPrompt` | `string` | from `buildExternalSystemPrompt` | Prompt applied when the handle is first created for that model. |
| `cwd` | `string` | (required by type) | Project cwd (adapter already bound at create). |

**Returns:** `{ sessionId, model }` where `sessionId` is `pi-<agent>[-<sanitizedModel>]-<cwdSlug>`.

### Adapter: `sendTurn(handle, prompt, opts?)`

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `handle` | `SessionHandle` | (required) | From `startSession`. |
| `prompt` | `string` | (required) | Latest user message text only. |
| `opts.signal` | `AbortSignal` | — | Aborts the turn. |
| `opts.onEvent` | `(event) => void` | — | Receives `{ kind: "text_delta" \| "thinking_delta", text }`. |

**Returns:** `TurnResult` — `{ text, thinking?, stopReason?, usage? }`.

**Stream mapping:** ACPX `text_delta` with `stream === "thought"` → `thinking_delta`; other `text_delta` → `text_delta`.

```typescript
const turn = runtime.startTurn({
  handle: acpxHandle,
  text: prompt,
  mode: "prompt",
  requestId: `pi-${Date.now()}-${randomSuffix}`,
  signal: abortController.signal,
});

for await (const event of turn.events) {
  if (event.type === "text_delta" && event.text) {
    // event.stream === "thought" → thinking_delta; else → text_delta
  }
}
```

> **Warning:** Only the latest user message is sent each turn. Full historical message arrays are not forwarded to the ACPX runtime.

### Adapter: `stopSession` / `stopAll`

| Method | Effect |
| :--- | :--- |
| `stopSession(handle)` | `runtime.close` for that model handle; clears prompt/usage tracking for the key. |
| `stopAll()` | Closes all handles; clears handle maps. Called from instance `dispose`. |

## Stream bridge (`StreamAssembler`)

`extensions/providers/index.ts` wraps `adapter.sendTurn` and feeds driver events into `StreamAssembler` (`extensions/shared/stream-builder.ts`) for native pi assistant streams.

| Step | Action |
| :--- | :--- |
| 1 | Resolve instance from `acpxInstances` |
| 2 | Parse model id: `agent:modelId` → driver model suffix |
| 3 | `adapter.startSession({ model, systemPrompt, cwd })` |
| 4 | `extractLatestUserMessage(context)` → prompt |
| 5 | `adapter.sendTurn(..., { onEvent: assembler.handleEvent })` |
| 6 | `assembler.finalize({ finalText, finalThinking, stopReason, usage })` |

## `runtime.ensureSession(options)`

ACPX runtime API used by discovery and the driver adapter.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `sessionKey` | `string` | (required) | Stable key (`discover-...` or `pi-<agent>...-<cwdSlug>`). |
| `agent` | `string` | (required) | Target agent id. |
| `mode` | `string` | (required) | `"oneshot"` for throwaway discovery; `"persistent"` for stream sessions. |
| `cwd` | `string` | (required) | Session working directory. |
| `sessionOptions` | `object` | omitted if empty | Optional `{ model?, systemPrompt? }`. |

```typescript
const handle = await runtime.ensureSession({
  sessionKey: "pi-cursor-gpt-4-a1b2c3d4e5f6",
  agent: "cursor",
  mode: "persistent",
  cwd: "/home/user/project",
  sessionOptions: {
    model: "gpt-4",
    systemPrompt: "You are being used as a backend LLM...",
  },
});
```

## Session shutdown

| Hook | Effect |
| :--- | :--- |
| `session_shutdown` | Stops CLI session reaper; `registry.teardownAll()` (each ACPX instance `dispose` → `adapter.stopAll()`); clears `cliInstances` and `acpxInstances`. |

```typescript
pi.on("session_shutdown", async () => {
  stopCliSessionReaper();
  await registry.teardownAll();
  cliInstances.clear();
  acpxInstances.clear();
});
```

## Related Pages

- [External AI Agents & CLI](external-ai-agents.html)
- [Configuration & Settings](configuration.html)
- [Pi Sidecar HTTP API](pi-sidecar.html)
- [Google Vertex Claude Provider](vertex-claude-provider.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
