# Project Memory

Persistent per-repo memory in `.pi/memory/memory.md`. Loaded automatically at session start.

**CLI:** `uv run myk-pi-tools memory <command>`

---

## Memory File Format

The memory file has two sections:

```markdown
# Memories

## Pinned (user requested — never auto-remove)
- [preference] Always use uv run, never python directly
- [lesson] Never merge PRs without asking first

## Learned (auto-extracted — dream may reorganize/remove)
- [lesson] buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid
- [mistake] Closed issue with incomplete deliverables — check Done section before closing
```

**Pinned** — user explicitly said "remember this". Dream must NEVER remove these.
**Learned** — auto-extracted by dreaming. Dream can reorganize, deduplicate, remove.

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

---

## CLI

```bash
uv run myk-pi-tools memory add -c <category> -s "summary"             # Add to Learned
uv run myk-pi-tools memory add -c <category> -s "summary" --pinned    # Add to Pinned
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
4. **Writes** the updated memory.md
5. **NEVER** removes or modifies Pinned entries

### Rules

- **ALWAYS run dreaming as async + fireAndForget** — never block the session, never inject results into conversation
- Tell the user: "Running memory consolidation in background..."
