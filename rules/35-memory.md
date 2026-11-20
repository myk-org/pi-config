# Project Memory

Scored, topic-organized memory injected into system prompts (Situation Report, vector recall >0.65, and keyword session recall).

---

## Memory Tools & Proactive Rules (MANDATORY)

- **`memory_search`** — **Call first** before answering questions about prior sessions, user preferences, or past decisions.
- **`memory_reinforce`** — Call whenever an existing memory is relevant to the current task to prevent decay.
- **`memory_add`** — Save immediately after any turn worth remembering (do NOT wait for `/dream` or shutdown). Duplicates auto-reinforce.
- **`memory_remove` / `memory_edit`** — Remove or update outdated, inaccurate, or superseded entries.
- **`memory_topics` / `session_search`** — Inspect topic hotness/counts or search past conversation summaries.

### Quality, Scope & Standing Test

- **One line (~100 chars max)**, specific and actionable ("do X" / "don't do Y").
- **Preserve context scope:** include tool/project/workflow scope — NEVER generalize a context-specific statement into a universal rule.
- **Pinned (`pinned: true`):** ONLY when the user explicitly says "remember" / `/remember`. Dream never removes Pinned entries.
- **Standing test:** would this apply to a future, unrelated task? If no → session instruction or task attribute, NOT memory.

**NEVER memorize:** rejected/abandoned ideas, unfinished discussions without conclusion, unimplemented requirements,
one-off permissions ("you can merge this PR"), or task-scoped instructions (deliverable formats, one-time migration steps,
session config notes). Memorize **outcomes**, not **intentions**.

### Conflict Resolution

When `memory_add` reports a contradiction:

1. Call `ask_user` to ask which rule is correct — never decide for the user.
2. If confirmed changed, retry `memory_add` with `overrideConflicts: true` (auto-supersedes non-pinned entries).
3. Pinned entries are never auto-superseded: remove/edit via `memory_remove` / `memory_edit` per explicit user instruction first, then add the new rule.

---

## When to Write (Per-Turn Self-Improvement)

After EVERY turn, check if anything worth remembering occurred:

| Trigger / Event | Category | Notes |
|---|---|---|
| User says "remember" / `/remember` | best fit | Set `pinned: true` |
| User corrects you / "don't do X" / "always do Y" | `lesson` or `preference` | Must pass standing test |
| Something failed or took multiple fix attempts | `mistake` | Include root cause/fix |
| PR merged / decision made / non-obvious pattern found | `done` / `decision` / `pattern` | — |
| One-off permission or task-scoped deliverable/step | — | **NOT a memory** |

**Capacity signal:** Situation report header shows `%` of token budget — add freely `<80%`; consolidate (merge related, remove outdated) before adding `>80%`.

---

## Code-Enforced Memories

For mechanical rules ("when X happens, do/block/warn Y"), pass `trigger`, `action`, and optional `verifier` to `memory_add`:

| Pattern | Enforcement | Example |
|---|---|---|
| Corrects a specific command/tool usage | `trigger` + `block` | "never use git add ." |
| Requires action after a specific change | `trigger` + `run_after <cmd>` | "always deploy after code changes" |
| Wants a warning on a specific pattern | `trigger` + `warn` | "warn when modifying config files" |
| Requires tool A before command B | `verifier` | "always ask_user before gh pr merge" |
| General knowledge / context / facts | **No enforcement** | "buildah chown breaks cache mounts" |

- **Triggers:** `bash_contains <str>`, `bash_regex <pattern>`, `tool_name <name>`, `file_modified <pattern>` (e.g. `*.py`, `Dockerfile`)
- **Actions:** `block` (prevent), `run_after <cmd>` (execute after), `warn` (append warning)
- **Verifier:** `tool_called <tool> before <command>` (checked at `turn_end`, forces retry on violation)

---

## Dreaming, Skills & Promotions

- **Dreaming (`/dream` or shutdown):** extracts outcomes, updates topic files, distills `.pi/memory/preference-candidates.jsonl`, and follows the same NEVER-memorize
  rules above (see `40-critical-rules.md` for `fireAndForget`).
- **Skills (procedural memory):** save recurring multi-step workflows (3+ steps, repeated 2+ times, trial-and-error, or non-obvious commands) via `/create-skill <name>`.
- **Promotions:** `.pi/memory/promotions.md` graduates recurring lessons (`memory_consolidate`/dreaming write candidates there; `evidenceCount` ≥ 3 →
  `skill`/`enforcement`; ≥ 5 → `project_rule`, **propose only — NEVER auto-write `rules/` or `.pi/rules/`**).
- **Reference & CLI:** `uvx myk-pi-tools@latest memory <add|forget|show|migrate|path|status>`; storage layout, decay scoring, provenance (`sourceSession`, `derivedFrom`,
  `informs`), and query-class budgets are documented in `docs/memory-architecture.md`.
