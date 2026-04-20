# Project Memory

Persistent per-repo memory in `.pi/memory/memories.db`. Loaded automatically at session start.

**CLI:** `uv run myk-pi-tools memory <command>`

---

## Memory Quality Rules (CRITICAL)

- **One line only** — summaries MUST be a single short sentence, max ~100 chars
- **Specific and actionable** — not vague observations, but concrete "do X" or "don't do Y"
- **No fluff** — no context, no background, no explanation. Just the fact.
- **Tags are mandatory** — always add relevant tags for searchability

### Good vs Bad

| ❌ Bad | ✅ Good |
|--------|---------|
| "We had issues with buildah and Docker caching and tried several approaches before finding the right one" | "buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid instead" |
| "The memory system was implemented but the integration was incomplete" | "Never close issues with unchecked deliverables in Done section" |
| "User prefers a certain approach to handling processes" | "Attach child processes to pi (no detached:true) — kills on exit" |

---

## When to Write

| Trigger | Category | Sentiment |
|---------|----------|-----------|
| PR merged | `done` | positive |
| User corrects you | `lesson` | negative |
| Multiple fix attempts | `mistake` | negative |
| User states a preference | `preference` | neutral |
| User says "remember" / `/remember` | best fit | best fit |

---

## When to Read

- **Before implementation** — `uv run myk-pi-tools memory search "<keywords>"`
- **User asks about past work** — `uv run myk-pi-tools memory list -c done`

---

## CLI

```bash
uv run myk-pi-tools memory add -c <category> -s "summary" [-t "tags"] [--sentiment positive|negative|neutral]
uv run myk-pi-tools memory search "<query>"
uv run myk-pi-tools memory list [--last <days>] [-c <category>]
uv run myk-pi-tools memory delete <id>
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

Dreaming is a **self-contained action** — one command does everything:

1. **Extracts** useful memories from the current session (user corrections, preferences, lessons, completed work)
2. **Scores** all memories by recall frequency, recency, age, and category
3. **Prunes** low-value memories (actually deletes them)
4. **Merges** duplicate memories (detects via text similarity)

### CLI Commands

```bash
uv run myk-pi-tools memory stats           # Memory statistics
uv run myk-pi-tools memory score           # Ranked memories by score
uv run myk-pi-tools memory prune           # Preview prune candidates
uv run myk-pi-tools memory prune --apply   # Actually prune
uv run myk-pi-tools memory dream           # Run consolidation + report
```

### Rules

- **ALWAYS run dreaming as async + fireAndForget** — never block the session, never inject results into conversation
- Tell the user: "Running memory consolidation in background..."
