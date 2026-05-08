# Saving and Recalling Project Knowledge

Build a persistent knowledge base for your repository so your agents avoid past mistakes, remember your preferences, and apply lessons from previous sessions — automatically.

## Prerequisites

- Pi is installed and running with the orchestrator config
- Your project is inside a git repository

## Quick Example

Tell pi to remember something important:

```
/remember Always use uv run, never python directly
```

Pi saves this as a **pinned** memory. Next time you start a session in this repo, every agent sees it and follows it — no reminding needed.

## How Memory Works

Memories live in a plain markdown file at `.pi/memory/memory.md` inside your repo. Pi loads them automatically at the start of every session, before any other instructions. Agents treat memories as high-priority guidance.

The file has two sections:

| Section | Who creates it | Can dreaming remove it? | Use case |
|---------|---------------|------------------------|----------|
| **Pinned** | You, via `/remember` | Never | Preferences, critical lessons, key decisions |
| **Learned** | Automatic (dreaming) | Yes — deduplicates and cleans up | Session observations, extracted patterns |

## Saving Memories

### The `/remember` Command

Use `/remember` followed by what you want to store:

```
/remember buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid
/remember Always run tests before closing a PR
/remember We chose SQLite for local state, not in-memory dicts
```

Each memory is saved to the **Pinned** section and categorized automatically into one of six types:

| Category | When to use |
|----------|-------------|
| `lesson` | Something learned — gotchas, tips, how things work |
| `preference` | How you want things done |
| `decision` | An architectural or design choice |
| `mistake` | Something that went wrong and should be avoided |
| `pattern` | A recurring approach or convention |
| `done` | A completed task or milestone |

> **Tip:** Write memories as short, actionable statements. "Always do X" or "Never do Y" works best. Avoid vague observations.

### Memory Quality

Good memories are specific and fit on one line (~100 characters max):

| Bad | Good |
|-----|------|
| "We had issues with buildah and Docker caching and tried several approaches" | "buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid" |
| "The integration was incomplete" | "Never close issues with unchecked deliverables in Done section" |
| "User prefers a certain approach to handling processes" | "Attach child processes to pi (no detached:true) — kills on exit" |

## Recalling Memories

You don't need to do anything — memories are loaded automatically at session start. Every agent in the session sees them and applies them proactively.

- **Pinned memories** are always present, session after session
- **Learned memories** persist until dreaming cleans them up (if stale or duplicated)
- Subagents can read memories but cannot write new ones — only the orchestrator manages the memory file

## Memory Dreaming (Automatic Consolidation)

Dreaming is a background process that reviews your session, extracts new learnings, and keeps the memory file clean. It runs without interrupting your work.

### What dreaming does

1. Reads the current session to find things worth remembering
2. Adds new entries to the **Learned** section (user corrections become lessons, stated preferences become preferences, repeated mistakes get flagged)
3. Deduplicates and removes stale entries from Learned
4. Keeps the file under 50 entries
5. **Never** touches your Pinned entries

### Triggering a dream manually

```
/dream
```

This runs consolidation as a background task. You'll see "Running memory consolidation in background..." and can keep working.

### Automatic dreaming

Toggle automatic dreaming on or off:

```
/dream-auto on
/dream-auto off
```

When enabled, dreaming runs:
- **Every 3 hours** while pi is active
- **On session shutdown** (a lightweight pass)

> **Tip:** Change the interval by setting the `PI_DREAM_INTERVAL_HOURS` environment variable (range: 0.5–24 hours, default: 3).

## Advanced Usage

### CLI Commands

You can manage memories directly from the command line:

```bash
# Add a learned memory
uv run myk-pi-tools memory add -c lesson -s "buildah chown -R skips target dir"

# Add a pinned memory
uv run myk-pi-tools memory add -c preference -s "Always use uv run" --pinned

# View all memories
uv run myk-pi-tools memory show

# Print the memory file path
uv run myk-pi-tools memory path
```

### Editing the Memory File Directly

The memory file is plain markdown. You can open `.pi/memory/memory.md` in any editor to add, remove, or reorganize entries. Keep the two-section format:

```markdown
# Memories

## Pinned (user requested — never auto-remove)
- [preference] Always use uv run, never python directly
- [lesson] Never merge PRs without asking first

## Learned (auto-extracted — dream may reorganize/remove)
- [lesson] buildah chown -R breaks cache mounts — use --mount=type=cache with correct uid
- [mistake] Closed issue with incomplete deliverables — check Done section before closing
```

> **Warning:** Do not change the section headers — the system uses them to distinguish pinned from learned entries.

### Migrating from the Old Database

If your project used the older SQLite-based memory system, migration happens automatically on first session start. You can also trigger it manually:

```bash
uv run myk-pi-tools memory migrate
```

This reads all memories from `memories.db`, writes them to `memory.md`, then cleans up the old database files.

## Troubleshooting

**Memories aren't showing up in new sessions**
- Check that `.pi/memory/memory.md` exists and has entries. Run `uv run myk-pi-tools memory show` to verify.
- Make sure the file is inside a git repository — the memory path is relative to the git root.

**Dreaming removed a memory I wanted to keep**
- Use `/remember` to save it as a Pinned entry. Pinned entries are protected from automatic cleanup.

**Too many memories cluttering the file**
- Run `/dream` to trigger consolidation, which deduplicates and removes stale entries.
- Edit `.pi/memory/memory.md` directly to remove entries you no longer need.
