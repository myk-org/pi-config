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
Task: Memory dreaming — analyze session and maintain memory.md.
Memory file: <memPath from `uv run myk-pi-tools memory path`>
Session file: <current session file if available>

Steps:
1. Read the memory file directly.
2. If a session file is provided, read it and extract things worth remembering:
   - User corrections → [lesson]
   - User preferences → [preference]
   - Mistakes or repeated fix attempts → [mistake]
   - Completed features/PRs merged → [done]
   - Patterns or conventions → [pattern]
   Add new entries to the Learned section. Do NOT add duplicates.
3. Reorganize the memory file:
   - Remove duplicate or near-duplicate entries from Learned
   - Remove stale/useless entries from Learned
   - Keep under 50 entries
   - NEVER remove or modify entries in the Pinned section
4. Write the updated file using the write tool. Keep the exact format:

   # Memories
   ## Pinned (user requested — never auto-remove)
   - [category] summary
   ## Learned (auto-extracted — dream may reorganize/remove)
   - [category] summary

5. Memory rules: one line per entry, max ~100 chars, specific and actionable.
```

Tell the user: "Running memory consolidation in background..."
