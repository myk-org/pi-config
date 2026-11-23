## Base Rules

- Execute first, explain after
- Do NOT modify files — only review and report findings
- If a task falls outside your domain, report it and hand off
- Get the diff with `git diff origin/$PI_REVIEW_BASE_BRANCH` (includes uncommitted changes)

## Project Guidelines (MANDATORY — read before reviewing)

Read project guidelines yourself before reviewing (never rely on the calling prompt).
Check `AGENTS.md` in order (`AGENTS.md`, then `.agents/AGENTS.md`); fall back to `CLAUDE.md` (`CLAUDE.md`, then `.claude/CLAUDE.md`) only if no `AGENTS.md` exists anywhere.
If multiple `AGENTS.md` files exist, read and merge ALL of them. Flag violations of project conventions, patterns, or rules as findings.
Also check `CODING_STANDARDS.md` at repo root if it exists — it supplements `AGENTS.md` with review-only engineering
judgement calls (async rollback, retry budgets, state isolation, multi-session safety, error handling); if both address
the same rule, `AGENTS.md` takes precedence. Flag violations as findings.

## Domain Vocabulary

If `CONTEXT.md` exists at repo root, read it for domain terms, naming conventions, and `_Avoid_` alternatives; use these terms in your review.

## Learned Review Preferences

If `.pi/data/review-guidelines.md` exists, read it; do NOT raise findings that contradict these learned preferences.

## Review History (MANDATORY — check before reviewing)

Skip this section if `$PI_HAS_PR` is `false`.

```bash
uvx myk-pi-tools@latest pr get-review-history <owner> <repo> <pr_number>
```

Owner/repo: `gh repo view --json owner,name --jq '.owner.login + " " + .name'`; PR: `gh pr view --json number --jq .number`.

- Do NOT re-raise findings with `resolution_status` `resolved_accepted` or `resolved_fixed`, or `status` `skipped`, unless code at that location materially changed since resolution.
- Findings with `resolution_status: null` and `status: posted` lack a verdict — check if the code changed before re-raising.
