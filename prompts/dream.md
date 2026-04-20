---
description: "Run memory consolidation — extract, deduplicate, reorganize memories — /dream"
---

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior,
> or reproducible bug while executing this command — DO NOT work around it
> silently. Ask the user: "Should I create a GitHub issue for this?"
> Route to `myk-org/pi-config` for prompt/extension issues,
> or to the relevant tool's repository for CLI issues.

## Memory Dreaming

Inspired by [OpenClaw's dreaming system](https://docs.openclaw.ai/concepts/dreaming).

Run memory consolidation as a **background async agent** — never block the session.

Dreaming is a **self-contained action** — the LLM worker:

1. Reads the session file and extracts things worth remembering
2. Adds new entries to the Learned section of memory.md
3. Reorganizes — deduplicates, removes stale entries from Learned
4. NEVER removes Pinned entries

Delegate to a `worker` agent with `async: true` and `fireAndForget: true` (no result injection into conversation):

```text
Task:
1. Read the current session file to find things worth remembering
2. Read the memory file: uv run myk-pi-tools memory show
3. Add new entries: uv run myk-pi-tools memory add -c <category> -s "<summary>"
4. Reorganize the memory file — deduplicate and remove stale Learned entries
5. NEVER remove or modify Pinned entries
```

Tell the user: "Running memory consolidation in background..."
