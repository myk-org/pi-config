---
description: "Run memory consolidation — extract, deduplicate, reorganize memories — /dream"
---

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues,
> or to the relevant tool's repository for CLI issues.

## Memory Dreaming

Inspired by [OpenClaw's dreaming system](https://docs.openclaw.ai/concepts/dreaming).

Run memory consolidation as a **background async agent** — never block the session.

Delegate to a `worker` agent with `async: true` and `fireAndForget: true`:

```text
Task: Memory dreaming — analyze session and maintain topic files.
Memory topics directory: <from `uv run myk-pi-tools memory path`>/../topics/
Session file: <current session file if available>

Steps:
1. Read the topic files under .pi/memory/topics/ (lessons.md, preferences.md, patterns.md, decisions.md, completions.md, mistakes.md).
2. If a session file is provided, read it and extract things worth remembering:
   - User corrections → [lesson] in lessons.md
   - User preferences → [preference] in preferences.md
   - Mistakes or repeated fix attempts → [mistake] in mistakes.md
   - Completed features/PRs merged → [done] in completions.md
   - Patterns or conventions → [pattern] in patterns.md
   Add new entries to the appropriate topic file. Do NOT add duplicates.
3. Reorganize each topic file:
   - Remove duplicate or near-duplicate entries
   - Remove stale/useless entries
   - NEVER remove or modify pinned entries (marked with *(pinned)*)
4. Write the updated topic files. Each file uses this format:

   # TopicName
   - [category] entry text *(pinned)*
   - [category] entry text

5. Memory rules: one line per entry, max ~100 chars, specific and actionable.
```

Tell the user: "Running memory consolidation in background..."
