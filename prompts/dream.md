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

Topic files are the source of truth for project memory. Each file holds entries for one category.

Steps:
1. Read all existing topic files under .pi/memory/topics/ (lessons.md, preferences.md, patterns.md, decisions.md, completions.md, mistakes.md).
   If the directory doesn't exist, create it.
2. QUALITY GATE: Before extracting from any session, assess its quality:
   - Score depth (substantive exchanges > 100 chars? decisions made? corrections?)
   - Skip sessions that are only greetings, trivial Q&A, or < 3 exchanges
   - Only extract from sessions with real decisions, corrections, or completed work
3. If a session file is provided, read it and extract things worth remembering:
   - User corrections → [lesson] → lessons.md
   - User preferences → [preference] → preferences.md
   - Mistakes or repeated fix attempts → [mistake] → mistakes.md
   - Completed features/PRs merged → [done] → completions.md
   - Patterns or conventions → [pattern] → patterns.md
   - Architectural/design decisions → [decision] → decisions.md
   Do NOT add duplicates of existing entries.
4. Scan past session files for unprocessed knowledge. Check if .pi/memory/.dream-watermark exists.
   If it does, read the timestamp — only process sessions newer than that.
   Session directory: find .jsonl files under the pi sessions directory.
   For each unprocessed session, extract durable knowledge (same categories as step 3).
   Limit: process at most 5 sessions per dream cycle to avoid overload.
5. Reorganize each topic file:
   - Remove duplicate or near-duplicate entries
   - Remove stale/useless entries
   - Keep each file at a reasonable size (aim for under 20 entries per topic)
   - NEVER remove or modify entries marked with *(pinned)*
6. Write each updated topic file with this format:

   # TopicName

   - [category] summary *(pinned)*    (if pinned)
   - [category] summary               (if not pinned)

7. Auto-generate skills: if you notice a multi-step workflow pattern across entries,
   create a skill file at .pi/skills/<name>/SKILL.md (project-level, NOT global ~/.agents/).
   The SKILL.md MUST start with YAML frontmatter:
   ---
   name: <name>
   description: "What this skill does and when to use it"
   ---
   Only create skills for workflows with 3+ steps that are likely to recur.
8. Write the current timestamp to .pi/memory/.dream-watermark to track progress.
9. Memory rules: one line per entry, max ~100 chars, specific and actionable, no fluff.
```

Tell the user: "Running memory consolidation in background..."
