# Curating Project Memory

Project memory is what Pi carries from one session to the next. This page covers adding entries yourself, letting Pi capture them automatically, and auditing what it has learned. You should care because memory you save once stops you from repeating yourself, and memory you let accumulate becomes the basis for skills and enforced rules.

## The Big Picture

Memories live as plain Markdown bullets under `.pi/memory/topics/`, one file per category. Two entry points write to them:

- The `myk-pi-tools memory` CLI, for entries you decide on yourself.
- Pi's automatic capture, for preferences it notices in your messages.

## Quick Example

```bash
# Project preference
myk-pi-tools memory add -c preference -s "Always use uv run" --pinned

# Architectural decision
myk-pi-tools memory add -c decision -s "Use Redis for shared caching"

# Repeated pitfall
myk-pi-tools memory add -c mistake -s "Buildah chown -R skips the target dir on this OS"
```

## Step-by-Step

### 1. Save a memory from the CLI

Run `myk-pi-tools memory add -c <category> -s "<summary>"` from the project root. Both `-c` and `-s` are required.

### 2. Choose the right category

Use short, specific summaries. The CLI accepts these categories:

| Category | Use it for |
|---|---|
| `preference` | How you want work done |
| `decision` | A project choice that should stay consistent |
| `mistake` | A failure mode worth avoiding |
| `pattern` | A recurring convention or approach |
| `lesson` | A correction or practical takeaway |
| `done` | A completed milestone worth remembering |

> **Tip:** Keep each memory to one line. Short, concrete entries are easier for Pi to reuse well.

### 3. Pin rules that should not fade

```bash
myk-pi-tools memory add -c preference -s "Always use uv run" --pinned
```

Use `--pinned` for rules you want to keep stable over time. Pinned entries are protected during background cleanup and consolidation.

A good rule of thumb:

| If the memory is... | Save it as... |
|---|---|
| A long-term project rule | `--pinned` |
| A normal lesson from recent work | regular memory |
| A one-off observation | regular memory, only if it will matter again |

### 4. Save memories directly from chat when that is faster

Inside a Pi session, just ask for it in plain language, or call the `memory_add` tool directly:

```text
Remember that we always use uv run for Python commands in this repo.
```

The `memory_add` tool takes `category`, `text`, and an optional `pinned` flag, and writes the same topic file the CLI does. Use this when you are already in a session and want to save something without leaving chat.

### 5. Audit memory quality and promotion status

```bash
myk-pi-tools memory status
```

This gives you a quick health check of the memory system, including:

- topic-backed memory currently being injected as context
- code-enforced entries
- open promotion candidates

Use this when memory feels noisy, when a rule should probably become a hard guard, or when you want to confirm the project is learning from repeated corrections.

## Advanced Usage

### Let Pi capture preferences automatically

You do not need to save every preference manually. During normal conversation, Pi automatically looks for explicit signals such as:

- “I prefer…”
- “always use…”
- “never use…”

When those statements are clear enough, Pi records them as project preferences and reinforces them when they show up again later.

Automatic capture has three guards worth knowing:

- Messages shorter than 20 characters are ignored.
- Anything starting with `/` is skipped, so slash commands never become memories.
- The same preference is not re-extracted within a one-hour cooldown.

> **Note:** Automatic capture works best when you phrase the rule as a short, direct instruction instead of a long explanation.

### Inspect where memory is stored

```bash
myk-pi-tools memory path
```

Use this when you want to inspect the memory directory itself, back it up, or compare projects. This is especially useful if you work across multiple repositories and want to confirm you are editing the right project memory.

### Consolidate memory in the background

```text
/dream
/dream-auto on
```

Use `/dream` for a one-time background consolidation pass. Use `/dream-auto on` to let Pi keep consolidating memories automatically over time.

Background consolidation helps by:

- extracting durable lessons from past sessions
- deduplicating similar entries
- reorganizing topic files
- preserving pinned entries

If you want to tune the schedule, set `dream_interval_hours` in your project settings. See [Background Memory Consolidation (Dreaming)](background-dreaming.html) and [Configuration & Settings](configuration.html) for details.

### Migrate older memory data into topic files

```bash
myk-pi-tools memory migrate
```

If your project still has older memory data from a previous format, run this once to move it into the current topic-based layout. This is mainly useful when upgrading an existing project rather than starting fresh.

### Learn from review feedback automatically

When you skip a code review finding for a reason that applies more broadly, Pi can reuse that decision in future reviews so the same kind of complaint does not keep coming back.

Use this together with your PR workflow, then review the results in later cycles. See [Automating Code Reviews](automating-code-reviews.html) for details.

### Know when to use memory versus hard guards

Use memory for guidance such as preferences, patterns, and decisions. Use a command guard when a rule must be enforced mechanically, not just remembered.

Examples:

| Need | Better fit |
|---|---|
| “Prefer this style in this repo” | Project memory |
| “Never allow this dangerous command” | Command guard |
| “Remember this design choice for future work” | Project memory |
| “Block this action unless another step happened first” | Command guard |

See [Implementing Command Guards](safety-enforcements.html) for details.

## Troubleshooting

- **A saved rule does not seem to affect later sessions:** Run `myk-pi-tools memory show` and confirm the entry is present. If it is critical, save it again as a pinned memory with a shorter, clearer summary.
- **Automatic background consolidation does not run:** If you are on an ACPX-backed provider, set both `internal_operations_provider` and `internal_operations_model` — dreaming is skipped outright otherwise. See [Configuration & Settings](configuration.html).
- **Memory feels too noisy or repetitive:** Check `myk-pi-tools memory status`, keep entries one-line and specific, then run `/dream` to consolidate the store.
- **You need deeper scoring and lifecycle details:** See [Memory Architecture](memory-architecture.html) for details.

## Related Pages

- [Memory Architecture](memory-architecture.html)
- [Background Memory Consolidation (Dreaming)](background-dreaming.html)
- [Implementing Command Guards](safety-enforcements.html)
- [Configuration & Settings](configuration.html)
- [Built-in Workflow Commands](built-in-workflows.html)
