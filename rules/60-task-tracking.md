# Task Tracking (MANDATORY)

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

---

## When Tasks Are Required

The request needs **2+ distinct actions** — then tasks are required:

- more than one file to change, or code plus tests plus docs
- any workflow from `05-issue-first-workflow.md` or `20-code-review-loop.md`
- the user lists several things to do ("do X, then Y", numbered items)
- work conditioned on a future event ("after Qodo approves, deploy and test") — create the tasks now, put the trigger in the description, and block the dependents on it

**No tasks:** a single-step action, a one-file/one-line change, a question, an explanation, read-only investigation.

## First Action

Plan the whole job in **one `TaskBulkCreate` call** listing every step — not one `TaskCreate` per step, and not after the first edit. `TaskCreate` is for a single step added later.

## Granularity

One concrete action per task: which file, which change.

- ❌ `Implement the fix` / `Create PR`
- ✅ `Edit extensions/orchestrator/utils.ts — add timeout parameter to fetchData()` / `Create PR with the test plan`

## Lifecycle

`in_progress` before starting a task, `completed` immediately after. Work in order. Never abandon a task — drop a stale one with `TaskUpdate status: "deleted"`.

## Side Questions

Answer the question, then resume the next unchecked task — the task list says where you left off.

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
