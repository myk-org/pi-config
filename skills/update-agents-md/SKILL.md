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
4. Verify total is under 150 lines (longer files hurt performance)
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

## Template & Required Sections (in order)

Order matters — front-load highest-ROI content (`Commands` FIRST). Use this annotated skeleton:

````markdown
# Project Name

Brief one-line description.

## Commands <!-- exact invocations with flags + full-verify one-liner -->
- Build: `<build command>`
- Test: `<test command with flags>`
- Lint: `<lint command with flags>`
- Type check: `<type check command>`
- Full verify: `<lint command> && <test command> && <type check command>`

## Definition of Done <!-- specific exit codes, not feelings -->
A task is complete when ALL pass:
1. `<lint command>` exits 0
2. `<test command>` exits 0 with no failures
3. `<type check command>` exits 0
4. Changed files staged and committed as `type(scope): description`

## When Blocked <!-- escalation rules; pair every "never" with what to do instead -->
- Tests fail after 3 attempts → stop, report failing test with full output
- Missing dependency → check manifest/requirements first, then ask
- Merge conflicts → stop, show conflicting files
- NEVER: delete files to resolve errors, force push, skip tests

## Project <!-- specific versions, key deps, and 1-line structure descriptions -->
- Stack: <tech with version>, <tech with version>, <build tool>
- Structure: `src/` (app code), `tests/` (tests), `docs/` (docs)
- Key deps: <dep> for <purpose>, <dep> for <purpose>

## When Writing Code <!-- task-organized "When X" sections > flat topic lists -->
- Run `<lint command>` after every file change
- Add type hints to all new functions
- Test: `<test command for specific module>`

## When Reviewing Code
- Check security: `<security audit command>`
- Verify coverage: `<test command with coverage flag>`

## When Releasing
- Update version in `<manifest file>`
- Run full suite: `<lint command> && <test command> && <type check command>`
- Tag: `git tag -a v<version> -m "Release v<version>"`

## Boundaries <!-- 3 tiers; pair every "don't" with a "do" (15+ bare "don'ts" cause overexploration) -->
- ✅ Always: run tests before commits, follow naming conventions
- ⚠️ Ask first: database schema changes, adding dependencies, modifying CI
- 🚫 Never: commit secrets, edit dependency dirs, force push to main
````

### Section Rules

- **Commands:** Exact invocations with flags plus a `Full verify` one-liner; every rule should answer "What command proves this was done?"
- **Definition of Done:** Specific exit codes, not feelings — prevents "I think I'm done", the #1 agent failure mode.
- **When Blocked:** Escalation rules stop destructive improvisation; pair every "never" with what to do instead.
- **Project:** Specific versions, key deps, and 1-line structure descriptions — vague labels like "React project" are useless.
- **When X:** Task-organized sections let agents select relevant instructions by context instead of parsing flat topic lists.
- **Boundaries:** Three tiers (`Always` / `Ask first` / `Never`); pair every "don't" with a "do" (15+ bare "don'ts" cause overexploration).

---

## Size Budget (for generated AGENTS.md files)

These limits apply to the AGENTS.md files you CREATE, not to this skill guide.

| Metric | Target | Why |
| --- | --- | --- |
| Total file | Under 150 lines | Longer files actively hurt (Augment, measured) |
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
| --- | --- |
| Reuse of existing code | 3-10 line examples from actual prod code |
| Following codebase conventions | Decision tables for ambiguous choices |
| Wiring of complex features | Numbered procedural workflows |
| Handling of gotchas | "Don't X" paired with "Do Y instead" |
| Reducing context rot | Progressive disclosure via reference files |

---

## Anti-Patterns (NEVER do these)

| Anti-Pattern | Why it fails | Fix |
| --- | --- | --- |
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
| --- | --- | --- |
| Codex CLI | AGENTS.md | Yes (native) |
| Cursor | `.cursor/rules` | Yes (native) |
| GitHub Copilot | `.github/copilot-instructions.md` | Yes (native) |
| Claude Code | CLAUDE.md | Yes (native + CLAUDE.md) |
| Gemini CLI | GEMINI.md | Configurable |
| Windsurf | `.windsurfrules` | Yes (native) |

**Strategy:** Write AGENTS.md as canonical source. Claude Code reads both AGENTS.md and CLAUDE.md natively — use CLAUDE.md for Claude-specific overrides only.

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
