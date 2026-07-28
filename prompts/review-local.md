---
description: Review uncommitted changes or changes compared to a branch
argument-hint: "[base branch]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# Local Code Review Command

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Review uncommitted changes or changes compared to a specified branch.

## Usage

- `/review-local` - Review uncommitted changes (staged + unstaged)
- `/review-local main` - Review changes compared to main branch
- `/review-local feature/branch` - Review changes compared to specified branch

## Task Plan

Before starting any work, create ALL tasks upfront using `TaskCreate`, then set their dependencies
using `TaskUpdate` with `addBlockedBy`. The task system enforces execution order — blocked tasks cannot start.

### Task List

| Task | Title | blockedBy |
|------|-------|-----------|
| 1 | Get diff | — |
| 2 | Review — Code Quality | 1 |
| 3 | Review — Guidelines | 1 |
| 4 | Review — Security | 1 |
| 5 | Review — Docs | 1 |
| 6 | Review — Spec | 1 |
| 7 | Merge & deduplicate findings | 2, 3, 4, 5, 6 |
| 8 | Present review | 7 |

### Dependency Graph

```text
Task 1 (Get diff)
 ├── Task 2 (Review: Code Quality)  ──┐
 ├── Task 3 (Review: Guidelines)    ──┤
 ├── Task 4 (Review: Security)      ──┤
 ├── Task 5 (Review: Docs)          ──┤
 └── Task 6 (Review: Spec)          ──┤
                                       ▼
                            Task 7 (Merge findings)
                                       │
                            Task 8 (Present review)
```

Create all 8 tasks using `TaskCreate` NOW, before starting any work.
Then IMMEDIATELY set dependencies using `TaskUpdate` with `addBlockedBy` for each task per the table above.

`TaskCreate` does NOT accept `addBlockedBy` — dependencies MUST be set via `TaskUpdate` after creation.

Example two-step flow:

```text
# Step 1: Create all tasks
TaskCreate(subject="Get diff", ...)                    → Task 1
TaskCreate(subject="Review — Code Quality", ...)       → Task 2
TaskCreate(subject="Review — Guidelines", ...)         → Task 3
TaskCreate(subject="Review — Security", ...)           → Task 4
TaskCreate(subject="Review — Docs", ...)               → Task 5
TaskCreate(subject="Review — Spec", ...)               → Task 6
TaskCreate(subject="Merge & deduplicate findings", ...)→ Task 7
TaskCreate(subject="Present review", ...)              → Task 8

# Step 2: Set dependencies
TaskUpdate(taskId="2", addBlockedBy=["1"])
TaskUpdate(taskId="3", addBlockedBy=["1"])
TaskUpdate(taskId="4", addBlockedBy=["1"])
TaskUpdate(taskId="5", addBlockedBy=["1"])
TaskUpdate(taskId="6", addBlockedBy=["1"])
TaskUpdate(taskId="7", addBlockedBy=["2", "3", "4", "5", "6"])
TaskUpdate(taskId="8", addBlockedBy=["7"])
```

> 🚨 **HARD RULE: NEVER start a task while its `blockedBy` tasks are incomplete.**
> The task system enforces this via `addBlockedBy` — but even if you could bypass it, **DON'T**.
> Merging findings from partial reviewer results is a **CRITICAL violation**.
> ALL 5 reviewers (Tasks 2, 3, 4, 5, 6) MUST complete before merging findings (Task 7).

## Workflow

### Phase 1: Get Diff — Task 1

**If the raw arguments are not empty:**

Compare current branch against the specified branch:

```bash
git diff "<raw_arguments>"...HEAD
```

**If no argument provided:**

Get all uncommitted changes (staged + unstaged):

```bash
git diff HEAD
```

### Phase 2: Code Analysis — Tasks 2, 3, 4, 5, 6

Spawn ALL 5 review agents as async subagents
with `taskId` linking each to its task.
Use the actual task IDs returned by `TaskCreate` — do NOT hardcode IDs.

```text
subagent(tasks=[
  {agent: "code-reviewer-quality", task: "Review diff for code quality...", cwd: "...", name: "Review Quality", taskId: "<actual task 2 ID>"},
  {agent: "code-reviewer-guidelines", task: "Review diff for guidelines...", cwd: "...", name: "Review Guidelines", taskId: "<actual task 3 ID>"},
  {agent: "code-reviewer-security", task: "Review diff for security...", cwd: "...", name: "Review Security", taskId: "<actual task 4 ID>"},
  {agent: "code-reviewer-docs", task: "Review diff for documentation quality...", cwd: "...", name: "Review Docs", taskId: "<actual task 5 ID>"},
  {agent: "code-reviewer-spec", task: "Review diff for spec compliance...", cwd: "...", name: "Review Spec", taskId: "<actual task 6 ID>"},
])
```

Provide each agent with the diff content from Phase 1 and ask them to analyze for:

1. Code quality and best practices
2. Potential bugs or logic errors
3. Security vulnerabilities
4. Performance issues
5. Naming conventions and readability
6. Missing error handling
7. Code duplication
8. Suggestions for improvement

**After spawning, verify the response confirms all 5 agents were spawned.**
If any spawn fails, STOP and report the error — do NOT continue waiting.

**After spawning, your turn is DONE.** Do NOT poll, sleep, call TaskOutput,
or check status. Results arrive automatically as follow-up messages.
When each reviewer finishes, its task is auto-completed via `taskId`.
Task 7 (Merge findings) auto-unblocks when all 5 reviewer tasks complete.

### Phase 3: Merge & Deduplicate Findings — Task 7

Merge and deduplicate the findings from all 5 reviewers into a single combined findings list.

### Phase 4: Present Review — Task 8

Display findings grouped by severity:

- **Critical issues** (must fix)
- **Warnings** (should fix)
- **Suggestions** (nice to have)
