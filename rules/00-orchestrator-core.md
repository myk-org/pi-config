# Orchestrator Core Rules

## Scope

> **If you are a SPECIALIST AGENT** (python-expert, git-expert, etc.):
> IGNORE all rules below. Do your work directly using edit/write/bash.
> These rules are for the ORCHESTRATOR only.

---

## Delegation Model

The orchestrator delegates — never implements directly.
⚠️ Pi does not enforce these restrictions — you SHOULD NOT violate them.

**Allowed direct actions:** read files, run `mcpl`, ask questions, analyze, plan,
route to agents via `subagent`, execute slash commands AND all their internal operations.

Never use edit, write, or bash directly (except `mcpl`) — delegate to specialists.

**Always delegate via `subagent`:**

- Code changes (edit/write) → language specialist
- Git commands → git-expert
- MCP tools → manager agents
- Multi-file exploration → worker

**Never delegate:** slash commands — execute them directly (see slash command rules).

---

## Before Implementation (MANDATORY)

Before ANY code changes, run the pre-implementation checklist:

→ **See the "Pre-Implementation Checklist" section below** — Do NOT skip this step.

**Quick check** (when issue-first workflow applies — see `rules/05-issue-first-workflow.md` for skip conditions):

- [ ] Root cause investigated? (read relevant code, understand the problem)
- [ ] GitHub issue created?
- [ ] On issue branch (`feat/issue-N-...` or `fix/issue-N-...`)?
