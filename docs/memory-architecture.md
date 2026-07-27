# Memory Architecture

Understanding how Pi stores, scores, and retrieves memory is essential for building agents that improve over time and retain context across sessions. The memory architecture transforms raw interactions into a structured, persistent knowledge base that guides future agent behavior.

By leveraging this architecture, your agents won't just solve immediate problems—they will adapt to project conventions, remember user preferences, and enforce security policies without requiring manual rule updates.

## The Big Picture

The memory system is built as a multi-layered pipeline that prioritizes, retrieves, and injects context based on relevance and history.

1. **Scored Memory (`memory-scores.json`)** — Tracks raw memory entries using a stability formula. Memories have an evidence count and decay over time unless reinforced.
2. **Topic Tree (`.pi/memory/topics/`)** — Organizes scored entries into structured Markdown topic files (~3000 tokens each). Cold topics are automatically archived.
3. **Vector Embeddings (`embeddings.json`)** — Generates local semantic embeddings (using `Xenova/bge-small-en-v1.5`) without requiring external API keys. Enables hybrid keyword and vector search.
4. **Situation Reports** — Dynamically builds a token-budgeted context block from the highest-priority active memories.
5. **Auto-Injection Pipeline** — Injects the Situation Report at the **tail end** of the system prompt (where LLM attention is statistically highest) just before the agent starts a turn.

## Key Concepts

### Topic Scoring and Decay

Memories aren't static; they live in a dynamic ecosystem governed by a stability formula:
`cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)`

Each memory falls into a category with a specific half-life:
- **Preferences:** 90 days
- **Lessons:** 60 days
- **Done/Tasks:** 14 days

As a memory ages without being referenced (evidence count stays flat), its stability score drops. If a topic becomes too cold (2× half-life without reinforcement), it is automatically archived.

### Vector Embeddings and Hybrid Search

When an agent needs context, the system doesn't just match keywords. The `memory-embeddings.ts` module runs a local ONNX model to generate 384-dimensional embeddings for every memory on write.

When the agent uses the `memory_search` tool, the system performs a **hybrid search**: combining exact keyword matches with cosine similarity vector matching (threshold ≥0.90 similarity). If a memory being added is extremely similar to an existing one, the system automatically *reinforces* the existing memory (bumping its evidence count) instead of creating a duplicate.

### Situation Reports and Query Classes

The **Situation Report** is the actual text injected into the LLM's system prompt. It organizes memories by priority: preferences → lessons → mistakes → patterns → decisions → completions.

To ensure relevance, a heuristic classifier runs `before_agent_start` to determine the **Query Class** (e.g., `pr_review`, `git_release`, `debug`, `general`). This class dynamically adjusts which sections get priority in the token budget and tweaks the vector `topK` search limits.

> **Tip:** You can monitor memory capacity directly in the UI. The Situation Report header shows usage (e.g., `[72% — 1,224/1,700 tokens]`), and consolidation warnings trigger when exceeding 80%.

### Enforcement Rules

Code-enforced memory entries act as hard constraints that the LLM cannot ignore. When adding a memory, the agent can attach triggers and actions.

*   **Triggers:** What activates the rule (e.g., `bash_contains <str>`, `tool_name <name>`).
*   **Actions:** How the system responds (`block`, `run_after`, `warn`).
*   **Verifiers:** Semantic conditions checked at `turn_end` (e.g., ensuring a specific tool was called before a command).

These hooks execute via the `tool_result` and `turn_end` lifecycle events. If a verifier fails, the system automatically forces a retry, keeping the agent honest.

### Promotion Queue

High-evidence memories (e.g., a behavior reinforced 3-5 times) graduate through the **Promotion Queue**. A background process proposes elevating these memories into permanent skills, enforcement rules, or project-wide rules. High-confidence enforcement rules (`block` or `warn`) can be auto-applied safely, ensuring the project becomes more resilient over time.

### PR Review Store

Code review memory is handled specially by an SQLite database (`.pi/data/pr-reviews.db`). It tracks both posted and skipped findings. If a user dismisses a finding for a generalizable reason, the agent appends a guideline to `.pi/data/review-guidelines.md`. This prevents the AI from repeatedly raising the same stylistic complaints in future PRs.

## How it Affects the User

- **Agent Adaptability:** Because of the scoring and decay system, users don't have to manually delete outdated instructions. The agent naturally "forgets" old task contexts while retaining long-term preferences.
- **Immediate Context:** When users modify specific files, the auto-injection pipeline searches for file-path vector matches and injects file-change memory reminders instantly.
- **Privacy First:** All vector embeddings and database queries happen entirely locally. No code snippets or memory topics are sent to external embedding APIs.
- **Automated Guardrails:** Through enforcement rules and the promotion queue, if an agent repeatedly makes a mistake and is corrected, it will naturally evolve a hard boundary (like blocking a destructive bash command) without the user ever writing a line of configuration.

## Related Pages

- [Curating Project Memory](curating-project-memory.html) — Learn how to manually seed, score, and organize learned topics.
- [Implementing Command Guards](safety-enforcements.html) — Understand how to map memory triggers to hard enforcement constraints.
- [Configuration & Settings](configuration.html) — Look up token budgets, decay rates, and directory settings for the memory module.
- [myk_pi_tools CLI Reference](cli-reference.html) — Discover the CLI commands for manual database queries and memory migrations.

## Related Pages

- [Curating Project Memory](curating-project-memory.html)
- [Background Memory Consolidation (Dreaming)](background-dreaming.html)
