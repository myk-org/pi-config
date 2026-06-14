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
| 5 | Merge & deduplicate findings | 2, 3, 4 |
| 6 | Present review | 5 |

### Dependency Graph

```text
Task 1 (Get diff)
 ├── Task 2 (Review: Code Quality)  ──┐
 ├── Task 3 (Review: Guidelines)    ──┤
 └── Task 4 (Review: Security)      ──┤
                                       ▼
                            Task 5 (Merge findings)
                                       │
                            Task 6 (Present review)
```

Create all 6 tasks using `TaskCreate` NOW, before starting any work.
Then IMMEDIATELY set dependencies using `TaskUpdate` with `addBlockedBy` for each task per the table above.

`TaskCreate` does NOT accept `addBlockedBy` — dependencies MUST be set via `TaskUpdate` after creation.

Example two-step flow:

```text
# Step 1: Create all tasks
TaskCreate(subject="Get diff", ...)                    → Task 1
TaskCreate(subject="Review — Code Quality", ...)       → Task 2
TaskCreate(subject="Review — Guidelines", ...)         → Task 3
TaskCreate(subject="Review — Security", ...)           → Task 4
TaskCreate(subject="Merge & deduplicate findings", ...)→ Task 5
TaskCreate(subject="Present review", ...)              → Task 6

# Step 2: Set dependencies
TaskUpdate(taskId="2", addBlockedBy=["1"])
TaskUpdate(taskId="3", addBlockedBy=["1"])
TaskUpdate(taskId="4", addBlockedBy=["1"])
TaskUpdate(taskId="5", addBlockedBy=["2", "3", "4"])
TaskUpdate(taskId="6", addBlockedBy=["5"])
```

> 🚨 **HARD RULE: NEVER start a task while its `blockedBy` tasks are incomplete.**
> The task system enforces this via `addBlockedBy` — but even if you could bypass it, **DON'T**.
> Merging findings from partial reviewer results is a **CRITICAL violation**.
> ALL 3 reviewers (Tasks 2, 3, 4) MUST complete before merging findings (Task 5).

## Workflow

### Phase 1: Get Diff — Task 1

Mark Task 1 as `in_progress`.

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

Mark Task 1 as `completed`.

### Phase 2: Code Analysis — Tasks 2, 3, 4

Mark Tasks 2, 3, 4 as `in_progress`, then spawn ALL 3 review agents as async subagents
with `taskId` linking each to its task.
Use the actual task IDs returned by `TaskCreate` — do NOT hardcode IDs.

```text
subagent(tasks=[
  {agent: "code-reviewer-quality", task: "Review diff for code quality...", cwd: "...", name: "Review Quality", taskId: "<actual task 2 ID>"},
  {agent: "code-reviewer-guidelines", task: "Review diff for guidelines...", cwd: "...", name: "Review Guidelines", taskId: "<actual task 3 ID>"},
  {agent: "code-reviewer-security", task: "Review diff for security...", cwd: "...", name: "Review Security", taskId: "<actual task 4 ID>"},
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

**After spawning, verify the response confirms all 3 agents were spawned.**
If any spawn fails, STOP and report the error — do NOT continue waiting.

**After spawning, your turn is DONE.** Do NOT poll, sleep, call TaskOutput,
or check status. Results arrive automatically as follow-up messages.
When each reviewer finishes, its task is auto-completed via `taskId`.
Task 5 (Merge findings) auto-unblocks when all 3 reviewer tasks complete.

### Phase 3: Merge & Deduplicate Findings — Task 5

Mark Task 5 as `in_progress`.

Merge and deduplicate the findings from all 3 reviewers into a single combined findings list.

Mark Task 5 as `completed`.

### Phase 4: Present Review — Task 6

Mark Task 6 as `in_progress`.

Display findings grouped by severity:

- **Critical issues** (must fix)
- **Warnings** (should fix)
- **Suggestions** (nice to have)

Mark Task 6 as `completed`.
