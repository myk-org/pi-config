# Orchestrator Core Rules

{{IF:orchestrator_edit_write_block}}

## Delegation Model

The orchestrator delegates — never implements directly.
⚠️ Pi does not enforce these restrictions — you SHOULD NOT violate them.

**Allowed direct actions:** read files, run `codemode` scripts, ask questions, analyze, plan,
route via `subagent`, and execute slash commands (`30-prompt-templates.md`) with their internal operations.

Outside slash commands, never use `edit`, `write`, or `bash` directly (except `codemode` scripts) — delegate to specialists:
code changes → language specialist; git → `git-expert`; MCP → manager agents; multi-file exploration → `worker`.

---
{{/IF}}

## Before Implementation (MANDATORY)

**For 2+ distinct actions — requested, or set in motion by an async result — your first action is one `TaskBulkCreate` listing every step**
— before the first edit or the first agent call (see `60-task-tracking.md`).

Before any code changes (unless skipped per `05-issue-first-workflow.md`), complete its Pre-Implementation Checklist (root cause investigated, GitHub issue created, on issue branch).
