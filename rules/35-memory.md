# Project Memory

Scored, topic-organized memory system with stability-based decay.
Memories are scored, prioritized, and injected into the system prompt via situation reports.

---

## Memory Tools (MANDATORY)

You have five memory tools and one session search tool. **USE THEM PROACTIVELY:**

## Auto-Injection (how memories reach you)

Three mechanisms automatically inject relevant context into your system prompt — you don't need to call tools for these:

1. **Situation Report** — token-budgeted summary of scored memories (preferences, lessons, mistakes, patterns, decisions, completions). Always present.
2. **Contextual Memory Recall** — vector similarity search against your current message. Entries with similarity > 0.65 appear as "Contextually Relevant Memories."
3. **Session History Recall** — keyword search against past conversation summaries. Relevant past sessions appear as "Relevant Past Sessions."

**Ground Truth:** All injected memories are authoritative. Use them directly —
do not re-discover or re-verify information already in your context window.

**Social closer gate:** Trivial messages ("ok", "thanks", "👍", < 6 chars) skip vector/session search.

### `memory_search` — Search Before Answering

**MANDATORY:** Before answering questions about prior sessions, user preferences, past decisions, or anything mentioned before —
call `memory_search` first. Supports keyword and category-filtered queries.

### `memory_reinforce` — Reinforce When Relevant

**MANDATORY:** When a memory is relevant to the current task, call `memory_reinforce` to bump its evidence count and prevent decay.

### `memory_add` — Add New Memories Proactively

**MANDATORY:** When you learn something worth remembering — preferences, corrections, conventions, completed work — add it immediately.
Keep entries short (~100 chars), specific, actionable.
Use `pinned: true` ONLY when user explicitly says "remember this". Duplicates are auto-reinforced.
When a correction is mechanical (can be checked by code), add `trigger` + `action` params — see "Code-Enforced Memories" below.

### `memory_remove` — Remove Outdated Memories

Remove entries that are no longer accurate, relevant, or superseded by newer entries.

### `memory_topics` — Inspect Topic Organization

List all memory topic files with hotness scores and entry counts.

### `session_search` — Recall Past Conversations

Search past conversation summaries for references to previous sessions. Returns matching snippets at zero LLM cost.

---

## Memory Storage

```text
.pi/memory/
├── memory-scores.json     # Scoring backend (auto-managed)
└── topics/
    ├── preferences.md     # [preference] entries
    ├── lessons.md         # [lesson] entries
    ├── patterns.md        # [pattern] entries
    ├── decisions.md       # [decision] entries
    ├── completions.md     # [done] entries
    └── mistakes.md        # [mistake] entries
```

**Pinned** — user explicitly said "remember this". Dream must NEVER remove these.
**Learned** — auto-extracted by dreaming. Dream can reorganize, deduplicate, remove.

---

## Scoring System

```text
stability = cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)
```

- Reinforcing bumps evidence count and resets decay. Pinned = 9999 (never decay). Forgotten = 0.
- **Lifecycle:** active → provisional → candidate → dropped

---

## Capacity Signal

The situation report header shows usage: `# Project Memory [72% — 1,224/1,700 tokens]`

- **Below 80%** — add freely
- **Above 80%** — consolidate before adding: merge related entries, remove outdated ones

---

## Memory Quality Rules (CRITICAL)

- **One line only** — max ~100 chars, single short sentence
- **Specific and actionable** — concrete "do X" or "don't do Y", no fluff
- **Preserve context scope** — if a preference was stated about a specific tool/project/workflow,
  include that scope in the memory. NEVER generalize a context-specific statement into a universal rule.

| ❌ Bad | ✅ Good |
|--------|---------|
| "We had issues with buildah and Docker caching and tried several approaches" | "buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid" |
| "User prefers a certain approach to handling processes" | "Attach child processes to pi (no detached:true) — kills on exit" |
| "Never use gemini-2.5-flash model" (said about a specific tool) | "Never use gemini-2.5-flash for X — unreliable for that use case" |

---

## When to Write

| Trigger | Category | Section |
|---------|----------|--------|
| User says "remember" / `/remember` | best fit | **Pinned** |
| PR merged | `done` | Learned |
| User corrects you | `lesson` | Learned |
| Multiple fix attempts | `mistake` | Learned |
| User states a preference | `preference` | Learned |

---

## Code-Enforced Memories (Enforcement Layer)

Some memories can be **code-enforced** — the LLM cannot ignore them because runtime hooks
check and act on them. Use enforcement when a rule is **mechanical** (can be checked by code).

Add enforcement by passing `trigger`, `action`, and optionally `verifier` to `memory_add`:

```text
memory_add(text="...", category="lesson",
  trigger="bash_contains git add .",
  action="block")
```

**When to add enforcement (AI decides automatically):**

| Pattern | Enforcement | Example |
|---------|-------------|--------|
| User corrects a specific command/tool usage | `trigger` + `block` | "never use git add ." |
| User wants something to run after a specific action | `trigger` + `run_after <cmd>` | "always deploy after code changes" |
| User wants a warning about a specific pattern | `trigger` + `warn` | "warn when modifying config files" |
| User wants tool A called before tool B | `verifier` | "always ask_user before gh pr merge" |
| General knowledge / context / facts | **No enforcement** | "buildah chown breaks cache mounts" |

**Rule of thumb:** If you can express it as "when X happens, do/block/warn Y" — add enforcement.
If it's knowledge that informs decisions but can't be checked mechanically — plain memory only.

**Trigger types:** `bash_contains <str>`, `bash_regex <pattern>`, `tool_name <name>`, `file_modified <pattern>` (matches file extensions like `*.py` or path substrings like `Dockerfile`)
**Action types:** `block` (prevent), `run_after <command>` (execute after), `warn` (append warning)
**Verifier:** `tool_called <tool> before <command>` (checked at turn_end, forces retry on violation)

---

## Per-Turn Self-Improvement (MANDATORY)

**After EVERY response, ask:** "Did this turn contain something worth remembering?"

| What happened | Action |
|---------------|--------|
| User corrected you / said "don't do X" / "always do Y" | `memory_add` as `lesson` or `preference` |
| Something failed or took multiple attempts | `memory_add` as `mistake` |
| PR merged / technical decision made / non-obvious pattern found | `memory_add` as `done` / `decision` / `pattern` |

**NEVER memorize:**

- Ideas or requests the user rejected, abandoned, or said "nevermind" to
- Unfinished conversations where no conclusion was reached
- User requirements that were never implemented

Only memorize **outcomes** (what happened), not **intentions** (what was discussed but dropped).

**Save immediately — do NOT wait for `/dream` or session shutdown.**

---

## CLI

```bash
uv run myk-pi-tools memory <command>   # Commands: add, forget, show, migrate, path, status
```

**Categories:** `lesson`, `decision`, `mistake`, `pattern`, `done`, `preference`

`memory status` — enforcement honesty inventory (code-tier vs injected topic counts + open promotions).

---

## Dreaming (Background Consolidation)

Background async agent that reads the session, extracts things worth remembering, adds/deduplicates/reorganizes topic files, and removes stale entries. **NEVER removes Pinned entries.**
Triggered by `/dream` (manual) or session shutdown (automatic).
**ALWAYS run as async + fireAndForget** — never block the session.

**Dreaming follows the same NEVER memorize rules as per-turn self-improvement:**
do NOT extract rejected/abandoned ideas, unfinished conversations, or unimplemented requirements.
Only extract outcomes, not intentions.

---

## Skill Creation (Procedural Memory)

Memory stores facts; **skills store procedures.**
When you complete a multi-step workflow (3+ steps, or doing the same multi-step task for the second time,
trial-and-error, or non-obvious commands), save it as a skill via `/create-skill <name>`.
Don't create skills for simple one-step tasks or standard workflows already covered by existing skills.

---

## Promotion Destinations (Correction → Structure)

Memories are a staging area. High-evidence or recurring lessons should graduate:

| Destination | When | Auto? |
|-------------|------|-------|
| `memory` | Stay as a scored topic line | default |
| `skill` | Multi-step recurring workflow | dream may write `.pi/skills/` |
| `enforcement` | Mechanical never/always + command/tool | safe auto-apply (`block`/`warn` + clear trigger) |
| `project_rule` | Project-wide convention, not mechanical | **propose only** — never auto-write `rules/` or `.pi/rules/` |
| `discard` | Stale / superseded | mark in queue |

Queue file: `.pi/memory/promotions.md`. Situation report shows open `proposed` items.
Thresholds (evidenceCount): enforcement/skill ≥ 3; project_rule ≥ 5.
On reinforce crossing a threshold, a promotion pass runs automatically.
`memory_consolidate` and dreaming must write promotion candidates to that queue.

---

## Provenance (optional)

`memory_add` / `memory_edit` accept optional `sourceSession`, `derivedFrom`, `informs`.
Preference extractor sets `sourceSession` when the session id is available.
Dream may write `.pi/memory/provenance-pending.json`; merge happens on dream complete.
Stored in `memory-scores.json` only — not injected into the situation report.
Shown in `memory_search` / `memory_reflect` when present.

---

## Query-class injection (automatic)

Injection biases section budgets from the user prompt (no tool call needed):
`pr_review`, `git_release`, `debug`, or `general`.
