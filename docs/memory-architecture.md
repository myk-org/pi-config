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
| Score index | Stability score, evidence count, lifecycle, enforcement metadata | `.pi/data/state.db` (`kv_state` key `memory-scoring`) | Decides which memories stay active and which fade out. Legacy `.pi/memory/memory-scores.jsonl` and `memory-scores.json` are auto-migrated once on first access. |
| Embedding store | Local 384-dim `Float32Array` BLOB vectors for semantic matching | `.pi/data/state.db` (`embedding_meta` + `embeddings` tables) | Lets Pi retrieve related memories even when the wording changes, ~4× smaller than JSON float arrays. Legacy `.pi/memory/embeddings.jsonl` and `embeddings.json` are auto-migrated once on first access. |
| Situation report | Token-budgeted summary for prompt injection | Built at runtime | Determines what memory the agent actually sees during a turn. |
| Promotion queue | Candidates for skills, enforcement, or project rules | `.pi/memory/promotions.md` | Captures repeated patterns that may deserve stronger structure. |
| Provenance pending / sidecar | Source-session metadata waiting to be merged | `.pi/data/state.db` (`kv_state` key `memory-provenance`) + optional dream sidecar `.pi/memory/provenance-pending.jsonl` | Preserves where a memory came from without letting background jobs edit the score store directly. |

### End-to-end flow

1. A memory enters the system from a direct tool call, the Python CLI, or background consolidation.
2. The entry is written into a category topic file such as `lessons.md` or `preferences.md`.
3. The scoring engine updates the `memory-scoring` store in `.pi/data/state.db`, recalculates stability, and assigns a lifecycle state.
4. The embedding layer lazily creates or refreshes binary `Float32Array` BLOB vectors in `.pi/data/state.db` for semantic search.
5. On `before_agent_start`, Pi pins the startup situation report once per session in the structured `project_memory` system-prompt section (keeping the provider prompt prefix cache-stable across turns and mid-session memory writes). Per-turn dynamic context — contextual vector matches, relevant past sessions, ticking async job status, and one-time notices when a snapshot entry is edited/invalidated/removed — is delivered outside the system prompt prefix in a hidden `orchestrator-turn-context` message appended after the user prompt (#1414).
6. Before compaction (`session_before_compact`), Pi injects a compact, bounded block of standing project memories (pinned, enforced, and top-scored rules/decisions) into the compaction input so summaries stay consistent with project memory; after compaction commits (`session_compact`), the pinned session snapshot refreshes cleanly and pending mid-session notices are cleared (#1422).
7. As evidence accumulates, the promotion system proposes stronger structures such as enforcement metadata or reusable skills.

> **Note:** The architecture is intentionally split between human-editable topic files and a WAL-mode SQLite state store (`.pi/data/state.db`, built-in `node:sqlite`, `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`). That keeps memory easy to inspect while providing atomic cross-process concurrency across Pi sessions and COMS peers.

#### Worktrees share the main checkout’s stores

`.pi/memory` and `.pi/data` are gitignored, so a session running inside a git
worktree (`.worktrees/<name>`, the parallel-issues workflow) would otherwise see
empty stores. All memory and shared project data paths — including `.pi/data/state.db`
for `memory-scoring`, `memory-embeddings`, `memory-provenance`, and `session-search` —
are therefore resolved through the worktree’s **main checkout** — the parent of
`git rev-parse --git-common-dir` — matching the Python side’s `get_project_root()`.
In the main checkout itself this is a no-op (the common dir is `<root>/.git`), so
resolution is uniform. `pi-config-review-state` stays worktree-scoped in
`<worktree-root>/.pi/data/state.db` so each issue branch tracks its own review loop
independently, and `.pi/tmp` stays per-cwd by design.

### Implementation map

Every layer is a standalone module under `extensions/orchestrator/`:

| Component | File | Role |
|---|---|---|
| State database | `state-db.ts` | Shared `node:sqlite` (`DatabaseSync`) WAL store for `.pi/data/state.db` (and worktree-scoped review state), schema versioning, `BEGIN IMMEDIATE` transactions, `Float32Array` BLOB encoding, handle caching, and one-time legacy JSONL/JSON migration. |
| Scoring engine | `memory-scoring.ts` | Stability formula, lifecycle states, category budgets, rebuilds the score index. |
| Situation report | `situation-report.ts` | Builds the token-budgeted prompt injection, capacity header, and bounded pre-compaction standing memory context (#1422). |
| Memory tree | `memory-tree.ts` | Read-only topic-file index, canonical topic names, and hotness scores. |
| Embeddings | `memory-embeddings.ts` | Local vector model, embedding store, hybrid search. |
| Memory tools | `memory-tools.ts` | The `memory_*` tools exposed to the agent. |
| Deep memory store | `memory-store.ts` | Single mutation module owning all topic writes, cache invalidation, score/tombstone updates, embedding upkeep/pruning, and write/edit guardrails (issues #915, #1354). |
| Contradiction engine | `memory-contradiction.ts` | Internal read-only NLP contradiction heuristics (clause-scoped polarity clash + vector narrowing). |
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

Topic files are organized for readability, while the `memory-scoring` store in `.pi/data/state.db` is organized for ranking and lifecycle management. That separation lets Pi:

- reorder and trim injected memory without rewriting your topic structure every turn
- archive cold topic files when their newest entries have aged past roughly two half-lives
- keep pinned topics around even when everything else would have gone cold

User-visible effect: your memory files stay understandable, while the agent still gets a compact, prioritized view.

### Embeddings are local and SQLite-backed

Semantic retrieval is handled by `memory-embeddings.ts`. It uses the local `Xenova/bge-small-en-v1.5` model through `@huggingface/transformers`, produces 384-dimensional vectors, and stores them as binary `Float32Array` BLOB rows in `.pi/data/state.db` (`embedding_meta` and `embeddings` tables).

Important details:

- The model is loaded lazily on first real use.
- Query embeddings are cached per process for speed.
- Stored vectors are updated per-key inside atomic SQLite WAL transactions instead of rewriting a multi-megabyte JSON file.
- Legacy `.pi/memory/embeddings.jsonl` and `embeddings.json` files are auto-migrated once on first access without modifying the legacy files.
- If the model cannot load, memory features degrade gracefully instead of failing the turn.
- New entries are deduplicated at write time: a candidate whose embedding is at least `0.90` similar to an existing entry reinforces that entry instead of adding a duplicate.
- Search is hybrid — keyword plus vector — with a keyword-only fallback when the embedding model is unavailable.

This layer is used in two places:

- semantic memory search
- automatic “contextually relevant memories” injection before a turn starts

That means Pi can still find a useful lesson even when your current prompt does not repeat the exact wording of the original memory.

### The injection pipeline runs on five hooks

Memory reaches the model through five extension hooks:

| Hook | What happens |
|---|---|
| `before_agent_start` | Pins the startup situation report once per session in `sections.project_memory` (deterministic `queryClass: "general"`) so the cached system-prompt prefix stays byte-identical across turns and mid-session memory writes (#1414). Delivers per-turn dynamic context — vector-matched memories, relevant session history, running async agent status, and one-time invalidation/update notices for mutated snapshot entries — in a hidden `orchestrator-turn-context` message appended after the user prompt. Trivial messages such as "ok" or "thanks" skip vector/session recall. |
| `session_before_compact` | Injects a bounded block of standing project memories (pinned, enforced, and highest-priority rules/decisions; capped by `memory_token_budget` and 600 tokens) into the compaction input so summarization preserves standing constraints (#1422). Fail-soft (never blocks or aborts compaction) and skipped for subagents. |
| `session_compact` | Refreshes the session's pinned `project_memory` snapshot on the next turn (picking up memories added or updated earlier in the session) and clears pending mid-session invalidation notices (#1422). |
| `tool_result` | Runs memory-based enforcement: trigger matching followed by `block`, `run_after`, or `warn` actions. |
| `turn_end` | Injects file-change memory reminders (vector search on modified paths), task-focus enforcement when tasks are active but no tool was called, and semantic enforcement verification that can retry the turn on violations. |

Only the cache-stable base sections (`orchestrator_rules` and the startup-pinned `project_memory`) are written to
`systemPromptOptions.sections`. Because providers such as Vertex, Gemini, and Bedrock collapse system-prompt updates
into the leading system block, mutating sections on every turn previously busted prompt caches (`cacheRead=0`).
Delivering per-turn recalls, ticking async durations, and snapshot mutation notices in a non-displayed custom message
appended after the user prompt preserves cached prefixes across turns while keeping recent context at the tail of the
transcript. When an earlier handler has forced the full prompt (or an older Pi version does not expose sections), the
extension falls back to appending to the prompt text.

To prevent accidental truncation overwrites when editing from clipped previews (#1414), `memory_edit` (`update`)
rejects `newText` values that end with `...` or `…` as a strict prefix of the existing entry and returns the full
unclipped text; lookup misses on clipped prefixes in `memory_edit` and `memory_remove` also return matching full
unclipped entries from the topic file.

The other hooks deliver differently: `tool_result` enforcement acts on the tool result itself (`warn` appends to
it, `block` prevents it), and `turn_end` verifier violations are sent as follow-up messages that can trigger a
retry of the turn.

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
`.pi/data/state.db` (`kv_state` key `session-search`; legacy `.pi/data/session-search.jsonl` and `session-search.json`
auto-migrate once on first access). At session shutdown the index harvests Pi's own LLM-written compaction and branch
summaries from the session file (issue #915), falling back to a join of user messages when no summaries exist.
To cover active, uncompacted, and abnormally terminated sessions without waiting for compaction or clean shutdown
(issue #1342), `searchSessions` also lazily scans recent project session JSONL files under
`~/.pi/agent/sessions/<cwd-slug>/` using mtime-cached incremental byte-offset parsing, redacting embedded secrets,
filtering command/system noise, and deduplicating against persisted summaries at zero LLM cost.
Compaction summaries whose turn is retried (overflow recovery) are skipped so content is not double-indexed, and
`before_agent_start` auto-injects matches from relevant past sessions alongside the situation report.

The agent can also query it directly with the `session_search` tool — see [Commands and Tools Reference](commands-and-tools.html).

### Stated preferences are captured for dreaming review

`preference-extractor.ts` watches conversation for phrases such as "I prefer …", "always use …", or "never …".
Regex extraction fires on phrase, not meaning, so detected statements are queued as **candidates** in
`.pi/memory/preference-candidates.jsonl` (full sentence, source session) — the extractor no longer
lands memories directly (#961). Questions ("Do I always need to…?"), one-off permission grants
("you can merge this PR"), and task-scoped instructions ("when done, I want an html report",
"when bumping to 1.4.0, drop the vendor dir") are filtered out before queueing. Dreaming reviews
the queue each cycle: durable standing preferences are distilled into clean one-line entries,
everything else is discarded, and the queue is truncated. The LLM path (`memory_add` + guardrails)
remains available for immediate capture.

### The write path guards against bad memories

Every producer — `memory_add`, `memory_edit`, `memory_remove`, promotions, dreaming restores, and rebuilds — funnels through `memory-store.ts` (with contradiction heuristics isolated in `memory-contradiction.ts`), which enforces,
in order:

1. **Grant-phrase guardrail** — text that reads like a one-off permission ("you can merge this PR",
   "go ahead", "just this once") is rejected: one-off grants are session instructions, not memories.
2. **Task-scope guardrail** (#961) — text that reads like a task-scoped instruction is rejected:
   deliverable asks tied to a completion event ("when done, I want an html report"), version-pinned
   migration steps ("when bumping to 1.4.0, drop the vendor dir"), bounded deliverable references
   ("for this report"), and config-change notes ("every 30min (changed from 1h)"). These belong to
   the current task or the session, not memory. Standing rules ("When done, commit and push
   everything") do not match — the detector is high-precision by design and fuzzy cases are left
   to dreaming review.
3. **Contradiction gate** — an add that flips permission polarity against an existing entry (one text
   forbids what the other permits, on the same action) is refused and the model is told to ask the user.
   The check is **clause-scoped** (#936): a polarity marker only governs its own clause, so
   "never publish with a dead token" does not contradict "always publish to npm" — the polarized
   clauses share no action and both rules are storable. Quoted payloads (`'say OK'` in a test
   procedure) are stripped before polarity detection, so literal strings are never read as permission
   markers. A conflict is a decision point, not a dead end: after the user confirms the rule changed, retrying
   with `overrideConflicts: true` supersedes the old non-pinned entry (invalidated, with provenance) so
   no contradiction remains. Contradicting a **pinned** entry always refuses — pinned entries are
   user-explicit and only the user's own `memory_remove` / `memory_edit` can change them.
   `tool_name` triggers naming a shell command (`curl`, `git`, …) or blocking all of `bash` produce an
   advisory warning at write time (#936): such triggers never fire or are over-broad — the entry is
   still stored, with `bash_contains` suggested instead.
3. **Dedup** — near-duplicates (vector similarity) and exact matches reinforce the existing entry
   instead of creating a second one.

Entries can carry a `scope` (`session`, `task`, or `project`, the default). Session-scoped entries get an
expiry safety net, are never injected into the situation report of a later session, and are pruned by the
periodic rebuild once expired.

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

A promotion pass runs at three moments: when a dream completes (`onComplete`), when `memory_reinforce`
pushes an entry across an evidence threshold, and when the dream or `memory_consolidate` prompt writers
flag candidates while reorganizing memory.

The queue is stored in `.pi/memory/promotions.md` with statuses of `proposed`, `applied`, or `rejected`.

A few important boundaries keep this safe:

- enforcement auto-application is limited to high-confidence cases
- project rules are never auto-written into `rules/` or `.pi/rules/`
- promotion state is visible in a plain Markdown file instead of being hidden in a binary store

> **Warning:** Enforced memories are text-hash keyed. If background maintenance rewrites the text of an enforced entry, the binding would break, so the system explicitly protects those entries.

### Provenance is merged through pending state and sidecars

Background consolidation can attach metadata such as the source session or what a memory informs. Programmatic callers
store pending provenance in `.pi/data/state.db` (`kv_state` key `memory-provenance`), while background LLM dream agents
can still write a single JSON line to `.pi/memory/provenance-pending.jsonl` without touching `state.db` directly. The
orchestrator merges both into `memory-scoring` inside `.pi/data/state.db` on completion and clears the pending row and
consumed sidecar only after commit succeeds. (A legacy `.pi/memory/provenance-pending.json` is also read for backward
compatibility.)

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

Rows with `status = 'resolved_external'` record third-party threads (CodeRabbit, Qodo, other humans)
that were resolved and whose path saw no commit afterwards — `/pr-review` persists them as
`resolved_accepted` via `pr store-pr-review`, upserted by `thread_id`, so resolved external findings
reach `get-review-history` too. `pr update-resolution` still matches only comments we posted
(`status = 'posted'`).

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
