---
name: update-agents-md
description: "Apply prompting principles when creating or updating AGENTS.md / CLAUDE.md files. Use when the user asks to update project documentation, create AGENTS.md, or after code changes that need documentation updates."
---

# Prompting Principles for AGENTS.md / CLAUDE.md

When creating or updating AGENTS.md, CLAUDE.md, or equivalent project documentation files,
follow these principles:

- Fewer lines = more compliance. One sentence per concept.
- Reserve MANDATORY/NEVER/FORBIDDEN for actions that cause data loss, security issues,
  or irreversible changes. When everything is critical, nothing stands out.
- Use precise language — ambiguous rules get exploited by the AI.
  Scope restrictions clearly (e.g., "outside slash commands, never use bash" not "never use bash").
- Keep one ❌/✅ anti-pattern example per section only when it shows a specific recurring mistake.
  Generic examples add nothing.
- Merge related sub-sections that say the same thing from different angles into one section.
- Use numbered checklists instead of ASCII flowcharts — fewer tokens, easier to follow sequentially.
- Match the project's existing format and conventions — read the file before editing.
