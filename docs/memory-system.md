# Working with Project Memory

Teach pi your preferences, lessons learned, and project conventions so it remembers them across sessions. The memory system scores each entry by how often you reinforce it, automatically decays stale knowledge, and injects the most relevant memories into every conversation.

## Prerequisites

- A pi session running in an initialized project (a `.pi/` directory will be created automatically)
- No extra setup — memory works out of the box in every session

## Quick Example

Tell pi something worth remembering:

```
/remember Always run tests with --verbose flag in this project
```

Or just say it naturally in conversation — pi auto-detects preference statements like "I prefer," "always use," or "never":

```
I prefer short commit messages, one line max
```

Both approaches store the memory and recall it in future sessions automatically.

## How Memories Are Organized

Memories are stored in topic files under `.pi/memory/topics/`, one file per category:

| Category | File | What to store | Decay half-life |
|----------|------|---------------|-----------------|
| `preference` | `preferences.md` | How the user likes things done | 90 days |
| `lesson` | `lessons.md` | Gotchas, tips, how things work | 60 days |
| `pattern` | `patterns.md` | Recurring conventions or approaches | 30 days |
| `decision` | `decisions.md` | Architectural or design choices | 30 days |
| `done` | `completions.md` | Completed features, merged PRs | 14 days |
| `mistake` | `mistakes.md` | Things that went wrong, to avoid | 14 days |

Each entry is a single short line — specific, actionable, and max ~100 characters:

```markdown
# Lessons

- [lesson] buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid instead
- [lesson] Always check PR merge status before closing issues
```

## Adding Memories

You have three ways to add memories, depending on the situation.

### 1. The `/remember` command

Use this for anything you explicitly want pi to keep. Memories added this way are **pinned** — they never decay and dreaming never removes them:

```
/remember This repo uses pnpm, not npm
/remember Deploy to staging before production — always
```

### 2. Natural conversation

Pi automatically detects preference statements in your messages. Phrases like "I prefer," "always use," "from now on," and "please never" trigger auto-extraction:

```
From now on, use single quotes in TypeScript files
I always want error messages in English
```

> **Tip:** Auto-extracted preferences are learned (not pinned), so they'll decay if never reinforced. Say `/remember` if you want them permanent.

### 3. The CLI

For scripting or manual management outside a pi session:

```bash
# Add a learned memory
uv run myk-pi-tools memory add -c lesson -s "Run migrations before deploying"

# Add a pinned memory (never auto-removed)
uv run myk-pi-tools memory add -c preference -s "Use uv, not pip" --pinned
```

## Viewing Your Memories

Inside a pi session, ask pi to list your memory topics:

```
What's in my project memory?
```

Pi will call `memory_topics` and show you each topic file with its entry count and activity level.

From the CLI:

```bash
uv run myk-pi-tools memory show
```

## How Memories Reach Pi Automatically

You don't need to manually search memory before every question — three auto-injection mechanisms handle this:

1. **Situation report** — A token-budgeted summary of your highest-scored memories is always included in pi's system prompt. Preferences and lessons get top priority.

2. **Contextual memory recall** — When you send a message, pi runs a vector similarity search against your memories. Entries with high relevance appear automatically as context.

3. **Session history recall** — Pi also searches past conversation summaries by keyword, surfacing relevant discussions from previous sessions.

4. **File-change reminders** — After pi modifies files, it checks if any memories relate to those files and surfaces them as reminders.

> **Note:** Trivial messages like "ok," "thanks," or emoji-only responses skip the search — no wasted computation.

## Searching Memory Manually

When you need to look something up from a past session or check what pi remembers about a topic, just ask:

```
What do you remember about our Docker setup?
Search memory for "deployment"
```

Pi will use `memory_search` (hybrid keyword + vector search) to find matching entries. You can also ask pi to search past conversations:

```
What did we discuss about the API refactor last week?
```

## Removing and Editing Memories

### Remove an outdated memory

```
Remove the memory about Python 3.11 from lessons
```

Or from the CLI:

```bash
uv run myk-pi-tools memory forget -c lesson -s "Project uses Python 3.11"
```

### Edit a memory in place

Ask pi to update a memory without losing its scoring history:

```
Update the lesson about Docker caching — change it to "Use buildkit cache mounts with --mount=type=cache"
```

Pi uses `memory_edit` to replace the text while preserving the evidence count and score.

### Invalidate a superseded memory

```
The decision about using REST is outdated — we switched to gRPC. Invalidate it.
```

## Pinned vs Learned Memories

| | Pinned | Learned |
|---|---|---|
| **Created by** | `/remember`, `--pinned` flag, or `memory_add` with `pinned: true` | Auto-extraction, dreaming, pi's proactive writes |
| **Decays?** | Never (score = 9999) | Yes — based on category half-life |
| **Removed by dreaming?** | Never | Yes — if stale or redundant |
| **When to use** | Critical preferences, permanent rules | Everything else |

> **Tip:** Don't over-pin. Let learned memories decay naturally — if something is important, it gets reinforced through use and stays alive on its own.

## Understanding Scores and Decay

Every learned memory has a stability score that decreases over time unless reinforced. The formula combines three factors:

- **Recency** — how recently the memory was last reinforced (exponential decay based on category half-life)
- **Evidence** — how many times the memory has been reinforced (logarithmic growth)
- **Cue weight** — how the memory was created (explicit user statements score highest)

Memories move through lifecycle states as their score changes:

| State | Meaning |
|---|---|
| **Active** | Included in the situation report, injected into prompts |
| **Provisional** | Overflow — included if budget allows |
| **Candidate** | Low score, at risk of being dropped |
| **Dropped** | Below threshold, no longer injected |

Pi automatically reinforces memories it notices are relevant to the current task. You can also reinforce manually:

```
That lesson about cache mounts was really helpful — reinforce it
```

## Memory Capacity

The situation report header shows your current usage:

```
# Project Memory [72% — 1,224/1,700 tokens]
```

- **Below 80%** — Add memories freely
- **Above 80%** — Pi warns you to consolidate before adding more

When you're running out of space, ask pi to consolidate:

```
Consolidate my memories
```

Pi will review all entries, merge duplicates, remove contradictions, and clean up stale information. You can also remove entries manually to free space.

> **Note:** Each topic file is capped at approximately 3,000 tokens. If a single category gets too large, you'll need to remove or consolidate entries before adding more.

## Advanced Usage

### Dreaming: Background Memory Consolidation

Dreaming is a background process that reviews your session history, extracts useful knowledge, and cleans up memory — all without blocking your session.

**Automatic dreaming** runs on two schedules:
- Every 3 hours (configurable) — a background agent reads past sessions and extracts durable knowledge
- On session shutdown — a lightweight pass captures anything from the ending session

**Manual dreaming:**

```
/dream
```

**Toggle automatic dreaming:**

```
/dream-auto off    # Disable auto-dreaming
/dream-auto on     # Re-enable it
```

The status bar shows a 🌙 icon — highlighted when a dream is actively running.

#### What dreaming does

1. Reads the current session and recent past sessions
2. Extracts lessons, corrections, completed work, and preferences
3. Deduplicates and cleans up existing topic files
4. Auto-generates reusable skills from recurring multi-step workflows
5. **Never** touches pinned entries

#### Configuring dream frequency

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

> **Note:** A separate scoring rebuild runs every 30 minutes (no LLM cost — it just recalculates stability scores and reorganizes entries).

### Duplicate Detection with Vector Embeddings

When pi adds a memory, it checks for near-duplicates using vector similarity (threshold: 0.85). If you try to add "Always use pnpm" and "Use pnpm, not npm" already exists, pi reinforces the existing entry instead of creating a duplicate.

This runs locally using an in-process embedding model — no API keys, no network calls. The first search in a session may take a moment to initialize the model; subsequent searches are near-instant (~2.5ms).

Embeddings are stored in `.pi/memory/embeddings.json` and managed automatically.

### Memory Quality Guidelines

Write memories that are specific and actionable — not vague observations:

| ❌ Bad | ✅ Good |
|--------|---------|
| "We had issues with Docker caching" | "buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid" |
| "The memory system was incomplete" | "Never close issues with unchecked deliverables in Done section" |
| "User prefers a certain approach" | "Attach child processes to pi (no detached:true) — kills on exit" |

Rules of thumb:
- One line, ~100 characters max
- Concrete "do X" or "don't do Y" — not background explanations
- No fluff, no context, just the fact

### Skill Creation from Memory Patterns

When dreaming detects a multi-step workflow that recurs across entries (3+ steps), it can auto-generate a **skill** — a reusable procedure saved as a file. You can also create skills manually:

```
/create-skill deploy-staging
```

This extracts the workflow from the current conversation and saves it for future sessions. See [Customization and Extension Recipes](customization-recipes.html) for details.

### Per-Category Budget Caps

The scoring system enforces per-category limits to keep memory balanced:

| Category | Max active entries |
|----------|-------------------|
| `preference` | 8 |
| `lesson` | 8 |
| `pattern` | 6 |
| `decision` | 4 |
| `done` | 4 |
| `mistake` | 4 |

There's an additional overflow pool of 6 entries for provisional items, and a hard cap of 40 total active entries. Entries beyond these limits are demoted to lower lifecycle states.

### Retrieval Telemetry

Pi logs which memories are injected and whether they were actually used in responses. This data lives at `.pi/data/memory-telemetry.jsonl` and helps you understand which memories are providing value.

## Troubleshooting

**Memory not showing up in pi's responses**

- Check that the entry is in the right topic file: `uv run myk-pi-tools memory show`
- The entry may have decayed below the active threshold — ask pi to search for it and reinforce it
- Scoring rebuilds run every 30 minutes; a freshly added entry should be active immediately

**"Topic would exceed size limit" error**

- A single topic file has reached its ~3,000-token cap
- Remove outdated entries with `memory_remove` or ask pi to consolidate
- Run `/dream` to trigger automatic cleanup

**Memory capacity at 80%+**

- Ask pi: "Consolidate my memories"
- Remove completed work entries (`done` category) that are no longer relevant
- Check if duplicate entries exist across topics

**Auto-extracted preferences you didn't intend**

- Pi detects phrases like "I always" even in casual statements
- Remove unwanted entries: ask pi to remove the specific memory
- Auto-extracted entries are learned (not pinned), so they'll decay on their own if never reinforced

## Related Pages

- [Memory Scoring, Embeddings, and Situation Reports](memory-internals.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Customization and Extension Recipes](customization-recipes.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
