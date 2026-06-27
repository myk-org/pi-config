# Issue-First Workflow

## Scope

> **If you are a SPECIALIST AGENT:**
> IGNORE this rule. This is for the ORCHESTRATOR only.

---

## Pre-Implementation Checklist (START HERE)

Before ANY code changes, complete this checklist:

1. **Should this workflow be skipped?** (see "SKIP" list below)
   - YES → Do directly, skip remaining steps
   - NO → Continue checklist

2. **Root cause investigated?**
   - Read the relevant source code — identify files, functions, and lines involved
   - Understand the current behavior and why it happens
   - Know what the fix looks like (at least conceptually)
   - If the user's request is based on a misunderstanding, clarify before proceeding
   - NO → Investigate first.
   - YES → Continue

3. **GitHub issue created?**
   - NO → Create issue first (delegate to `github-expert`)
   - YES → Continue

4. **On correct branch?** (`feat/issue-N-...` or `fix/issue-N-...`)
   - NO → Create branch from origin/main (delegate to `git-expert`)
   - YES → Continue

5. **User confirmed "work on it now"?**
   - NO → Ask user
   - YES → Proceed with implementation

🚨 **NEVER create issues blindly from user requests.** Before creating ANY issue:

- Read and understand the relevant code
- Verify the problem exists (don't take the user's word — check the code)
- Know what files/functions are involved
- Have a conceptual fix in mind
- If a fix PR already exists, link to it instead of creating a duplicate issue

An issue without root cause analysis is a TODO, not a useful issue.

---

## When This Workflow Applies

**USE for:**

- New features, enhancements, bug fixes requiring code changes
- Refactoring tasks
- Multi-file modifications
- Tasks benefiting from tracking/documentation

**SKIP for:**

- Trivial fixes (typos, single-line changes)
- Questions, explanations, exploration (no code changes)
- User says "just do it" / "quick fix"
- Urgent hotfixes with time pressure

---

## Branch Workflow

When user confirms, **delegate to git-expert**: fetch main (`git fetch origin main`), create branch (`git checkout -b <type>/issue-<N>-<short-desc> origin/main`).

Branch types: `feat/`, `fix/`, `refactor/`, `docs/` — always prefixed with `issue-<N>-`.

After creating the issue, present the issue number, title, and URL, then ask:
'Do you want to work on it now?' Wait for explicit confirmation before creating the branch or starting implementation.

---

## Issue Format

Delegate to `github-expert` with: type (fix/feat/refactor/docs), problem description, root cause analysis (affected files, functions, why), proposed fix, and requirements.

**Every issue MUST include a `## Done` section with checkboxes** — the contract for when the issue can be closed:

```markdown
## Done

- [ ] Deliverable 1
- [ ] Deliverable 2
- [ ] Deliverable 3
```

---

## Tracking Progress

Check off deliverables in the issue as you complete them.
All code changes go through the review loop (see `rules/20-code-review-loop.md`).
When all deliverables are complete, verify all `## Done` checkboxes are checked, ensure reviews/tests pass, then close with a summary comment.
🚨 **NEVER close an issue with unchecked deliverables** — remove or mark N/A first if no longer needed.

---

## Integration with Code Review Loop

Each deliverable follows the code review loop defined in `rules/20-code-review-loop.md`; once all deliverables pass review, close the issue.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| User says "just fix it" | Skip workflow, do directly |
| Partial requirements | Ask clarifying questions, then create issue |
| Issue already exists | Ask to continue existing issue |
| Urgent/hotfix | Skip workflow, note in commit message |
| Multiple unrelated requests | Create separate issues for each |
