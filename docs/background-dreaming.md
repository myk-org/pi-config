# Background Memory Consolidation (Dreaming)

The **Dreaming** system is an automated background worker that periodically consolidates, reorganizes, and extracts long-term memories from your recent AI sessions.

Instead of forcing you to manually tell the AI to "remember this," the dreaming worker quietly reads through your past conversations, identifies durable knowledge (like architectural decisions, repeated mistakes, and user preferences), and writes them into persistent memory files. This ensures your custom agents continuously learn and adapt without cluttering your workflow.

## The Big Picture: Architecture and Data Flow

The dreaming system runs asynchronously as a background agent. It operates entirely decoupled from your active session, communicating its results by directly manipulating the project's memory store.

### Dreaming Lifecycle Flow

1. **Trigger Phase**
   - **Interval:** The `dreamTimer` triggers every 3 hours by default.
   - **Shutdown:** A detached dream run automatically executes on `session_shutdown` (when quitting).
   - **Manual:** User explicitly triggers a run by typing `/dream`.
2. **Quality Gate**
   - Assesses recent `.jsonl` session files to verify they contain substantial interactions.
   - Skips trivial sessions (e.g., `< 3` exchanges, greetings only).
   - Uses a `.dream-watermark` file to ensure it only processes unread sessions (max 5 per cycle).
3. **Extraction & Synthesis (LLM Phase)**
   - Uses an async LLM (resolved via `decideAsyncLlmDispatch`) to process session transcripts.
   - Extracts categorized memories into dedicated markdown files (lessons, preferences, mistakes, completions, patterns, decisions).
   - Auto-generates formal `.pi/skills/<name>/SKILL.md` files for multi-step workflows.
4. **Rebuild & Consolidation (Sync Phase)**
   - On completion, triggers `rebuildAndOrganize` to deduplicate and rescore topic files.
   - Triggers `mergeProvenancePending` to link newly discovered memories back to their source sessions.
   - Triggers `runPromotionPass` to graduate mature memories into hard enforcements or structural rules.

### Process Architecture

| Component | Responsibility | Frequency / Trigger |
| :--- | :--- | :--- |
| **Async Agent Runner** | Spawns a non-blocking background LLM task to read transcripts and write to `.pi/memory/topics/`. | Every 3 hours / session end |
| **Rebuild Worker** | Lightweight, non-LLM worker that sorts, deduplicates, and rescores topic entries. | Every 30 minutes |
| **Promotion Engine** | Evaluates memories with high evidence scores for conversion into code guards. | Post-dream / threshold cross |
| **Watermark Tracker** | Prevents re-reading the same chat logs on subsequent cycles. | Updated per dream cycle |

## Key Concepts

### Topic Extraction
The dreamer categorizes unstructured chat logs into discrete markdown files under `.pi/memory/topics/`:
*   `lessons.md`: User corrections and workflow adjustments.
*   `preferences.md`: Stylistic or tool-specific preferences.
*   `mistakes.md`: Repeated errors and their successful fixes.
*   `completions.md`: Merged PRs and completed features.
*   `decisions.md`: Architectural or design choices made during the session.

> **Note:** The dreamer is strictly instructed to never modify entries marked with `*(pinned)*` or `*(enforced)*`. Any textual modification to enforced entries destroys their hash binding, permanently breaking the corresponding enforcement rule.

### Skill Auto-Generation
If the dreamer notices a recurring multi-step workflow across multiple sessions, it bypasses standard topic memory and directly generates a formal skill file at `.pi/skills/<name>/SKILL.md`. This gives future agents a structured, project-level checklist rather than a vague contextual memory.

### Promotion and Provenance
When extracting knowledge, the dreamer creates a "provenance sidecar" (`provenance-pending.json`). When the background task successfully completes, this data is merged into the master score registry (`memory-scores.json`), linking the new memory to the exact session file it originated from. Memories with high evidence scores are sent to the promotion queue to potentially become `*(enforced)*` command blocks.

## How it Affects the User

The internal dreaming system surfaces in your daily usage in several ways:

*   **UI Status Indicators:** While a dream is actively running, the terminal overlay or web dashboard displays a highlighted `🌙` (3b-dream) status indicator.
*   **Zero-Touch Learning:** You will notice agents naturally adopting your conventions in subsequent sessions without you having to explicitly invoke memory commands.
*   **Notifications:** If dreaming fails to start (e.g., missing async LLM configuration), the system will notify your chat view: `Dream skipped: set async_llm_provider and async_llm_model`.

### Using the Dreaming System

You can control the dreamer directly via chat commands:

*   `/dream-auto on|off`: Toggles the background timer and end-of-session trigger for the current project.
*   `/dream`: Manually forces a background consolidation pass immediately (non-blocking).

### Configuration Options

You can adjust the dreaming schedule and behavior using environment variables or project settings:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PI_DREAM_INTERVAL_HOURS` | Environment Var | `3` | Global override for the timer (valid range: 0.5 to 24 hours). |
| `dream_interval_hours` | Project Setting | `3` | Per-project setting defined in `.pi/settings.json`. |

> **Warning:** Dreaming requires a configured background LLM. If you are using ACPX (external providers), you must define `async_llm_provider` and `async_llm_model` in your configuration, or dreaming will be skipped.

## Extending the Dreaming System

The dreaming worker is built as an orchestrator extension using standard event hooks. If you are building custom plugins or native CLI providers, you can hook into the exact same lifecycle events the dreamer uses:

### Relevant Hooks

*   `pi.on("before_agent_start", (event, ctx) => {...})`: Used by the dreamer to initialize UI status immediately before the first prompt.
*   `pi.on("session_start", (event, ctx) => {...})`: Fired when a new workspace session begins. Used to track the current `cwd` and restart the dream timer.
*   `pi.on("session_shutdown", (event) => {...})`: Fired when the agent shuts down. Used to fire-and-forget a final detached dream before the node process fully exits (skips on `/reload` or `/resume`).

### Custom Rebuilds via spawnAsyncAgent

If your extension introduces a new memory format or tracking state, you can safely queue tasks in the `onComplete` callback of an async agent, just as the dreamer triggers `rebuildAndOrganize(cwd)`:

```typescript
const { id } = spawnAsyncAgent("worker", "Your custom background prompt...", cwd, agents, {
  fireAndForget: true,
  name: "CustomDream",
  onComplete: () => {
    // Executes synchronously in the main process when the background LLM task finishes
    runCustomConsolidation(cwd);
  }
});
```

## Related Pages

*   See [Curating Project Memory](curating-project-memory.html) for manual memory management and topic file structures.
*   See [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) for details on the `spawnAsyncAgent` API and tracking background execution.
*   See [Memory Architecture](memory-architecture.html) for how scoring, hashing, and provenance sidecars work under the hood.
*   See [Configuration & Settings](configuration.html) to properly configure your fallback async LLM providers.

## Related Pages

- [Memory Architecture](memory-architecture.html)
- [Curating Project Memory](curating-project-memory.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
