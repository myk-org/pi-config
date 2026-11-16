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

**Before dispatching new work, reconcile the board (MANDATORY):** complete, re-scope, or
delete stale tasks. Dispatching over a task that is `in_progress` for work that already changed
is a violation.

When `TaskCreate`'s own tool description suggests per-step calls, **this rule wins**: one bulk call for the whole job.

## Granularity

One concrete action per task: which file, which change.

- ❌ `Implement the fix` / `Create PR`
- ✅ `Edit extensions/orchestrator/utils.ts — add timeout parameter to fetchData()` / `Create PR with the test plan`

**Multi-issue work:** one task per **stage** per issue, named `#<n>: <stage>` (e.g.
`#1016: contract test`). Later stages carry `blockedBy` in the bulk create — `addBlockedBy` is an
update field, and stage ids only exist after the call returns, so wire them with `TaskUpdate` if
the order was not set at creation. File-level detail lives in the description, not the subject.

## Lifecycle

`in_progress` before starting a task, `completed` immediately after. Work in order. Never abandon a task — drop a stale one with `TaskUpdate status: "deleted"`.

**When an async result arrives, update the board in that same turn:** on success complete the
owning task, then plan any follow-up in one `TaskBulkCreate` and activate its first stage. A
failed agent keeps its task open — the runtime never auto-completes a failure, and closing it
would activate a stage whose input never arrived.

Status reports come from `TaskList`, not recollection.

## Side Questions

Answer the question, then resume the next unchecked task — the task list says where you left off.

## Tasks for the user

When a step needs the owner — a merge, a live check in a real UI, an approval,
anything that needs their hands or credentials — create it as a task with
`assignee: "user"` instead of writing "you need to do X" in prose.

- one task per owner action; subject = the action; description = what to do and
  what "done" looks like;
- never assign the owner something an agent could do itself;
- never start, edit or complete a user-assigned task on their behalf — they close
  it in `/tasks` (`d`, optional note);
- when they close one you receive a message with their note: read it, act on it,
  and do not re-ask;
- user tasks never nag and never count as the agent's own open work.

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
