# Task Tracking (MANDATORY)

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

---

## When to Create Tasks

**BEFORE starting any multi-step workflow (3+ steps)**, use `TaskCreate` to list ALL steps first.

**Use tasks for:**

- Feature implementation (investigate → issue → branch → implement → review → commit → push → PR)
- Bug fixes with multiple files or steps
- Any workflow from `rules/05-issue-first-workflow.md` or `rules/20-code-review-loop.md`
- Refactoring across multiple files
- Any work the user requests that involves more than 2 actions

**Skip tasks for:**

- Single-step actions (one edit, one command)
- Questions or explanations (no code changes)
- `/btw` side questions
- Trivial fixes (typos, single-line changes)

---

## Task Granularity

Tasks MUST be **detailed and specific** — not high-level summaries.

❌ **BAD** (too vague):

```text
- Implement the fix
- Review code
- Create PR
```

✅ **GOOD** (specific and actionable):

```text
- Investigate root cause in extensions/orchestrator/utils.ts
- Create GitHub issue with root cause analysis
- Create branch fix/issue-N-description from origin/main
- Edit extensions/orchestrator/utils.ts — add timeout parameter to fetchData()
- Run code review loop (3 async reviewers)
- Fix review findings (if any)
- Run test-automator
- Commit changes (git add specific files, commit with message)
- Push branch to origin
- Create PR with description
```

---

## Task Lifecycle (MANDATORY)

1. **Create all tasks BEFORE starting work** — use `TaskCreate` for each step
2. **Mark `in_progress`** via `TaskUpdate` BEFORE starting each task
3. **Mark `completed`** via `TaskUpdate` IMMEDIATELY after finishing each task
4. **Do NOT skip tasks** — work through them in order
5. **Do NOT start new work** while unchecked tasks exist (unless user explicitly pivots)

---

## Side Questions During Workflow

When the user asks a side question while tasks are active:

1. Answer the question
2. **Resume the next unchecked task immediately** — the task list tells you exactly where you left off

This is the entire point of task tracking — you cannot "forget" what you were doing because the tasks are persistent and injected into every turn.

---

## Integration with Existing Rules

Task tracking works alongside — not instead of — existing workflow rules:

- **Issue-first workflow** (`05-issue-first-workflow.md`): Create tasks for the full issue workflow
- **Code review loop** (`20-code-review-loop.md`): Include review steps as individual tasks
- **Documentation updates** (`25-documentation-updates.md`): Include doc updates as tasks when applicable

---

## Key Rules

- **Tasks are code-enforced** — the extension injects reminders if you ignore tasks for 4+ turns
- **Never abandon tasks** — if scope changes, use `TaskUpdate` with `status: "deleted"` to remove obsolete tasks
- **The task list is your contract** — complete every task or explicitly remove it

---

## Async Agent taskId (MANDATORY — code-enforced)

**Every async agent call MUST include `taskId`.** This is enforced by the subagent tool —
calls without `taskId` are rejected.

- If the agent is working on a task: pass the task ID (e.g., `taskId: "5"`)
- If the agent is NOT linked to any task: pass `taskId: "-1"`

When `taskId` is a real task ID, the task auto-completes when the agent finishes successfully.
No manual `TaskUpdate` needed — the system handles it.

```text
# Async agent linked to task 5 — auto-completes on success
subagent(agent="code-reviewer-quality", task="...", cwd="...", async=true, name="Review Quality", taskId="5")

# Async agent NOT linked to any task
subagent(agent="worker", task="...", cwd="...", async=true, name="Qodo Poll", taskId="-1")

# Parallel async agents linked to tasks
subagent(tasks=[
  {agent: "code-reviewer-quality", task: "...", cwd: "...", name: "Review Quality", taskId: "5"},
  {agent: "code-reviewer-guidelines", task: "...", cwd: "...", name: "Review Guidelines", taskId: "6"},
  {agent: "code-reviewer-security", task: "...", cwd: "...", name: "Review Security", taskId: "7"},
])
```

**Rules:**

- ✅ **ALWAYS** pass `taskId` — the tool rejects async calls without it
- ✅ Pass `"-1"` when the agent is not linked to any task
- ✅ The task auto-completes on success, stays `in_progress` on failure
- ❌ **NEVER** manually `TaskUpdate` a task to `completed` if it has an async agent — the agent handles it
- ❌ **NEVER** omit `taskId` — the call will fail with a clear error
