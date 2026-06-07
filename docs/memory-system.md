# Working with Project Memory

Teach pi what matters in your project — your preferences, lessons learned, and conventions — so it remembers across sessions and gets smarter over time.

- You need a pi session running in a git repository (pi stores memory under `.pi/memory/`)
- Memory works automatically once you start talking — but knowing the tools gives you full control

## Quick Example

Tell pi to remember something, and it persists across sessions:

```
/remember Always run tests with --no-cache flag
```

Or say it naturally in conversation — pi detects preference statements automatically:

```
I prefer using pnpm over npm for this project
```

Both approaches create memory entries that pi recalls in future sessions.

## How Memory Categories Work

Every memory entry belongs to one of six categories:

| Category | What it stores | How long it lasts |
|----------|---------------|-------------------|
| `preference` | How you like things done | 90 days (slow decay) |
| `lesson` | Gotchas, tips, how things work | 60 days |
| `pattern` | Recurring approaches, conventions | 30 days |
| `decision` | Architectural or design choices | 30 days |
| `done` | Completed tasks, merged PRs | 14 days (fast decay) |
| `mistake` | Things that went wrong | 14 days |

> **Note:** Decay doesn't mean deletion — it means lower priority. Memories you reinforce stay strong. Pinned memories never decay.

## Searching and Recalling Memories

Pi automatically recalls relevant memories before every response. You can also ask it directly:

```
What do you remember about our Docker setup?
```

Pi will use `memory_search` behind the scenes to find matching entries. Results combine keyword matching and semantic (vector) similarity search — so even paraphrased queries find the right memories.

You can search by category too:

```
Search my memories for lessons about CI/CD
```

## Adding Memories

### Explicit — You Tell Pi to Remember

Use the `/remember` command for important things you never want pi to forget:

```
/remember Use port 8443 for the dev server, not 8080
```

This creates a **pinned** entry that never decays and is protected from automatic cleanup.

### Proactive — Pi Remembers on Its Own

Pi adds memories automatically when it notices something worth saving:

| What happens | Category pi uses |
|-------------|-----------------|
| You correct pi | `lesson` |
| A fix attempt fails | `mistake` |
| You say "don't do X" or "always do Y" | `preference` |
| A PR gets merged | `done` |
| Pi notices a recurring pattern | `pattern` |
| An architectural decision is made | `decision` |

### Auto-extraction — Pi Detects Your Preferences

When you say things like "I prefer...", "always use...", "never...", or "from now on...", pi automatically extracts and saves them as preferences. No explicit command needed.

### CLI — Manage Memory from the Terminal

```bash
# Add a memory
uv run myk-pi-tools memory add -c lesson -s "buildah chown -R breaks cache mounts"

# Add a pinned memory
uv run myk-pi-tools memory add -c preference -s "Always use uv run" --pinned

# Remove a memory
uv run myk-pi-tools memory forget -c lesson -s "buildah chown -R breaks cache mounts"

# Show all memories
uv run myk-pi-tools memory show

# Print the memory directory path
uv run myk-pi-tools memory path
```

## Where Memories Are Stored

Memories live in your project under `.pi/memory/topics/` as simple Markdown files:

```
.pi/memory/
├── memory-scores.json          # Scoring data (auto-managed)
├── embeddings.json             # Vector embeddings (auto-managed)
└── topics/
    ├── preferences.md          # [preference] entries
    ├── lessons.md              # [lesson] entries
    ├── patterns.md             # [pattern] entries
    ├── decisions.md            # [decision] entries
    ├── completions.md          # [done] entries
    └── mistakes.md             # [mistake] entries
```

Each topic file is human-readable Markdown:

```markdown
# Preferences

- [preference] Always use pnpm over npm *(pinned)*
- [preference] Prefers concise responses
```

> **Tip:** You can edit these files directly — pi reads them as the source of truth on every session start.

## Memory Scoring and Decay

Every memory has a stability score that determines whether it appears in pi's context. The score decays over time unless reinforced.

**What keeps memories alive:**

- **Reinforcement** — when pi notices a memory is relevant to the current task, it bumps the evidence count, resetting the decay clock
- **Pinning** — pinned entries have a fixed score of 9999 and never decay
- **Repetition** — if you state a preference that already exists, pi reinforces it automatically

**Lifecycle states:**

| State | What it means |
|-------|--------------|
| `active` | Included in pi's context every turn |
| `provisional` | Overflow — included only when budget allows |
| `candidate` | Low priority — at risk of being dropped |
| `dropped` | No longer injected into context |

Per-category budgets keep memory focused: 8 entries max for preferences and lessons, 6 for patterns, 4 each for decisions, completions, and mistakes. A total cap of 40 active entries prevents context overload.

## Dreaming — Background Memory Consolidation

Dreaming is pi's way of processing memories in the background — deduplicating entries, removing stale information, and extracting new knowledge from past sessions.

### When Dreaming Runs

- **Automatically** every 3 hours (configurable)
- **On session shutdown** when you quit pi
- **On demand** with the `/dream` command

### Manual Trigger

```
/dream
```

This runs memory consolidation as a background agent — it never blocks your session.

### Toggle Auto-Dreaming

```
/dream-auto off    # Disable automatic dreaming
/dream-auto on     # Re-enable it
/dream-auto        # Check current status
```

### What Dreaming Does

1. Reads session transcripts and extracts durable knowledge
2. Adds new entries to the appropriate topic files
3. Deduplicates and removes stale entries
4. Generates reusable skills from recurring multi-step workflows
5. **Never** touches pinned entries

### Configuring the Dream Interval

Set the interval in `.pi/pi-config-settings.json`:

```json
{
  "dream_interval_hours": 6
}
```

Or via environment variable:

```bash
export PI_DREAM_INTERVAL_HOURS=6
```

Valid range: 0.5 to 24 hours. Default: 3 hours.

> **Note:** Project settings take priority over environment variables. See [Configuration and Environment Variables Reference](configuration-reference.html) for all settings.

## Capacity Management

The situation report header shows your current memory usage:

```
# Project Memory [72% — 1,224/1,700 tokens]
```

The total budget is 1,700 tokens by default, dynamically adjusted based on how much of the system prompt is used by rules and other context.

### When Memory Gets Full

When usage exceeds 80%, pi shows a warning:

```
> ⚠️ Memory above 80% capacity. Before adding new entries, consolidate or
> remove existing ones using memory_remove.
```

**To free up space:**

1. Ask pi to consolidate memories:
   ```
   Consolidate my project memory — find duplicates and remove stale entries
   ```

2. Remove specific outdated entries:
   ```
   Remove the memory about Python 3.11, we upgraded to 3.12
   ```

3. Run dreaming to auto-clean:
   ```
   /dream
   ```

### Topic File Size Limits

Each topic file is capped at ~3,000 tokens (12,000 characters). If you hit this limit on a specific category, pi will prompt you to consolidate or remove entries before adding new ones.

## Advanced Usage

### Memory Editing

Pi can update memories in place without losing scoring history:

```
Update my memory about the dev server port — it changed from 8443 to 9090
```

This preserves the evidence count and reinforcement history of the original entry, unlike a remove-then-add which starts fresh.

Pi can also invalidate superseded memories:

```
The memory about using webpack is outdated — we switched to vite
```

### Memory Reflection

Ask pi to synthesize an answer from its memories rather than returning raw entries:

```
What do you remember about how our deployment pipeline works?
```

Pi searches across all topic files using both keyword and vector similarity, then composes a coherent answer from the matching entries.

### Session History Search

Beyond topic-based memory, pi indexes summaries of past conversations. When you reference something from a previous session, pi automatically searches these summaries and injects relevant snippets — at zero LLM cost.

You can also search explicitly:

```
What did we discuss about the database migration last week?
```

Session summaries are stored in `.pi/data/session-search.json` and indexed on session shutdown.

### Contextual Memory Auto-Injection

Three mechanisms inject memory into pi's context automatically on every turn:

1. **Situation Report** — a token-budgeted summary of scored memories, always present at the top of pi's context
2. **Contextual Memory Recall** — vector similarity search against your current message, injecting entries with similarity > 0.65
3. **File-Change Reminders** — after pi modifies files, it searches for memories related to those file paths and surfaces relevant ones

> **Tip:** Trivial messages like "ok", "thanks", or emoji skip vector search to avoid wasted computation.

### Vector Embeddings

Memory search uses a local embedding model (`Xenova/bge-small-en-v1.5`, 384 dimensions) that runs entirely in-process — no API keys needed, no network calls. The model downloads automatically on first use (~50MB).

Embeddings are stored in `.pi/memory/embeddings.json` and created automatically when memories are added. On first search after upgrading, pi migrates existing entries that don't have embeddings yet.

### Retrieval Telemetry

Pi logs which memories were injected and whether they were actually used in the response. This data lives in `.pi/data/memory-telemetry.jsonl` and helps track memory effectiveness over time.

### Cold Topic Archival

Topics that haven't been reinforced for 2× their half-life are archived automatically (deleted). For example, a completions topic with no reinforcement for 28 days is removed. Pinned entries are never archived.

### Writing Good Memory Entries

| ❌ Avoid | ✅ Prefer |
|----------|----------|
| "We had issues with Docker caching" | "buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid" |
| "The integration was incomplete" | "Never close issues with unchecked deliverables in Done section" |
| "User prefers a certain approach" | "Attach child processes to pi (no detached:true) — kills on exit" |

Rules of thumb:
- **One line only** — max ~100 characters
- **Specific and actionable** — concrete "do X" or "don't do Y"
- **No fluff** — no context, background, or explanation

## Troubleshooting

**Memories aren't showing up in pi's context**

- Check capacity: if memory is at 100%, lower-priority entries are dropped. Remove or consolidate entries.
- Verify the entry exists: `uv run myk-pi-tools memory show`
- The entry may have decayed to `dropped` state — reinforce it by asking pi about the topic.

**Vector search isn't finding relevant memories**

- On first run, the embedding model downloads (~50MB). If it fails, pi falls back to keyword-only search.
- Check that `.pi/memory/embeddings.json` exists. If corrupted, delete it — pi rebuilds it on next search.

**Dreaming isn't running**

- Check status: `/dream-auto` (shows enabled/disabled)
- Dreaming is disabled in one-shot modes (`print`, `json`) — it only runs in interactive sessions.
- The dream interval may be too long. Check `.pi/pi-config-settings.json` or set `PI_DREAM_INTERVAL_HOURS`.

**Memory entries seem duplicated**

- Run `/dream` to trigger consolidation, which deduplicates entries.
- Or ask pi directly: "Consolidate my project memory — find and merge duplicates."

## Related Pages

- [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [myk-pi-tools CLI Reference](cli-reference.html)
