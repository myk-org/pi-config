---
name: update-agents-md
description: "Create or update AGENTS.md / CLAUDE.md using industry best practices. Use when the user asks to create AGENTS.md, update project documentation, or after code changes that need documentation updates."
---

# AGENTS.md Best Practice Guide

Research-backed guide for creating and updating AGENTS.md files.
Sources: GitHub (2,500-repo analysis), Augment Code (measured eval), Blake Crosley (pattern analysis), agents.md spec.

---

## Mode: Creating New AGENTS.md

1. Scan the repo — identify tech stack, build system, test framework, file structure
   - For monorepos, use subdirectory AGENTS.md files scoped to each package — don't put everything in one root file.
2. Use the **Template** below as starting skeleton
3. Fill in all **Required Sections** in order
4. Verify total is 100-150 lines (hard limit — longer files hurt performance)
5. Move detailed content to referenced files if needed

## Mode: Updating Existing AGENTS.md

1. Read the entire current file first
2. Run the **Audit Checklist** below
3. Fix gaps in priority order — don't rewrite what already works
4. Verify size stays under 150 lines after changes

## Mode: Post-Code-Change Update

1. Check if the change affects: commands, file structure, dependencies, workflows
2. Update only the affected sections — don't touch unrelated content
3. Verify commands in the file still work

---

## Required Sections (in this order)

> Examples below use npm/Node.js — substitute your project's toolchain (pytest, cargo test, go test, etc.).

Order matters — front-load highest-ROI content. Commands FIRST.

### 1. Build & Test Commands (HIGHEST ROI)

```markdown
## Commands
- Build: `npm run build`
- Test: `npm test -- --verbose`
- Lint: `npm run lint --fix`
- Type check: `npx tsc --noEmit`
- Full verify: `npm run lint && npm test && npx tsc --noEmit`
```

Rules:

- Exact invocations with flags — not just tool names
- Include the "full verify" one-liner the agent runs before committing
- Every instruction in the file should answer: "What command proves this was done?"

### 2. Definition of Done

```markdown
## Definition of Done
A task is complete when ALL pass:
1. `npm run lint` exits 0
2. `npm test` exits 0 with no failures
3. `npx tsc --noEmit` exits 0
4. Changed files staged and committed
5. Commit message: `type(scope): description`
```

Rules:

- Specific exit codes, not feelings
- Without this, "done" means "I think I'm done" — the #1 agent failure mode

### 3. Escalation Rules

```markdown
## When Blocked
- Tests fail after 3 attempts → stop, report failing test with full output
- Missing dependency → check requirements first, then ask
- Merge conflicts → stop, show conflicting files
- NEVER: delete files to resolve errors, force push, skip tests
```

Rules:

- Without escalation rules, agents improvise destructively when blocked
- Pair every "never" with what to do instead

### 4. Project Context

```markdown
## Project
- Stack: React 18, TypeScript 5, Vite, Tailwind CSS
- Structure: `src/` (app code), `tests/` (tests), `docs/` (documentation)
- Key deps: react-query for server state, zustand for client state
```

Rules:

- Specific versions and key dependencies
- "React project" is useless — "React 18 with TypeScript, Vite, and Tailwind CSS" works
- File structure with one-line descriptions

### 5. Task-Organized Sections

```markdown
## When Writing Code
- Run `npm run lint` after every file change
- Add type hints to all new functions
- Test: `npm test -- -t "test_<module>"`

## When Reviewing Code
- Check security: `npm audit`
- Verify coverage: `npm test -- --coverage`

## When Releasing
- Update version in `package.json`
- Run full suite: `npm test && npm run lint && npx tsc --noEmit`
- Tag: `git tag -a v<version> -m "Release v<version>"`
```

Rules:

- "When X" sections let agents select relevant instructions by task context
- Flat topic lists force parsing everything regardless of current task
- Task-organized > topic-organized

### 6. Boundaries

```markdown
## Boundaries
- ✅ Always: run tests before commits, follow naming conventions
- ⚠️ Ask first: database schema changes, adding dependencies, modifying CI
- 🚫 Never: commit secrets, edit node_modules/, force push to main
```

Rules:

- Three tiers: always do, ask first, never do
- Pair every "don't" with a "do" — warning-only docs consistently underperform
- 15+ sequential "don'ts" without "dos" cause agent overexploration

---

## Size Budget

| Metric | Target | Why |
|--------|--------|-----|
| Total file | 100-150 lines | Longer files actively hurt (Augment, measured) |
| Per section | Under 50 lines | Context window truncation risk |
| Reference files | 3-10 max | Agent reads 90%+ when referenced from AGENTS.md |

**Progressive disclosure:** Keep main file concise. Push details to referenced files:

```markdown
For detailed API conventions, see `docs/api-conventions.md`.
For migration procedures, see `docs/migrations.md`.
```

**Warning:** A 150-line AGENTS.md on top of 500K of surrounding docs won't save the agent from the docs. Fix the documentation environment, not just the entry point.

---

## Decision Table

When the agent needs to choose what patterns to include:

| If you want to improve... | Use this pattern |
|--------------------------|-----------------|
| Reuse of existing code | 3-10 line examples from actual prod code |
| Following codebase conventions | Decision tables for ambiguous choices |
| Wiring of complex features | Numbered procedural workflows |
| Handling of gotchas | "Don't X" paired with "Do Y instead" |
| Reducing context rot | Progressive disclosure via reference files |

---

## Anti-Patterns (NEVER do these)

| Anti-Pattern | Why it fails | Fix |
|-------------|-------------|-----|
| Prose paragraphs without commands | Agent can't verify compliance | Add the command that proves it |
| "Be careful with X" | Not a constraint — no trigger, no action | "Run `cmd` before X. Abort if Y." |
| Contradictory priorities without ordering | Agent skips verification, rushes to code | Number priorities: P1 > P2 > P3 |
| Style guide without enforcement command | No verification mechanism | Add the lint command that enforces it |
| 15+ "don'ts" without "dos" | Agent overexplores, stays conservative | See Boundaries rules above |
| Architecture overview essays | Agent reads 100K+ tokens of docs | Keep to 2-3 sentences, reference files for details |

---

## Writing Style Rules

- Fewer lines = more compliance. One sentence per concept.
- Reserve MANDATORY/NEVER/FORBIDDEN for data loss, security, or irreversible actions. When everything is critical, nothing stands out.
- Use precise language — ambiguous rules get exploited. Scope restrictions clearly (e.g., 'Outside slash commands, never use bash' not 'never use bash').
- One ❌/✅ example per section only when it shows a specific recurring mistake.
- Merge sub-sections that say the same thing from different angles.
- Numbered checklists over ASCII flowcharts — fewer tokens, easier to follow.
- Match the project's existing format — read the file before editing.

---

## Cross-Tool Compatibility

| Tool | Native file | Reads AGENTS.md? |
|------|------------|-------------------|
| Codex CLI | AGENTS.md | Yes (native) |
| Cursor | `.cursor/rules` | Yes (native) |
| GitHub Copilot | `.github/copilot-instructions.md` | Yes (native) |
| Claude Code | CLAUDE.md | Yes (native + CLAUDE.md) |
| Gemini CLI | GEMINI.md | Configurable |
| Windsurf | `.windsurfrules` | Yes (native) |

**Strategy:** Write AGENTS.md as canonical source. Claude Code reads both AGENTS.md and CLAUDE.md natively — use CLAUDE.md for Claude-specific overrides only.

---

## Starter Template

````markdown
# Project Name

Brief one-line description of the project.

## Commands
- Build: `<build command>`
- Test: `<test command with flags>`
- Lint: `<lint command>`
- Full verify: `<all-in-one verification command>`

## Definition of Done
A task is complete when ALL pass:
1. `<lint>` exits 0
2. `<test>` exits 0
3. `<type check>` exits 0
4. Files committed with message: `type(scope): description`

## When Blocked
- Tests fail after 3 attempts → stop, report with full output
- Missing dependency → check manifest first, then ask
- NEVER: delete files to fix errors, force push, skip tests

## Project
- Stack: <technologies with versions>
- Structure: `src/` (code), `tests/` (tests), `docs/` (docs)

## When Writing Code
- <key convention 1>
- <key convention 2>
- Test: `<how to run relevant tests>`

## When Reviewing Code
- <review checklist item 1>
- <review checklist item 2>

## Boundaries
- ✅ Always: <what to always do>
- ⚠️ Ask first: <what needs approval>
- 🚫 Never: <what to never do>
````

---

## Audit Checklist (for updating existing files)

Run through when reviewing an existing AGENTS.md:

- [ ] Commands section exists and comes FIRST (before any prose)?
- [ ] All commands are exact invocations with flags (not just tool names)?
- [ ] Definition of Done section with specific exit codes?
- [ ] Escalation rules — what to do when blocked?
- [ ] Total file under 150 lines?
- [ ] Each section under 50 lines?
- [ ] Organized by task ("When X") not by topic?
- [ ] Every "don't" paired with a "do"?
- [ ] No prose paragraphs without commands?
- [ ] No ambiguous directives ("be careful", "where possible")?
- [ ] No contradictory priorities without explicit ordering?
- [ ] Detailed content in referenced files, not inline?
