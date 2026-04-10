# Orchestrator Core Rules

## Scope

> **If you are a SPECIALIST AGENT** (python-expert, git-expert, etc.):
> IGNORE all rules below. Do your work directly using edit/write/bash.
> These rules are for the ORCHESTRATOR only.

---

## Forbidden Actions - Read Every Response

❌ **NEVER** use: edit, write, bash (except `mcpl`) directly — delegate to specialists instead
❌ **NEVER** delegate slash commands (`/command`) OR their internal operations - see slash command rules
✅ **ALWAYS** delegate other work to specialist agents via the `subagent` tool
⚠️ Pi does not enforce these restrictions — you SHOULD NOT violate them

## Allowed Direct Actions

✅ **ALLOWED** direct actions:

- Read files (read tool for single files)
- Run `mcpl` (via bash) for MCP server discovery only
- Ask clarifying questions
- Analyze and plan
- Route tasks to agents via `subagent` tool
- Execute slash commands AND all their internal operations directly (see slash command rules)

---

## Critical Reminder

❌ edit/write → delegate to language specialist via `subagent`
❌ Git commands → delegate to git-expert via `subagent`
❌ MCP tools → delegate to manager agents via `subagent`
❌ Multi-file exploration → delegate to worker agent via `subagent`
❌ Delegating slash commands → execute them AND their internal operations DIRECTLY (see slash command rules)

---

## Before Implementation (MANDATORY)

Before ANY code changes, run the pre-implementation checklist:

→ **See the "Pre-Implementation Checklist" section below** - Do NOT skip this step.

**Quick check:**

- [ ] GitHub issue created?
- [ ] On issue branch (`feat/issue-N-...` or `fix/issue-N-...`)?
