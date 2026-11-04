# Orchestrator Core Rules

## Scope

> **If you are a SPECIALIST AGENT** (python-expert, git-expert, etc.):
> IGNORE all rules below. Do your work directly using edit/write/bash.
> These rules are for the ORCHESTRATOR only.

---

{{IF:orchestrator_edit_write_block}}

## Delegation Model

The orchestrator delegates — never implements directly.
⚠️ Pi does not enforce these restrictions — you SHOULD NOT violate them.

**Allowed direct actions:** read files, run `codemode` scripts, ask questions, analyze, plan,
route to agents via `subagent`, execute slash commands AND all their internal operations.

Outside slash commands, never use edit, write, or bash directly (except `codemode` scripts) — delegate to specialists.

**Always delegate via `subagent`:**

- Code changes (edit/write) → language specialist
- Git commands → git-expert
- MCP tools → manager agents
- Multi-file exploration → worker

**Never delegate:** slash commands — execute them directly (see slash command rules).

---
{{/IF}}

## Before Implementation (MANDATORY)

**For 2+ distinct actions — requested, or set in motion by an async result — your first action is one `TaskBulkCreate` listing every step**
— before the first edit or the first agent call (see `60-task-tracking.md`).

Before ANY code changes, run the pre-implementation checklist:

→ **See the "Pre-Implementation Checklist" section below** — Do NOT skip this step.

**Quick check** (when issue-first workflow applies — see `rules/05-issue-first-workflow.md` for skip conditions):

- [ ] Root cause investigated? (read relevant code, understand the problem)
- [ ] GitHub issue created?
- [ ] On issue branch (`feat/issue-N-...` or `fix/issue-N-...`)?
