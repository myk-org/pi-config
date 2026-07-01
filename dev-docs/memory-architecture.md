# Memory Architecture

Scored, prioritized, topic-organized memory system. Architecture inspired by [OpenHuman](https://github.com/tinyhumansai/openhuman) — clean-room TypeScript, MIT licensed.

## Layer 1 — Scored Memory

`memory-scoring.ts`: Stability formula
`cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)` across 6 categories with decay half-lives
(preference=90d, lesson=60d, done=14d). Lifecycle: active → provisional → candidate → dropped.
Per-category budget caps, pinned/forgotten overrides. Storage: `.pi/memory/memory-scores.json`.

## Layer 2 — Situation Reports

`situation-report.ts`: Token-budgeted context injected into system prompt.
Sections by priority: preferences → lessons → mistakes → patterns → decisions → completions;
lower-priority sections truncated when budget exceeded.

## Layer 3 — Memory Tree

`memory-tree.ts`: Entries organized into topic files under
`.pi/memory/topics/` (~3000 tokens each). Topics have hotness scores;
cold topics auto-archived after 2× half-life without reinforcement.

## Auto-Injection Pipeline

`rules.ts`:

- `before_agent_start`: injects situation report + vector-matched memories + session history (skips trivial messages like "ok", "thanks")
- `tool_result`: memory-based enforcement (trigger matching → block/run_after/warn)
- `turn_end`: file-change memory reminders (vector search on modified paths) + task-focus enforcement
  (no tool calls but active tasks → injects follow-up) + semantic enforcement verifier checking
  (retries turn on violations)
- Retrieval telemetry logged to `.pi/data/memory-telemetry.jsonl`; Ground Truth instruction tells LLM to trust injected context

## Layer 4 — Vector Embeddings

`memory-embeddings.ts`: Model `Xenova/bge-small-en-v1.5` (384 dims, local ONNX).
Storage: `.pi/memory/embeddings.json`. Embeds on write with dedup
(≥0.85 similarity → reinforce instead of add), hybrid keyword+vector search, keyword-only fallback. No API keys.

## Memory Tools

`memory-tools.ts`: `memory_search` (hybrid search), `memory_reinforce` (bump evidence),
`memory_add` (write + dedup), `memory_remove` (delete), `memory_edit` (update/invalidate),
`memory_reflect` (synthesize answer), `memory_consolidate` (analyze/merge/deduplicate),
`memory_topics` (list topics + hotness).

## Session Search

`session-search.ts`: Keyword search over past conversation summaries,
indexed on shutdown, auto-injected for relevant sessions. Storage: `.pi/data/session-search.json`.

## PR Review Store

`myk_pi_tools/pr/pr_review_store.py`: Tracks PR review comments in SQLite (`.pi/data/pr-reviews.db`).
Stores both posted and skipped findings with status/skip_reason columns.
Skipped findings are auto-matched in subsequent review cycles to avoid re-raising dismissed items.

## Learned Review Preferences

`.pi/data/review-guidelines.md`: Per-repo review guidelines
learned from user skip decisions. When a user skips a finding for a generalizable reason
(project convention, intentional pattern), the AI appends a one-line guideline to this file.
All 3 code-reviewer agents read this file before reviewing and suppress matching findings.

## Layer 5 — Enforcement Rules

`enforcement-rules.ts`: Code-enforced memory entries that the LLM cannot ignore.
Memory entries gain optional fields: `trigger` (what activates the rule), `action` (block/run_after/warn),
`verifier` (semantic condition checked at turn_end). Enforcement hooks:

- `tool_result`: after a tool completes, checks triggers and executes actions (block, run_after, warn)
- `turn_end`: checks semantic verifiers and forces retry via `sendMessage(triggerTurn: true)` on violations

Trigger types: `bash_contains <str>`, `bash_regex <pattern>`, `tool_name <name>`, `file_modified <glob>`.
Action types: `block` (prevent), `run_after` (execute command after), `warn` (append warning).
Verifier format: `tool_called <tool> before <command>` (checks tool ordering within a turn).

Entries are added via `memory_add` with optional `trigger`, `action`, `verifier` parameters.
Stored in the same `memory-scores.json` — no separate storage system.

## Memory Injection Position

Memories injected at **tail** of system prompt (after rules/instructions).
Research proves tail position gets highest LLM attention (U-shaped attention curve).

## Capacity Signal

`situation-report.ts`: Header shows usage % (e.g. `[72% — 1,224/1,700 tokens]`), consolidation warning at >80%.

## Preference Auto-Extraction

`preference-extractor.ts`: Detects "I prefer…"/"always use…"/"never…" patterns, auto-adds to memory, reinforces on repetition.
