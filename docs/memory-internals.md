# Memory Scoring, Embeddings, and Situation Reports

Pi's memory system doesn't just store facts — it *forgets* them. Like biological memory, entries that aren't reinforced fade over time, while frequently referenced knowledge becomes stronger. This means the context injected into every conversation is always relevant, concise, and current — without any manual curation.

This page explains the internal mechanics: how scores are calculated, how vector embeddings power semantic recall, how topic files organize knowledge, and how the situation report compresses it all into a token budget for every system prompt.

> **Note:** For hands-on usage — adding memories, searching, dreaming, and capacity management — see [Working with Project Memory](memory-system.html). This page covers the *engine underneath*.

## Architecture Overview

The memory system is a four-layer pipeline. Each layer has a distinct job:

| Layer | Module | Responsibility |
|-------|--------|----------------|
| **1. Scored Memory** | `memory-scoring.ts` | Stability formula, decay, evidence counting, lifecycle states |
| **2. Topic Tree** | `memory-tree.ts` | Markdown topic files — the source of truth for all entries |
| **3. Vector Embeddings** | `memory-embeddings.ts` | Semantic search via in-process ONNX model (bge-small-en-v1.5) |
| **4. Situation Report** | `situation-report.ts` | Token-budgeted, priority-ordered context block for system prompts |

These layers feed into an **auto-injection pipeline** (`rules.ts`) that runs on every turn — inserting the right memories at the right time without any user action.

### Data Flow: From Entry to System Prompt

1. A memory is added (via `memory_add` tool, preference auto-extraction, or dreaming)
2. A vector similarity check runs against existing entries in the same category (≥ 0.85 = near-duplicate → reinforce instead of adding)
3. If not a duplicate, the entry is written to the appropriate topic file under `.pi/memory/topics/`
4. A stability score is computed and stored in `memory-scores.json`
5. The entry is embedded as a 384-dim vector and stored in `embeddings.json`
5. On each turn, `before_agent_start` fires:
   - The situation report selects scored entries within a token budget
   - A vector search finds contextually relevant memories for the current message
   - Past session summaries are keyword-searched for additional context
6. All three blocks are prepended to the system prompt

## Layer 1: Stability-Based Scoring

Every memory entry has a **stability score** that decays exponentially over time. The score determines whether an entry stays active, gets demoted, or is dropped entirely.

### The Stability Formula

```
stability = cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)
```

| Component | What It Measures | Effect |
|-----------|-----------------|--------|
| `cue_weight` | How the memory was produced | Explicit (user-stated) memories start stronger |
| `exp(-Δt / half_life)` | Time since last reinforcement | Exponential decay — old, unreinforced memories fade |
| `ln(1 + evidence_count)` | How many times it's been reinforced | Logarithmic boost — first few reinforcements matter most |

Two special cases override the formula:

- **Pinned entries** → score is always `9999` (never decay)
- **Forgotten entries** → score is always `0` (always dropped)

### Cue Weights

Not all evidence is equal. The source of the memory affects its initial strength:

| Cue Type | Weight | When Used |
|----------|--------|-----------|
| `explicit` | 1.0 | User explicitly said "remember this", or added via `memory_add` |
| `structural` | 0.9 | Derived from project structure or configuration |
| `behavioral` | 0.7 | Observed from user behavior patterns (auto-extracted) |
| `recurrence` | 0.6 | Detected from recurring patterns across sessions |

### Decay Half-Lives

Each memory category decays at a different rate, reflecting how long that type of knowledge typically stays relevant:

| Category | Half-Life | Rationale |
|----------|-----------|-----------|
| `preference` | 90 days | Personal preferences change slowly |
| `lesson` | 60 days | Learned knowledge stays relevant for weeks |
| `pattern` | 30 days | Code patterns can shift with refactors |
| `decision` | 30 days | Architectural decisions may be revisited |
| `done` | 14 days | Completed work becomes irrelevant quickly |
| `mistake` | 14 days | Mistakes are worth remembering briefly, then usually resolved |

> **Tip:** Calling `memory_reinforce` on an entry resets its decay clock and bumps the evidence count. This is the primary mechanism for keeping important memories alive. The orchestrator is instructed to do this automatically whenever it notices a memory is relevant to the current task.

### Lifecycle States

Based on its stability score, every entry is assigned a lifecycle state:

| State | Score Threshold | Meaning |
|-------|----------------|---------|
| `active` | ≥ 1.5 | Included in the situation report |
| `provisional` | ≥ 0.7 | Overflow — included if budget allows |
| `candidate` | ≥ 0.4 | At risk of being dropped |
| `dropped` | < 0.4 | Not injected, may be archived |

The lifecycle state is recalculated during **rebuild cycles** which happen:
- On every `session_start`
- Every 30 minutes (cheap, no LLM call — just rescores existing entries)
- After dreaming completes

### Budget Caps

To prevent any single category from dominating the context window, per-category budget caps limit how many entries can be `active`:

| Category | Max Active Entries |
|----------|--------------------|
| `preference` | 8 |
| `lesson` | 8 |
| `pattern` | 6 |
| `decision` | 4 |
| `done` | 4 |
| `mistake` | 4 |

Entries that exceed their category budget are demoted to `provisional`. A cross-category **overflow pool** of 6 slots holds the highest-scoring provisional entries. The **total cap** across all categories is 40 active entries.

## Layer 2: Topic Tree Organization

All memory entries live in Markdown files under `.pi/memory/topics/`. These files are the **source of truth** — the scoring layer reads from them, not the other way around.

```
.pi/memory/
├── memory-scores.json       # Stability scores (auto-managed)
├── embeddings.json           # Vector embeddings (auto-managed)
└── topics/
    ├── preferences.md        # [preference] entries
    ├── lessons.md            # [lesson] entries
    ├── patterns.md           # [pattern] entries
    ├── decisions.md          # [decision] entries
    ├── completions.md        # [done] entries
    └── mistakes.md           # [mistake] entries
```

Each topic file uses a simple format:

```markdown
# Preferences

- [preference] Always use --admin for gate-blocked PRs *(pinned)*
- [preference] User prefers concise responses
- [preference] Use conventional commits for commit messages
```

### Size Limits

Each topic file is capped at **~12,000 characters** (roughly 3,000 tokens). When a topic file would exceed this limit, `memory_add` refuses the write and instructs the LLM to consolidate or remove entries first.

### Topic Hotness

Each topic has a **hotness score** — the sum of stability scores for all entries in the topic. Hotter topics are prioritized in the situation report. Topics that go cold (no reinforcement for 2× the category's half-life) are automatically archived (deleted), unless they contain pinned entries.

### Category-to-Topic Mapping

| Category | Topic File |
|----------|------------|
| `preference` | `preferences.md` |
| `lesson` | `lessons.md` |
| `pattern` | `patterns.md` |
| `decision` | `decisions.md` |
| `done` | `completions.md` |
| `mistake` | `mistakes.md` |

## Layer 3: Vector Embeddings

Vector embeddings enable **semantic search** — finding memories that are conceptually related to a query even when they don't share any keywords. This powers both the `memory_search` tool and the automatic contextual injection on every turn.

### Model Details

| Property | Value |
|----------|-------|
| Model | `Xenova/bge-small-en-v1.5` |
| Dimensions | 384 |
| Runtime | ONNX via `@huggingface/transformers` (in-process, no Python) |
| Download size | ~50 MB (first run only) |
| Init time | ~2.7 seconds (first call per session) |
| Search latency | ~2.5 ms per query |
| API keys | None — runs entirely locally |

### How It Works

1. **Embed on write:** When `memory_add` creates an entry, it's immediately embedded and the vector is stored in `.pi/memory/embeddings.json`
2. **Dedup on write:** Before inserting a new entry, `memory_add` computes vector similarity against all existing entries in the same category. If a near-duplicate is found (similarity ≥ 0.85), the existing entry is **reinforced** instead of creating a duplicate. This catches semantically equivalent memories even when worded differently (e.g., "use conventional commits" vs. "always write conventional commit messages"). If the vector check is unavailable, the system falls back to exact text matching.
3. **Embed on first search:** If any existing entries lack embeddings (e.g., after upgrading from a pre-embedding version), the first `memory_search` call batch-embeds all missing entries
4. **Search:** The query is embedded, then cosine similarity is computed against all stored vectors
5. **Hybrid results:** Vector search results are merged with keyword search results, deduplicated, and ranked by a combined score (similarity × 100 + stability score)

### Embedding Key Format

Each embedding is keyed by a truncated SHA-256 hash of `[category] text` — this prevents cross-category collisions where the same text appears in different categories.

### Near-Duplicate Detection Threshold

The dedup similarity threshold is **0.85** (cosine similarity). This value balances precision and recall:

| Similarity | Behavior |
|------------|----------|
| ≥ 0.85 | Treated as near-duplicate — existing entry is reinforced, new entry is not added |
| 0.65–0.84 | Treated as contextually relevant (used for search recall), but distinct enough to store separately |
| < 0.65 | Not related — no match |

> **Note:** If the dedup check reinforces an existing entry, the just-embedded vector for the new text is removed from the store to keep embeddings clean.

### Graceful Fallback

If the `@huggingface/transformers` package is unavailable or the model fails to load, the system falls back to **keyword-only search** and **exact-match dedup**. No errors are thrown — callers always get results.

> **Note:** Embeddings are stored per-project in `.pi/memory/embeddings.json`. The model is loaded once per process and cached for the session lifetime.

## Layer 4: Situation Reports

The situation report is the final output of the memory system — a structured, priority-ordered Markdown block injected into the system prompt on every turn. It replaces a raw dump of all memories with a curated, token-budgeted summary.

### Token Budget

The default budget is **1,700 tokens**. The actual budget is dynamically adjusted based on the size of the system prompt (rules, skills, context files):

```
available_memory_budget = min(1700, 8000 - system_prompt_tokens)
```

If the system prompt already consumes the entire 8,000-token budget, memory injection is skipped entirely.

### Section Priority

The report is built section-by-section in priority order. Higher-priority sections are always included; lower-priority sections are truncated or dropped when the budget runs out:

| Priority | Section | Token Budget | Filter |
|----------|---------|--------------|--------|
| — | **Pinned** | Unlimited | All pinned entries (always first) |
| 1 | Active Preferences | 400 | `preference` entries |
| 2 | Active Lessons | 400 | `lesson` entries |
| 3 | Vetoes & Mistakes | 200 | `mistake` entries |
| 4 | Patterns | 200 | `pattern` entries |
| 5 | Recent Decisions | 200 | `decision` entries from last 7 days |
| 6 | Recent Completions | 200 | `done` entries from last 3 days |

Within each section, entries are sorted by stability score (highest first). If a section exceeds its token budget, lower-scored entries are omitted with a count indicator (e.g., "... 3 more (lower priority, omitted for context budget)").

### Capacity Signal

The report header displays current usage as a percentage:

```
# Project Memory [72% — 1,224/1,700 tokens]
```

When usage exceeds **80%**, a consolidation warning is injected:

```
> ⚠️ Memory above 80% capacity. Before adding new entries, consolidate or
> remove existing ones using memory_remove.
```

This warning is visible to the LLM, which then knows to consolidate before adding more entries.

### Ground Truth Instruction

Every situation report includes a Ground Truth instruction:

> **Ground Truth:** Memories above and contextually relevant memories injected below are authoritative. Use them directly — do not re-discover or re-verify information already in your context window.

This prevents the LLM from wasting tokens re-verifying facts it already has in context.

## The Auto-Injection Pipeline

The `rules.ts` module orchestrates all memory injection through lifecycle hooks. Here's what happens on each turn:

### On `session_start`

1. Run `rebuildAndOrganize()` — rescore all entries from topic files
2. Bootstrap vector embeddings — embed any entries missing from the store
3. Reset dream state and start timers (rebuild every 30 min, dream every 3 hours)

### On `before_agent_start` (every turn)

This is the main injection point. The system prompt is constructed in this order:

1. **Situation report** — scored, token-budgeted memory summary
2. **Contextual memory recall** — vector search against the user's current message (top 5, similarity > 0.65)
3. **Session history recall** — keyword search against past conversation summaries (top 3)
4. **Original system prompt** — the agent's base instructions
5. **Orchestrator rules** — all `rules/*.md` files (orchestrator only)
6. **Async agent status** — what background agents are currently running

> **Note:** The social closer gate skips vector and session search for trivial messages ("ok", "thanks", "yes", emoji-only). This avoids wasting computation on messages that don't need contextual recall.

### On `turn_end`

After each response, two things happen:

1. **Retrieval telemetry** — logs whether injected memories were actually referenced in the LLM's response (written to `.pi/data/memory-telemetry.jsonl`)
2. **File-change memory reminder** — if the LLM modified files during the turn, a vector search runs against the modified file paths. Relevant memories (similarity > 0.70) are surfaced as a follow-up reminder

### On `input` (Preference Auto-Extraction)

The preference extractor (`preference-extractor.ts`) listens to every user message and pattern-matches for preference signals:

| Pattern | Example |
|---------|---------|
| "I prefer..." | "I prefer tabs over spaces" |
| "Always use..." | "Always use conventional commits" |
| "Never use..." | "Never use sudo in containers" |
| "From now on..." | "From now on, run tests before committing" |
| "My timezone..." | "My timezone is UTC+2" |

Detected preferences are automatically added to `preferences.md` with `cue: explicit` scoring. If the preference already exists, it's reinforced instead. A 1-hour cooldown prevents the same preference from being re-extracted repeatedly.

### On `session_shutdown`

1. Accumulated user messages are indexed into the session search store (`.pi/data/session-search.json`, max 500 entries)
2. If auto-dreaming is enabled, a background dream is fired (detached process — survives session exit)

## Retrieval Telemetry

Every auto-injection is logged to `.pi/data/memory-telemetry.jsonl` with:

- **Injection events** — what memories were injected, the truncated prompt that triggered them
- **Usage events** — whether the LLM actually referenced injected memories in its response, with a usage rate (`usedCount / injectedCount`)
- **Session injection events** — when past session summaries are injected

The file is capped at 500 KB (older entries trimmed to the last 200 lines).

> **Tip:** This telemetry helps you understand which memories are being used and which are being ignored — useful for tuning memory quality over time.

## Storage File Reference

| File | Format | Purpose |
|------|--------|---------|
| `.pi/memory/topics/*.md` | Markdown | Source of truth — all memory entries |
| `.pi/memory/memory-scores.json` | JSON | Stability scores, evidence counts, lifecycle states |
| `.pi/memory/embeddings.json` | JSON | Vector embeddings (384-dim float arrays keyed by SHA-256 hash) |
| `.pi/data/session-search.json` | JSON | Past conversation summaries for keyword search |
| `.pi/data/memory-telemetry.jsonl` | JSONL | Retrieval telemetry logs |
| `.pi/memory/.dream-watermark` | Plaintext | Timestamp of last dream — prevents reprocessing |

## Extension Points

If you're modifying the memory system or building on top of it, here are the key functions and hooks:

### Scoring Functions (`memory-scoring.ts`)

| Function | Signature | Purpose |
|----------|-----------|---------|
| `calculateStability()` | `(cue, evidenceCount, lastReinforcedAt, nowMs, category, userState) → number` | Core scoring formula |
| `lifecycleFromScore()` | `(score, userState) → LifecycleState` | Map score to lifecycle state |
| `rebuild()` | `(cwd, entries) → RebuildResult` | Full rebuild cycle: score all entries, apply budgets |
| `reinforce()` | `(cwd, entryLine) → boolean` | Bump evidence count for an entry |
| `getActiveEntries()` | `(cwd) → {hash, entry}[]` | Get all active/provisional entries, sorted by score |
| `entryHash()` | `(text) → string` | FNV-1a hash for entry keys |
| `extractPreferences()` | `(text) → string[]` | Pattern-match preference statements from text |

### Embedding Functions (`memory-embeddings.ts`)

| Function | Signature | Purpose |
|----------|-----------|---------|
| `initEmbeddings()` | `() → Promise<boolean>` | Initialize the ONNX model (lazy, cached) |
| `embedEntry()` | `(cwd, text, category?) → Promise<void>` | Embed and store a single entry |
| `removeEmbedding()` | `(cwd, text, category?) → void` | Remove an entry's embedding |
| `vectorSearch()` | `(cwd, query, entries, topK?) → Promise<results[]>` | Semantic search by cosine similarity |
| `embedMissing()` | `(cwd, entries) → Promise<number>` | Batch-embed entries without existing embeddings |

### Situation Report Functions (`situation-report.ts`)

| Function | Signature | Purpose |
|----------|-----------|---------|
| `buildSituationReport()` | `(cwd, tokenBudget?) → string` | Build the token-budgeted Markdown report |
| `rebuildAndOrganize()` | `(cwd) → void` | Rescore all entries from topic files |
| `estimateMemoryBudget()` | `(systemPromptLength, totalBudget?) → number` | Dynamic budget based on system prompt size |

### Lifecycle Hooks

| Hook | When | What the memory system does |
|------|------|-----------------------------|
| `session_start` | Session begins | Rebuild scores, bootstrap embeddings, start timers |
| `before_agent_start` | Every turn | Inject situation report + contextual memories + session history |
| `turn_end` | After each response | Log retrieval telemetry, file-change memory reminders |
| `input` | User types a message | Auto-extract preferences |
| `session_compact` | Context compaction | Index compacted summary for session search |
| `session_shutdown` | Session ends | Index accumulated messages, trigger background dream |

## Related Pages

- [Working with Project Memory](memory-system.html) — hands-on guide to using the memory system: adding, searching, dreaming, and managing capacity
- [Extension Architecture and Lifecycle Hooks](extension-architecture.html) — how hooks like `before_agent_start` and `turn_end` work in the extension system
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — how dreaming runs as an async background agent
- [Configuration and Environment Variables Reference](configuration-reference.html) — `PI_DREAM_INTERVAL_HOURS` and other memory-related settings
- [Orchestrator Rules Reference](rules-reference.html) — the `35-memory.md` rule that governs LLM memory behavior

## Related Pages

- [Working with Project Memory](memory-system.html)
- [Extension Architecture and Lifecycle Hooks](extension-architecture.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Orchestrator Rules Reference](rules-reference.html)
