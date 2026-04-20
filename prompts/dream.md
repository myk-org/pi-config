---
description: "Run memory consolidation — score, prune, generate dream report — /dream"
---

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior,
> or reproducible bug while executing this command — DO NOT work around it
> silently. Ask the user: "Should I create a GitHub issue for this?"
> Route to `myk-org/pi-config` for prompt/extension issues,
> or to the relevant tool's repository for CLI issues.

## Memory Dreaming

Inspired by [OpenClaw's dreaming system](https://docs.openclaw.ai/concepts/dreaming).

Run memory consolidation as a **background async agent** — never block the session.

Dreaming is a **self-contained action** — one command does everything:

1. Scores all memories by recall frequency, recency, age, and category
2. Prunes low-value memories (actually deletes them)
3. Merges duplicate memories (detects via text similarity)
4. Generates a report of everything done

Delegate to a `worker` agent with `async: true` and `fireAndForget: true` (no result injection into conversation):

```text
Task:
Run: uv run myk-pi-tools memory dream
```

Tell the user: "Running memory consolidation in background..."

The async agent result will surface automatically when complete.
