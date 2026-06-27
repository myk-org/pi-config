# Task Tracking (MANDATORY)

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

---

## When to Create Tasks

**BEFORE starting any multi-step workflow (3+ steps)**, use `TaskCreate` to list ALL steps first.

**Use tasks for:** feature implementation, bug fixes with multiple files,
workflows from `rules/05-issue-first-workflow.md` or `rules/20-code-review-loop.md`,
multi-file refactoring, or any work involving more than 2 actions.

**Skip tasks for:** single-step actions, questions/explanations, `/btw` side questions, or trivial fixes.

---

## Task Granularity

Tasks MUST be **detailed and specific** — not high-level summaries.

- ❌ BAD: `Implement the fix` / `Review code` / `Create PR`
- ✅ GOOD: `Edit extensions/orchestrator/utils.ts — add timeout parameter to fetchData()` / `Run code review loop (3 async reviewers)` / `Create PR with description`

---

## Task Lifecycle (MANDATORY)

Create all tasks BEFORE starting work via `TaskCreate`.
Mark each `in_progress` before starting and `completed` immediately after finishing via `TaskUpdate`.
Work through tasks in order — do not skip tasks or start new work while unchecked tasks exist (unless user explicitly pivots).

---

## Side Questions

Answer the question, then resume the next unchecked task immediately — the persistent task list tells you exactly where you left off.

---

## Integration & Key Rules

Task tracking works alongside existing workflow rules — include issue-first, code review, and documentation steps as individual tasks.
Tasks are code-enforced (reminders after 4+ ignored turns).
Never abandon tasks — if scope changes, use `TaskUpdate` with `status: "deleted"` to remove obsolete tasks; the task list is your contract.

---

## Async Agent taskId (MANDATORY — code-enforced)

**Every async agent call MUST include `taskId`.** Enforced — calls without it are rejected.
Pass the task ID (e.g., `"5"`) when linked to a task, or `"-1"` when not.
Linked tasks auto-complete on agent success — no manual `TaskUpdate` needed.

```text
subagent(agent="code-reviewer-quality", task="...", cwd="...", async=true, name="Review", taskId="5")
subagent(agent="worker", task="...", cwd="...", async=true, name="Qodo Poll", taskId="-1")
```

- ✅ **ALWAYS** pass `taskId` — auto-completes on success, stays `in_progress` on failure
- ❌ **NEVER** manually `TaskUpdate` a task to `completed` if it has an async agent
- ❌ **NEVER** omit `taskId` — the call will fail
