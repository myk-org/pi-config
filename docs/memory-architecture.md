# Memory Architecture

Pi’s memory architecture is the layer that turns one-off conversations into durable project knowledge. It matters because it decides what the agent remembers, what it forgets, what gets surfaced automatically in future turns, and when repeated lessons become stronger guardrails instead of loose suggestions.

The practical result is simple: you spend less time repeating project conventions, and the agent gets better at bringing the right context back at the right moment.

## The Big Picture

The memory system is local, file-backed, and layered. Topic files are the source of truth; everything else is derived from or built around them.

| Layer | What it stores | Where it lives | Why it matters |
|---|---|---|---|
| Topic files | Human-readable memory entries by category | `.pi/memory/topics/*.md` | This is the canonical memory content. |
| Score index | Stability score, evidence count, lifecycle, enforcement metadata | `.pi/memory/memory-scores.json` | Decides which memories stay active and which fade out. |
| Embedding store | Local vectors for semantic matching | `.pi/memory/embeddings.json` | Lets Pi retrieve related memories even when the wording changes. |
| Situation report | Token-budgeted summary for prompt injection | Built at runtime | Determines what memory the agent actually sees during a turn. |
| Promotion queue | Candidates for skills, enforcement, or project rules | `.pi/memory/promotions.md` | Captures repeated patterns that may deserve stronger structure. |
| Provenance sidecar | Source-session metadata waiting to be merged | `.pi/memory/provenance-pending.json` | Preserves where a memory came from without letting background jobs edit the score file directly. |

### End-to-end flow

1. A memory enters the system from a direct tool call, the Python CLI, or background consolidation.
2. The entry is written into a category topic file such as `lessons.md` or `preferences.md`.
3. The scoring engine rebuilds `memory-scores.json`, recalculates stability, and assigns a lifecycle state.
4. The embedding layer lazily creates or refreshes local vectors for semantic search.
5. On `before_agent_start`, Pi builds a situation report, optionally adds contextually relevant memories and past-session matches, then appends that material to the tail of the system prompt.
6. As evidence accumulates, the promotion system proposes stronger structures such as enforcement metadata or reusable skills.

> **Note:** The architecture is intentionally split between human-editable topic files and machine-managed indexes. That keeps the memory easy to inspect while still supporting scoring, retrieval, and promotion.

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

This layer is used in two places:

- semantic memory search
- automatic “contextually relevant memories” injection before a turn starts

That means Pi can still find a useful lesson even when your current prompt does not repeat the exact wording of the original memory.

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

### Promotion turns repeated memories into stronger structure

When a memory accumulates enough evidence, Pi can promote it.

Current promotion destinations are:

| Destination | What happens |
|---|---|
| `enforcement` | Safe, high-confidence rules can be applied automatically. |
| `skill` | Multi-step patterns can be proposed as reusable skills. |
| `project_rule` | Project-wide conventions are queued as proposals only. |
| `discard` | Low-value or superseded items can be marked for removal. |

The queue is stored in `.pi/memory/promotions.md` with statuses of `proposed`, `applied`, or `rejected`.

A few important boundaries keep this safe:

- enforcement auto-application is limited to high-confidence cases
- project rules are never auto-written into `rules/` or `.pi/rules/`
- promotion state is visible in a plain Markdown file instead of being hidden in a binary store

> **Warning:** Enforced memories are text-hash keyed. If background maintenance rewrites the text of an enforced entry, the binding would break, so the system explicitly protects those entries.

### Provenance is merged through a sidecar

Background consolidation can attach metadata such as the source session or what a memory informs. Instead of editing the score file directly, it writes a sidecar file at `.pi/memory/provenance-pending.json`. The orchestrator then merges that metadata back into `memory-scores.json` on completion.

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

## Related Pages

- See [Curating Project Memory](curating-project-memory.html) for the hands-on workflow for adding, inspecting, and pruning memories.
- See [Background Memory Consolidation (Dreaming)](background-dreaming.html) for the background process that extracts, reorganizes, and promotes memories over time.
- See [Implementing Command Guards](safety-enforcements.html) for the enforcement side of memories that graduate into hard rules.
- See [Configuration & Settings](configuration.html) for the knobs that affect memory timing and runtime behavior.
- See [myk_pi_tools CLI Reference](cli-reference.html) for the Python commands that manage topic files and perform legacy migration.
- See [Automating Code Reviews](automating-code-reviews.html) for review-specific workflows that interact with memory, but belong to the review system rather than the core memory model.

## Related Pages

- [Curating Project Memory](curating-project-memory.html)
- [Background Memory Consolidation (Dreaming)](background-dreaming.html)
- [Implementing Command Guards](safety-enforcements.html)
- [Configuration & Settings](configuration.html)
