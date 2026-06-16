# Extension Architecture and Lifecycle Hooks

Every feature in pi-config — from blocking dangerous git commands to auto-injecting memories into system prompts — is powered by the **extension system**. Understanding how extensions register tools, commands, and event hooks is essential whether you're modifying an existing module or building a new one. This page explains the architecture end-to-end: how extensions load, what APIs are available, and when each lifecycle hook fires during a session.

## Why This Matters

When you type a message in pi, dozens of extension hooks fire in sequence: validating your environment, injecting memories into the system prompt, intercepting bash commands, and updating the status bar. Each of these behaviors is a discrete module registered through the same `ExtensionAPI` interface. Knowing where to plug in means you can:

- Add a new tool the LLM can call (like `ask_user` or `generate_image`)
- Intercept and block dangerous commands before they execute
- Inject context into system prompts before each agent turn
- React to session events (start, shutdown, compaction) for housekeeping
- Register slash commands users invoke directly

## The Big Picture: Extension Loading

Pi discovers extensions through the `pi` field in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "prompts": ["./prompts"]
  }
}
```

Pi scans the `extensions/` directory and loads every subdirectory that contains an `index.ts` with a default export function. Each extension receives a single `ExtensionAPI` instance:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, and event hooks here
}
```

### Extension Inventory

Pi-config ships seven extensions, each independently loadable:

| Extension | Entry Point | Purpose |
|-----------|-------------|---------|
| **orchestrator** | `extensions/orchestrator/index.ts` | Core brain — agent routing, enforcement, rules, memory, dreaming, async agents, cron, status line |
| **coms** | `extensions/coms/index.ts` | Inter-agent P2P and networked communication |
| **pidash** | `extensions/pidash/index.ts` | Live web dashboard connection |
| **pidiff** | `extensions/pidiff/index.ts` | Diff viewer with review comments |
| **image-gen** | `extensions/image-gen/index.ts` | Image generation via Gemini API |
| **acpx-provider** | `extensions/acpx-provider/index.ts` | Route LLM requests through external AI agents |
| **shared** | `extensions/shared/` | Utility library (not a standalone extension — imported by pidash/pidiff) |

> **Note:** Each extension loads in its own call. The orchestrator extension is the largest — it internally wires 18+ modules via dedicated `register*()` functions. Standalone extensions like `image-gen` can be as simple as a single `registerTool()` call.

### The Orchestrator's Internal Module System

The orchestrator extension doesn't put all logic in one file. Instead, `index.ts` imports specialized modules and calls their registration functions in a specific order:

```
registerExtendedAutocomplete(pi)    ← MUST be first (wraps registerCommand)
registerAskUser(pi, ...)
registerAsyncAgents(pi, ...)        ← returns spawnAsyncAgent, killAsyncAgent
registerSubagentTool(pi, ...)       ← receives async agent functions
registerProjectSettings(pi)
registerEnforcement(pi, ...)
registerRules(pi, ...)              ← receives getAsyncJobs for status injection
registerStatusLine(pi, ...)
registerBtw(pi)
registerDreaming(pi, ...)
registerCron(pi, ...)
registerSessionValidation(pi)
registerGithubAutocomplete(pi)
registerStatus(pi, ...)
registerNvim(pi)
registerPreferenceExtractor(pi)
registerMemoryTools(pi)
registerSessionSearch(pi)
```

> **Warning:** Order matters. `registerExtendedAutocomplete` wraps `pi.registerCommand` to inject argument completions, so it **must** run before any other module calls `registerCommand`. Similarly, `registerAsyncAgents` returns functions that `registerSubagentTool` and `registerDreaming` depend on.

## The Four Registration APIs

Extensions interact with pi through four primary registration methods on the `ExtensionAPI` object:

### 1. `pi.registerTool()` — LLM-Callable Tools

Tools are functions the AI can invoke during a conversation. Each tool has a schema, an async `execute` function, and optional rendering hooks for the TUI.

```typescript
pi.registerTool({
  name: "ask_user",
  label: "Ask User",
  description: "Present a question to the user with selectable options.",
  promptSnippet: "Ask the user a question with selectable options",
  promptGuidelines: [
    "Use ask_user when you need user input during a workflow.",
    "Do NOT ask users questions via plain text.",
  ],
  parameters: Type.Object({
    question: Type.String({ description: "The question to display" }),
    options: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    // Tool implementation — return { content: [...] }
  },
  renderCall(args, theme, context) { /* TUI display for tool invocation */ },
  renderResult(result, options, theme, context) { /* TUI display for result */ },
});
```

**Key properties:**

| Property | Required | Purpose |
|----------|----------|---------|
| `name` | Yes | Unique identifier the LLM calls |
| `description` | Yes | Tells the LLM when/how to use this tool |
| `promptSnippet` | No | Short description injected into the system prompt |
| `promptGuidelines` | No | Array of usage instructions injected into the system prompt |
| `parameters` | Yes | TypeBox schema defining the tool's input parameters |
| `execute` | Yes | Async function that runs when the LLM calls this tool |
| `renderCall` | No | Custom TUI rendering for the tool invocation |
| `renderResult` | No | Custom TUI rendering for the tool result |

**Registered tools in pi-config:** `subagent`, `ask_user`, `memory_search`, `memory_reinforce`, `memory_add`, `memory_remove`, `memory_edit`, `memory_reflect`, `memory_consolidate`, `memory_topics`, `session_search`, `cron_manage`, `generate_image`, plus coms tools.

### 2. `pi.registerCommand()` — Slash Commands

Commands are user-invoked actions triggered by typing `/command-name` in the input. They run directly — no LLM roundtrip needed.

```typescript
pi.registerCommand("btw", {
  description: "Ask a quick side question without polluting conversation history",
  getArgumentCompletions: (prefix: string) => { /* optional Tab completions */ },
  handler: async (args, ctx) => {
    // Command implementation
    ctx.ui.notify("Done!", "info");
  },
});
```

**Key properties:**

| Property | Required | Purpose |
|----------|----------|---------|
| `description` | Yes | Shown in command help/autocomplete |
| `handler` | Yes | Async function receiving `(args: string, ctx)` |
| `getArgumentCompletions` | No | Returns autocomplete suggestions for Tab |

**User-visible effect:** Users type `/btw what does this function do?` and get an instant response without the AI processing a full turn. See [Slash Commands and Extension Commands Reference](commands-reference.html) for all available commands.

> **Tip:** The orchestrator wraps `pi.registerCommand` to capture every command handler into a shared registry. This lets the pidash web dashboard execute commands remotely from the browser. If you register commands in a separate extension, use `pi.events` to bridge them (see the inter-extension communication section below).

### 3. `pi.on()` — Event Hooks

Event hooks are the backbone of the extension system. They let you react to (and modify) every phase of a pi session. Each hook receives an `event` object and a `ctx` context.

```typescript
pi.on("session_start", async (event, ctx) => {
  // Runs once when a session begins
});

pi.on("before_agent_start", async (event, ctx) => {
  // Runs before each LLM turn — can modify the system prompt
  return { systemPrompt: event.systemPrompt + "\n\nExtra instructions" };
});
```

The full lifecycle hook reference is in the next section.

### 4. `pi.registerProvider()` — Model Providers

Provider registration lets extensions add custom LLM backends. The ACPX provider extension uses this to route requests through external AI agents:

```typescript
pi.registerProvider(`acpx-${agent}`, {
  // Provider configuration for model discovery and request routing
});
```

This is an advanced API primarily used by the `acpx-provider` extension. Most extensions won't need it.

## Lifecycle Hooks in Detail

Hooks fire at specific points during a pi session. Some are informational (observe only), while others can **modify** behavior by returning values.

### Hook Execution Timeline

Here is the order hooks fire during a typical session:

1. **`session_start`** — Session begins (or resumes)
2. **`input`** — User types a message
3. **`before_agent_start`** — Just before the LLM processes the message
4. **`agent_start`** — LLM turn begins
5. **`tool_call`** — LLM requests a tool execution *(can block)*
6. **`tool_result`** / **`tool_execution_end`** — Tool finishes
7. **`turn_end`** — One LLM turn completes (may loop back to step 5 for multi-turn)
8. **`agent_end`** — Full agent response complete
9. *(repeat steps 2–8 for each user message)*
10. **`session_compact`** — Session history compacted (summarized)
11. **`session_shutdown`** — Session ends

### Hook Reference

| Hook | Can Modify? | Event Data | When It Fires |
|------|:-----------:|------------|---------------|
| `session_start` | No | `event`, `ctx` (with `ctx.cwd`, `ctx.hasUI`, `ctx.mode`) | Once when session opens or resumes |
| `input` | No | `event.text` — the user's raw message | Every user message, before LLM processing |
| `before_agent_start` | **Yes** | `event.systemPrompt`, `event.prompt` | Before each LLM turn; return `{ systemPrompt }` to modify |
| `tool_call` | **Yes** | `event.input` (tool parameters), tool name via `isToolCallEventType()` | Before a tool executes; return `{ block: true, reason }` to prevent |
| `tool_result` | No | Tool output data | After a tool completes |
| `tool_execution_end` | No | Tool execution metadata | After tool execution fully finishes |
| `turn_end` | No | `event.response`, `event.toolResults` | After one LLM turn completes |
| `agent_start` | No | — | When the LLM begins processing |
| `agent_end` | No | — | When the full agent response is done |
| `model_select` | No | Model selection data | When the user switches models |
| `session_compact` | No | Compaction/summary data | When session history is summarized |
| `session_shutdown` | No | — | When the session is ending |

### How Each Hook Is Used

**`session_start`** — Initialization and environment validation:
- Check for required CLI tools (`uv`, `gh`, `mcpl`) and notify about missing ones
- Bootstrap vector embeddings for semantic memory search
- Rebuild and reorganize memory scores
- Connect to daemons (pidash, pidiff)
- Start background pollers (git status every 5s, timestamp updates every 30s)
- Clean up zombie async agents from dead parent processes
- Restore persisted cron tasks

**`input`** — Passive observation of user messages:
- Extract user preferences ("I prefer...", "always use...", "never...") and write them to memory automatically
- Track session keywords for session search indexing

**`before_agent_start`** — System prompt augmentation (the most powerful hook):
- Prepend the **situation report** (scored, token-budgeted memory summary)
- Run **vector search** against the user's message and inject contextually relevant memories
- Inject **past session summaries** matching the current topic
- Append all **orchestrator rules** (from `rules/*.md` files)
- Append **async agent status** so the LLM knows what's running in the background

> **Note:** The `before_agent_start` hook is what makes memory, rules, and context injection work. Without it, the LLM would have no knowledge of your preferences, past decisions, or orchestrator rules. See [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html) for the injection pipeline details.

**`tool_call`** — Command enforcement (the gatekeeper):
- Block `python`/`pip` (require `uv` wrapper)
- Block `git commit`/`push` outside the `git-expert` agent
- Block commits to protected branches
- Block `git add .` (require specific file staging)
- Block remote script execution (`curl | sh`)
- Block dangerous commands (require user confirmation)
- Block repeated identical commands (anti-polling-spam)
- Inject co-author trailers into git commits
- Strip timeouts from long-running poll commands

> **Note:** This is a representative sample. The full enforcement ruleset — including blocking sleep loops, direct docker/podman CLI in containers, memory writes from subagents, and git hooks bypass — is documented in [Command Safety Guards and Enforcement](command-enforcement.html).

**`turn_end`** — Post-turn analysis:
- Update git status in the status bar
- Check modified files against memory for contextual reminders
- Track retrieval telemetry (were injected memories used in the response?)

**`session_shutdown`** — Cleanup:
- Index session summary for future keyword search
- Trigger a final dream (memory consolidation) if enabled
- Disconnect from daemons
- Stop cron tasks and pollers
- Clean up temp files

### The Social Closer Gate

Not every message deserves expensive processing. The `before_agent_start` hook skips vector search and session history injection for trivial messages like "ok", "thanks", "👍", or short emoji-only messages. This is the **social closer gate** — it prevents wasted computation on messages that don't need contextual memory:

```
"ok", "yes", "no", "thanks", "thank you", "got it", "sure",
"right", "correct", "agreed", "nice", "cool", "great", "perfect",
"👍", "🙏", "✅", "👌", "🎉", "💯", "🚀"
```

## Inter-Extension Communication

Extensions are loaded independently, but they often need to coordinate. Pi-config uses the **`pi.events` bus** — a typed event emitter shared across all extensions — for cross-extension communication.

### Common Event Patterns

| Event | Emitter | Listener | Purpose |
|-------|---------|----------|---------|
| `pidash:register-command` | orchestrator | pidash | Share command handlers for browser execution |
| `pidash:request-commands` | pidash | orchestrator | Request replay of all registered commands |
| `pidash:command-ctx` | orchestrator | pidash | Share the latest command context |
| `pidash:ui-request` | orchestrator (ask_user) | pidash | Forward user prompts to browser |
| `pidash:ui-response` | pidash | orchestrator (ask_user) | Return browser answers to TUI |
| `pidash:async-status` | orchestrator | pidash | Forward async agent status updates |
| `pidash:async-kill` | pidash | orchestrator | Kill async agents from browser |
| `diff-viewer:port` | pidiff | pidash | Share the diff viewer port |

This pattern solves the **extension load order problem**: pidash may load before or after the orchestrator, but the event replay mechanism ensures command handlers are always available.

```typescript
// Orchestrator: emit on registration
pi.events.emit("pidash:register-command", { name, handler });

// Pidash: listen and request replay
pi.events.on("pidash:register-command", (data) => { /* store handler */ });
pi.events.emit("pidash:request-commands"); // trigger replay of all handlers
```

## Mode-Aware Guards

Pi runs in four modes, and not all extension features make sense in every mode. Use `ctx.mode` to conditionally enable features:

| Mode | Description | Available Features |
|------|-------------|--------------------|
| `"tui"` | Interactive terminal session | Everything — full UI, daemons, autocomplete |
| `"rpc"` | Programmatic API access | Tools, hooks, notifications — no autocomplete |
| `"json"` | Structured output (one-shot) | Tools and hooks only — no timers, daemons |
| `"print"` | Single response (one-shot) | Tools and hooks only — no timers, daemons |

Use `ctx.hasUI` when you just need to know whether UI methods (`notify`, `select`, `confirm`) are available — this returns `true` for both `tui` and `rpc` modes.

```typescript
// Only connect to daemons in interactive mode
if (ctx.mode === "tui") { connectToDaemon(); }

// Only show notifications when UI is available (tui or rpc)
if (ctx.hasUI) { ctx.ui.notify("Task completed", "info"); }

// Skip timers in one-shot modes
if (ctx.mode !== "print" && ctx.mode !== "json") { startCronScheduler(); }
```

## Subagent Isolation

When the orchestrator delegates to a specialist agent, the child process runs with `PI_SUBAGENT_CHILD=1` in its environment. Many extension modules check this flag to avoid duplicate behavior:

```typescript
// Only the orchestrator registers memory tools
if (process.env.PI_SUBAGENT_CHILD === "1") return;
```

**Modules that skip registration in subagents:**
- Memory tools (read-only access via rules injection)
- Preference extractor
- Dreaming
- Async agent infrastructure
- Autocomplete providers
- Session search
- Cron scheduling
- Pidash/pidiff connections

**What subagents DO get:**
- Enforcement rules (tool_call blocking)
- The situation report (injected via `before_agent_start` with a "do NOT write to memory" instruction)
- Status line updates

## Writing a New Extension Module

To add a new module to the orchestrator extension:

1. **Create the module file** in `extensions/orchestrator/`:
   ```typescript
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

   export function registerMyFeature(pi: ExtensionAPI): void {
     if (process.env.PI_SUBAGENT_CHILD === "1") return; // if orchestrator-only

     pi.on("session_start", (_event, ctx) => {
       // Initialize on session start
     });

     pi.registerCommand("my-command", {
       description: "Does something useful",
       handler: async (args, ctx) => { /* ... */ },
     });
   }
   ```

2. **Import and wire it** in `extensions/orchestrator/index.ts`:
   ```typescript
   import { registerMyFeature } from "./my-feature.js";
   // ... inside the default export function:
   registerMyFeature(pi);
   ```

3. **Consider ordering** — if your module wraps `registerCommand` or depends on functions returned by another module, place it at the right point in the registration sequence.

To create a **standalone extension** (separate from the orchestrator):

1. Create a new directory under `extensions/` with an `index.ts`:
   ```typescript
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

   export default function (pi: ExtensionAPI) {
     pi.registerTool({ /* ... */ });
   }
   ```

2. Pi will auto-discover and load it alongside the other extensions.

> **Tip:** Keep standalone extensions independent — they should work even if the orchestrator extension isn't loaded. Use `pi.events` for optional coordination with other extensions.

## Related Pages

- [Orchestrator Rules Reference](rules-reference.html) — the rules files loaded by the `before_agent_start` hook
- [Specialist Agents Reference](agents-reference.html) — how agents are discovered and routed by the subagent tool
- [Slash Commands and Extension Commands Reference](commands-reference.html) — all registered commands
- [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html) — the memory injection pipeline in `before_agent_start`
- [Configuration and Environment Variables Reference](configuration-reference.html) — settings that control extension behavior (`PI_PIDASH_ENABLE`, `PI_DREAM_INTERVAL_HOURS`, etc.)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — how `registerAsyncAgents` and `registerCron` work from the user's perspective
- [Command Safety Guards and Enforcement](command-enforcement.html) — full enforcement ruleset applied by the `tool_call` hook
- [Customization and Extension Recipes](customization-recipes.html) — step-by-step guides for adding agents, commands, and project settings

## Related Pages

- [Orchestrator Rules Reference](rules-reference.html)
- [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html)
- [Specialist Agents Reference](agents-reference.html)
- [Command Safety Guards and Enforcement](command-enforcement.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
