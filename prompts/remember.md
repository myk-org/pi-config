---
description: "Save a memory for future sessions — /remember <what to remember>"
argument-hint: "<what to remember>"
---

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior,
> or reproducible bug while executing this command — DO NOT work around it
> silently. Ask the user: "Should I create a GitHub issue for this?"
> Route to `myk-org/pi-config` for prompt/extension issues,
> or to the relevant tool's repository for CLI issues.

## What to remember

```text
$ARGUMENTS
```

Save this as a **Pinned** project memory. Determine the best category:

- `lesson` — something learned (how things work, gotchas, tips)
- `decision` — an architectural or design choice made
- `mistake` — something that went wrong and should be avoided
- `pattern` — a recurring approach or convention
- `done` — a completed task or milestone
- `preference` — user preference for how things should be done

Run:

```bash
uv run myk-pi-tools memory add -c <category> -s "<concise one-line summary>" --pinned
```

After saving, confirm what was stored.
