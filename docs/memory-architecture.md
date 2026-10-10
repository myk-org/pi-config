# Memory Architecture

Pi’s memory architecture is the layer that turns one-off conversations into durable project knowledge. It matters because it decides what the agent remembers, what it forgets, what gets surfaced automatically in future turns, and when repeated lessons become stronger guardrails instead of loose suggestions.

The practical result is simple: you spend less time repeating project conventions, and the agent gets better at bringing the right context back at the right moment.

> **Note:** The implementation is a clean-room TypeScript rewrite inspired by
> [OpenHuman](https://github.com/tinyhumansai/openhuman) (MIT licensed) — no code was copied, only the
> architectural ideas.

## The Big Picture

The memory system is local, file-backed, and layered. Topic files are the source of truth; everything else is derived from or built around them.

| Layer | What it stores | Where it lives | Why it matters |
|---|---|---|---|
| Topic files | Human-readable memory entries by category | `.pi/memory/topics/*.md` | This is the canonical memory content. |
| Score index | Stability score, evidence count, lifecycle, enforcement metadata | `.pi/memory/memory-scores.json` | Decides which memories stay active and which fade out. |
| Embedding store | Local vectors for semantic matching | `.pi/memory/embeddings.json` | Lets Pi retrieve related memories even when the wording changes. |
| Situation report | Token-budgeted summary for prompt injection | Built at runtime | Determines what memory the agent actually sees during a turn. |
| Promotion queue | Candidates for skills, enforcement, or project rules | `.pi/memory/promotions.md` | Captures repeated patterns that may deserve stronger structure. |
| Provenance sidecar | Source-session metadata waiting to be merged | `.pi/memory/provenance-pending.jsonl` | Preserves where a memory came from without letting background jobs edit the score file directly. |

### End-to-end flow

1. A memory enters the system from a direct tool call, the Python CLI, or background consolidation.
2. The entry is written into a category topic file such as `lessons.md` or `preferences.md`.
3. The scoring engine rebuilds `memory-scores.json`, recalculates stability, and assigns a lifecycle state.
4. The embedding layer lazily creates or refreshes local vectors for semantic search.
5. On `before_agent_start`, Pi builds a situation report, optionally adds contextually relevant memories and past-session matches, then appends that material to the tail of the system prompt.
6. As evidence accumulates, the promotion system proposes stronger structures such as enforcement metadata or reusable skills.

> **Note:** The architecture is intentionally split between human-editable topic files and machine-managed indexes. That keeps the memory easy to inspect while still supporting scoring, retrieval, and promotion.

### Implementation map

Every layer is a standalone module under `extensions/orchestrator/`:

| Component | File | Role |
|---|---|---|
| Scoring engine | `memory-scoring.ts` | Stability formula, lifecycle states, category budgets, rebuilds the score index. |
| Situation report | `situation-report.ts` | Builds the token-budgeted prompt injection and the capacity header. |
| Memory tree | `memory-tree.ts` | Topic-file organization, hotness scores, cold-topic archiving. |
| Embeddings | `memory-embeddings.ts` | Local vector model, embedding store, hybrid search. |
| Memory tools | `memory-tools.ts` | The `memory_*` tools exposed to the agent. |
| Session search | `session-search.ts` | Keyword index over past conversation summaries. |
| Enforcement rules | `enforcement-rules.ts` | Code-enforced memories (triggers, actions, verifiers). |
| Promotion queue | `promotion-queue.ts` | Graduates high-evidence memories into stronger structures. |
| Preference extractor | `preference-extractor.ts` | Detects stated preferences in conversation and records them. |
| Query classifier | `memory-query-class.ts` | Classifies the prompt to bias injection priorities. |

## Key Concepts

### Topic files are the source of truth

Pi stores memory as Markdown topic files under `.pi/memory/topics/`, not in a database-first format.

| Category | Topic file |
|---|---|
| `preference` | `preferences.md` |
| `lesson` | `lessons.md` |
| `pattern` | `patterns.md` |
| `decision` | `decisions.md` |
| `done` | `completions.md` |
| `mistake` | `mistakes.md` |

Each line is a single memory entry. Entries can carry markers such as `*(pinned)*` or `*(enforced)*`.

That design has two user-visible benefits:

- You can inspect project memory with normal file tools.
- Background maintenance can reorganize memories without inventing a separate opaque store.

### Scoring is what makes memory fade or stick

The scoring engine calculates stability with this formula:

`cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)`

It combines three forces:

- **Cue weight:** how strongly the memory was learned.
- **Recency decay:** older memories weaken if they are never reinforced.
- **Evidence count:** repeated use makes a memory more stable.

#### Cue weights

| Cue type | Weight | Typical meaning |
|---|---:|---|
| `explicit` | 1.0 | The user stated it directly. |
| `structural` | 0.9 | It was inferred from durable structure. |
| `behavioral` | 0.7 | It came from repeated workflow behavior. |
| `recurrence` | 0.6 | It was seen enough times to matter. |

#### Half-lives by category

| Category | Half-life |
|---|---|
| Preferences | 90 days |
| Lessons | 60 days |
| Patterns | 30 days |
| Decisions | 30 days |
| Completions | 14 days |
| Mistakes | 14 days |

Pi then assigns each scored entry to a lifecycle state:

- `active`: high-value memory that should influence current behavior
- `provisional`: still relevant, but below the top tier
- `candidate`: weak memory that may soon be dropped
- `dropped`: no longer injected

The system also applies caps so one category cannot crowd out everything else. Current budgets allow more room for preferences and lessons than for decisions or completions, with an overall cap of 40 active entries plus a smaller overflow pool for provisional ones.

> **Tip:** Pinned memories bypass normal decay, and enforced memories are kept active so their guardrails stay intact.

### Topic organization is separate from scoring

Topic files are organized for readability, while `memory-scores.json` is organized for ranking and lifecycle management. That separation lets Pi:

- reorder and trim injected memory without rewriting your topic structure every turn
- archive cold topic files when their newest entries have aged past roughly two half-lives
- keep pinned topics around even when everything else would have gone cold

User-visible effect: your memory files stay understandable, while the agent still gets a compact, prioritized view.

### Embeddings are local and file-backed

Semantic retrieval is handled by `memory-embeddings.ts`. It uses the local `Xenova/bge-small-en-v1.5` model through `@huggingface/transformers`, produces 384-dimensional vectors, and stores them in `.pi/memory/embeddings.json`.

Important details:

- The model is loaded lazily on first real use.
- Embeddings are cached per process for speed.
- The on-disk store is updated with atomic write-then-rename behavior.
- If the model cannot load, memory features degrade gracefully instead of failing the turn.
- New entries are deduplicated at write time: a candidate whose embedding is at least `0.90` similar to an existing entry reinforces that entry instead of adding a duplicate.
- Search is hybrid — keyword plus vector — with a keyword-only fallback when the embedding model is unavailable.

This layer is used in two places:

- semantic memory search
- automatic “contextually relevant memories” injection before a turn starts

That means Pi can still find a useful lesson even when your current prompt does not repeat the exact wording of the original memory.

### The injection pipeline runs on three hooks

Memory reaches the model through three extension hooks:

| Hook | What happens |
|---|---|
| `before_agent_start` | Injects the situation report, vector-matched memories, and relevant session history. Trivial messages such as "ok" or "thanks" are skipped so nothing is wasted on them. |
| `tool_result` | Runs memory-based enforcement: trigger matching followed by `block`, `run_after`, or `warn` actions. |
| `turn_end` | Injects file-change memory reminders (vector search on modified paths), task-focus enforcement when tasks are active but no tool was called, and semantic enforcement verification that can retry the turn on violations. |

Everything is appended to the **tail** of the system prompt, after rules and instructions. That position is
deliberate: LLM attention follows a U-shaped curve, and the tail of the prompt receives the strongest attention.

Retrieval decisions are logged to `.pi/data/memory-telemetry.jsonl`, and the injected block carries a Ground
Truth instruction telling the model to trust the provided context over re-deriving it.

### The situation report is the runtime view

The situation report is the text that Pi actually injects into the system prompt. It is built from scored topic entries, not from raw conversation history.

By default, it targets a 1700-token budget and builds sections such as:

- Pinned
- Active Preferences
- Active Lessons
- Vetoes & Mistakes
- Patterns
- Recent Decisions
- Recent Completions

It also shows a usage header and warns when memory is above 80% of its budget.

User-visible effect:

- high-priority memories reliably survive into the prompt
- lower-priority material is truncated instead of overflowing context
- the agent gets a stable, predictable memory block rather than a noisy dump

### Query classes bias what gets injected

Before a turn starts, Pi classifies the prompt into one of four query classes:

| Query class | What it boosts |
|---|---|
| `pr_review` | mistakes, patterns, lessons |
| `git_release` | lessons, decisions, preferences |
| `debug` | mistakes, lessons |
| `general` | no special boost |

That bias changes section ordering, section budget, and how many semantic matches Pi prefers to retrieve.

This is why the same project memory can feel different depending on what you are doing:

- a debugging request brings forward mistakes and lessons
- a release task gives more weight to decisions and conventions
- a review workflow favors repeated review-related guidance

### Session search recalls past conversations

Independently of scored memory, `session-search.ts` maintains a keyword index over past conversation summaries in
`.pi/data/session-search.json`. The index is written when a session shuts down, and `before_agent_start`
auto-injects matches from relevant past sessions alongside the situation report.

The agent can also query it directly with the `session_search` tool — see [Commands and Tools Reference](commands-and-tools.html).

### Stated preferences are captured automatically

`preference-extractor.ts` watches conversation for phrases such as "I prefer …", "always use …", or "never …".
When it detects one, it adds the preference to memory automatically, and repeated statements reinforce the
existing entry instead of creating duplicates.

### Promotion turns repeated memories into stronger structure

When a memory accumulates enough evidence, Pi can promote it.

Current promotion destinations are:

| Destination | What happens |
|---|---|
| `memory` | Keep as regular memory. |
| `skill` | Multi-step patterns can be proposed as reusable skills. |
| `enforcement` | Safe, high-confidence rules can be applied automatically. |
| `project_rule` | Project-wide conventions are queued as proposals only. |
| `discard` | Low-value or superseded items can be marked for removal. |

Evidence thresholds are `3` for enforcement, `3` for skill, and `5` for project rule.

The queue is stored in `.pi/memory/promotions.md` with statuses of `proposed`, `applied`, or `rejected`.

A few important boundaries keep this safe:

- enforcement auto-application is limited to high-confidence cases
- project rules are never auto-written into `rules/` or `.pi/rules/`
- promotion state is visible in a plain Markdown file instead of being hidden in a binary store

> **Warning:** Enforced memories are text-hash keyed. If background maintenance rewrites the text of an enforced entry, the binding would break, so the system explicitly protects those entries.

### Provenance is merged through a sidecar

Background consolidation can attach metadata such as the source session or what a memory informs. Instead of editing the score file directly, it appends a single line of JSON to `.pi/memory/provenance-pending.jsonl`. The orchestrator then merges that sidecar into `memory-scores.json` on completion and deletes it. (A `.pi/memory/provenance-pending.json` from older versions is still read for backward compatibility.)

This keeps the scoring index authoritative while still preserving traceability.

User-visible effect: a memory can later explain where it came from without forcing every background worker to edit the score file itself.

### Legacy memory migration still exists

The Python memory store includes a one-time migration path from the older SQLite-based memory store.

The CLI command:

```bash
myk-pi-tools memory migrate
```

moves entries from legacy `memories.db` into topic files under `.pi/memory/topics/`, then cleans up older memory-side files such as `dreams.md` and `dreams.lock`.

That matters if you are carrying an older repo or restoring archived state: the modern architecture is topic-file-first, but the project still provides a supported bridge forward.

## How It Affects the User

- **The agent remembers durable project context without re-reading everything.** The situation report surfaces the highest-value memories automatically.
- **Project conventions get stronger over time.** Repeated lessons accumulate evidence and can eventually become enforcement metadata or promotion candidates.
- **Semantic recall works even when wording changes.** Local embeddings let Pi match meaning, not just exact phrases.
- **Memory stays inspectable.** Topic files, score indexes, embedding caches, and promotion queues all live on disk in predictable locations.
- **Old state is still recoverable.** If your project used the older memory database, the Python CLI can migrate it into the current topic-file model.
- **Background consolidation stays safe.** Dreaming, provenance merges, and promotion passes operate through sidecars and queues instead of rewriting everything in place.

## Review-Adjacent Stores

Two stores sit at the boundary between memory and the code-review system. They are not part of the scored memory
model, but they learn from review decisions the same way memory learns from conversation.

### Learned review preferences

`.pi/data/review-guidelines.md` holds per-repo review guidelines learned from user skip decisions. When a user
skips a finding for a generalizable reason — a project convention or an intentional pattern — a one-line guideline
is appended to this file. All three code-reviewer agents read it before reviewing and suppress matching findings.

### PR review store

`myk_pi_tools/pr/pr_review_store.py` tracks PR review comments in SQLite at `.pi/data/pr-reviews.db`. It stores
both posted and skipped findings with status and skip-reason columns, so dismissed items are auto-matched and not
re-raised in later review cycles.

Resolution tracking adds two columns:

- `resolution_status` — the LLM evaluation verdict: `resolved_fixed`, `resolved_accepted`, `resolved_bad_fix`, or `resolved_no_fix`
- `author_response` — the author's reply or fix context, kept as an audit trail

The related CLI commands are `myk-pi-tools pr update-resolution` (persist verdicts from resolved threads) and
`myk-pi-tools pr get-review-history` (dump the full review history across all statuses).

See [Automating Code Reviews](automating-code-reviews.html) for the review workflows that read and write these stores.

## Contributor Documentation

The repository ships a contributor doc, `contributing/enforcement-honesty-map.md`, that declares which
memory-backed enforcement is code-enforced, which is only injected, and which is aspirational.

## Related Pages

- See [Curating Project Memory](curating-project-memory.html) for the hands-on workflow for adding, inspecting, and pruning memories.
- See [Commands and Tools Reference](commands-and-tools.html) for the full `memory_*` tool reference
  (`memory_search`, `memory_reinforce`, `memory_add`, `memory_remove`, `memory_edit`, `memory_reflect`,
  `memory_consolidate`, `memory_topics`).
- See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for the background process that extracts, reorganizes, and promotes memories over time.
- See [Implementing Command Guards](safety-enforcements.html) for the enforcement side of memories that graduate into hard rules.
- See [Configuration & Settings](configuration.html) for the knobs that affect memory timing and runtime behavior.
- See [myk_pi_tools CLI Reference](cli-reference.html) for the Python commands that manage topic files and perform legacy migration.
- See [Automating Code Reviews](automating-code-reviews.html) for review-specific workflows that interact with memory, but belong to the review system rather than the core memory model.
