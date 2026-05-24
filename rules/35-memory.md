# Project Memory

Scored, topic-organized memory system with stability-based decay.
Memories are scored, prioritized, and injected into the system prompt via situation reports.

**CLI:** `uv run myk-pi-tools memory <command>`

---

## Memory Tools (MANDATORY)

You have six memory tools. **USE THEM PROACTIVELY:**

### `memory_search` — Search Before Answering

**MANDATORY:** Before answering questions about prior sessions, user preferences,
past decisions, recurring patterns, or anything the user mentioned before —
call `memory_search` first.

```text
memory_search(query: "docker")           # Search by keyword
memory_search(query: "PR", category: "lesson")  # Filter by category
```

### `memory_reinforce` — Reinforce When Relevant

**MANDATORY:** When you notice a memory is relevant to the current task,
call `memory_reinforce` to bump its evidence count. This prevents useful
memories from decaying.

```text
memory_reinforce(entryText: "...", category: "lesson")
```

### `memory_add` — Add New Memories Proactively

**MANDATORY:** When you learn something worth remembering — user preferences,
environment facts, corrections, conventions, completed work — add it immediately.
Don't wait for dreaming or CLI. You own your memory.

```text
memory_add(text: "Always use --admin for gate-blocked PRs", category: "lesson")
memory_add(text: "User prefers concise responses", category: "preference", pinned: true)
```

**Rules:**

- Keep entries short (one line, ~100 chars max)
- Be specific and actionable — not vague observations
- Use `pinned: true` ONLY when the user explicitly says "remember this"
- If the entry already exists, it's automatically reinforced instead

### `memory_remove` — Remove Outdated Memories

Remove entries that are no longer accurate or relevant. Use when information
is outdated, wrong, or superseded by a newer entry.

```text
memory_remove(text: "Project uses Python 3.11", category: "lesson")
```

### `memory_topics` — Inspect Topic Organization

List all memory topic files with hotness scores and entry counts.

### `session_search` — Recall Past Conversations

Search past conversation summaries. Use when the user references something
from a previous session, or when you need to recall what was discussed before.
Returns matching snippets at zero LLM cost — no summarization, no token usage.

```text
session_search(query: "docker container build")
session_search(query: "coderabbit review", limit: 5)
```

---

## Memory Storage

Memories are stored in topic files under `.pi/memory/topics/`:

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

Each topic file uses this format:

```markdown
# TopicName

- [category] entry text *(pinned)*
- [category] entry text
```

**Pinned** — user explicitly said "remember this". Dream must NEVER remove these.
**Learned** — auto-extracted by dreaming. Dream can reorganize, deduplicate, remove.

---

## Scoring System

Every memory has a stability score that decays over time:

```text
stability = cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)
```

- **Reinforcing** a memory (via `memory_reinforce`) bumps its evidence count and resets decay
- **Pinned** entries have score = 9999 (never decay)
- **Forgotten** entries have score = 0 (always dropped)
- Entries below the eviction threshold are dropped automatically

**Lifecycle:** active → provisional → candidate → dropped

---

## Capacity Signal

The situation report header shows current memory usage:

```text
# Project Memory [72% — 1,224/1,700 tokens]
```

- **Below 80%** — add freely
- **Above 80%** — consolidate before adding: merge related entries, remove outdated ones using `memory_remove`
- The system warns you when capacity is high

---

## Memory Quality Rules (CRITICAL)

- **One line only** — entries MUST be a single short sentence, max ~100 chars
- **Specific and actionable** — not vague observations, but concrete "do X" or "don't do Y"
- **No fluff** — no context, no background, no explanation. Just the fact.

### Good vs Bad

| ❌ Bad | ✅ Good |
|--------|---------|
| "We had issues with buildah and Docker caching and tried several approaches before finding the right one" | "buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid instead" |
| "The memory system was implemented but the integration was incomplete" | "Never close issues with unchecked deliverables in Done section" |
| "User prefers a certain approach to handling processes" | "Attach child processes to pi (no detached:true) — kills on exit" |

---

## When to Write

| Trigger | Category | Section |
|---------|----------|--------|
| User says "remember" / `/remember` | best fit | **Pinned** |
| PR merged | `done` | Learned |
| User corrects you | `lesson` | Learned |
| Multiple fix attempts | `mistake` | Learned |
| User states a preference | `preference` | Learned |

**Use `memory_add` tool directly** — don't delegate to CLI or wait for dreaming.
You are the curator of your own memory.

---

## CLI

```bash
uv run myk-pi-tools memory add -c <category> -s "summary"             # Add to Learned
uv run myk-pi-tools memory add -c <category> -s "summary" --pinned    # Add to Pinned
uv run myk-pi-tools memory forget -c <category> -s "summary"          # Remove an entry
uv run myk-pi-tools memory show                                       # Show memory file
uv run myk-pi-tools memory migrate                                    # One-time DB→md migration
uv run myk-pi-tools memory path                                       # Print file path
```

**Categories:** `lesson`, `decision`, `mistake`, `pattern`, `done`, `preference`

---

## Dreaming (Background Consolidation)

Inspired by [OpenClaw's dreaming system](https://docs.openclaw.ai/concepts/dreaming).

Memory consolidation runs as a **background async agent** — never blocking the session.

### Triggers

- `/dream` command — manual trigger
- Session shutdown — automatic lightweight pass

### What it does

Dreaming is a **self-contained action** — the LLM worker:

1. **Reads** the session file and extracts things worth remembering
2. **Adds** new entries to the Learned section
3. **Reorganizes** the memory file — deduplicates, removes stale entries
4. **Writes** updated topic files under .pi/memory/topics/
5. **NEVER** removes or modifies Pinned entries

### Rules

- **ALWAYS run dreaming as async + fireAndForget** — never block the session, never inject results into conversation
- Tell the user: "Running memory consolidation in background..."
