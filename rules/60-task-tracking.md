# Task Tracking (MANDATORY)

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

---

## When Tasks Are Required

The request — **or work any step sets in motion** — needs **2+ distinct actions** — then tasks are required:

- more than one file to change, or code plus tests plus docs
- any workflow from `05-issue-first-workflow.md` or `20-code-review-loop.md`
- the user lists several things to do ("do X, then Y", numbered items)
- work conditioned on a future event ("after Qodo approves, deploy and test") — create the tasks now, put the trigger in the description, and block the dependents on it
- an async result comes back with follow-up work — reacting only to finished agents still needs a board

**No tasks:** a single-step action, a one-file/one-line change, a question, an explanation, read-only investigation.

## First Action

Plan the whole job in **one `TaskBulkCreate` call** listing every step — not one `TaskCreate` per step, and not after the first edit. `TaskCreate` is for a single step added later.

Before dispatching new work, reconcile the board: complete, re-scope, or delete stale tasks.

When `TaskCreate`'s own tool description suggests per-step calls, **this rule wins**: one bulk call for the whole job.

## Granularity

One concrete action per task: which file, which change.

- ❌ `Implement the fix` / `Create PR`
- ✅ `Edit extensions/orchestrator/utils.ts — add timeout parameter to fetchData()` / `Create PR with the test plan`

**Multi-issue work:** one task per **stage** per issue, named `#<n>: <stage>` (e.g.
`#1016: contract test`), later stages carry `addBlockedBy` on earlier ones. File-level detail
lives in the description, not the subject.

## Lifecycle

`in_progress` before starting a task, `completed` immediately after. Work in order. Never abandon a task — drop a stale one with `TaskUpdate status: "deleted"`.

**When an async result arrives, update the board in that same turn:** complete the owning
task, then create or activate the next stage if it is not already there.

Status reports come from `TaskList`, not recollection.

## Side Questions

Answer the question, then resume the next unchecked task — the task list says where you left off.

---

## Async Agent taskId (MANDATORY — code-enforced)

**Every async agent call MUST include `taskId`.** Enforced — calls without it are rejected.
Pass the id of the task the agent performs (e.g. `"5"`). `"-1"` is only for a single read-only
check that changes nothing: an agent that edits code, pushes, or drives a PR must carry a real
task id, because an unlinked poll is work that never appears on the board.

```text
subagent(agent="code-reviewer-quality", task="...", cwd="...", async=true, name="Review", taskId="5")
subagent(agent="worker", task="...", cwd="...", async=true, name="Read one file", taskId="-1")
```

**Stage tasks are yours to close.** An agent links to the narrow task it performs; the stage
completes when the stage's acceptance holds — binding a stage to a poll marks it done when
only the poll finished.

- ❌ **NEVER** let a narrow agent task stand in for a stage — auto-complete ends the task the agent was linked to
- ❌ **NEVER** omit `taskId` — the call will fail
