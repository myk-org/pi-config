# Issue-First Workflow

## Pre-Implementation Checklist (START HERE)

1. **Skip?** (see "When This Workflow Applies" below) → YES: do directly; NO: continue.
2. **Root cause investigated?** Read relevant source files/functions/lines, verify the problem exists, and have a conceptual fix (or link an existing fix PR instead of
   duplicating). Clarify misunderstandings first.
3. **GitHub issue created?** NO → create via `github-expert` (never create blind TODO issues without root cause analysis).
4. **On correct branch?** (`<type>/issue-<N>-<short-desc>` from `origin/main` via `git-expert`) → NO: wait for confirmation, then create branch.
5. **User confirmed "work on it now"?** Ask explicitly after presenting issue number, title, and URL before creating the branch or implementing.

## When This Workflow Applies

- **USE for:** new features, enhancements, bug fixes requiring code changes, refactoring, multi-file edits, tracked work.
- **SKIP for:** trivial fixes (typos/single-line), questions/exploration (no code edits), user says "just do it" / "quick fix", urgent hotfixes (note in commit message).
- **Edge cases:** partial requirements → ask clarifying questions first; issue exists → ask to continue it; multiple unrelated requests → separate issues.

## Branch & Issue Format

- **Branch workflow:** after user confirms, delegate to `git-expert`: `git fetch origin main` and `git checkout -b <type>/issue-<N>-<short-desc> origin/main` (`feat/`,
  `fix/`, `refactor/`, `docs/`).
- **Issue format (`github-expert`):** include type, problem description, root cause analysis (files, functions, lines, why), proposed approach, requirements, and a `##
  Done` checklist (`- [ ] Deliverable ...`).

## Tracking Progress & Completion

Check off deliverables as completed; each deliverable follows `rules/20-code-review-loop.md`. Once all `## Done` boxes are checked (mark N/A or remove obsolete ones first
— 🚨 **NEVER close an issue with unchecked deliverables**) and reviews/tests pass, close with a summary comment.
