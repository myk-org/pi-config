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

Delegate to a `worker` agent with `async: true`:

```text
Task:
1. Run: uv run myk-pi-tools memory dream
2. Run: uv run myk-pi-tools memory prune (dry-run, report candidates)
3. Report the dream output and prune candidates
```

Tell the user: "Running memory consolidation in background..."

The async agent result will surface automatically when complete.
