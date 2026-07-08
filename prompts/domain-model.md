---
description: Scan the codebase and build/update a CONTEXT.md domain glossary for consistent AI vocabulary
argument-hint: "[focus area]"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

# Domain Model Command

Scan the codebase, identify domain-specific terms and naming patterns, and create or update
a `CONTEXT.md` glossary at the repository root. This gives all AI agents a shared vocabulary
for the project — reducing verbosity and improving naming consistency.

## Workflow

### Phase 1: Scan the Codebase

If raw arguments specify a focus area, narrow the scan to that area.
Otherwise, scan the full codebase.

Read **source code only** — TypeScript/Python files, variable/function/class/type names,
file structure, code comments. Look for:

- **Domain-specific terms** — words used in code identifiers that mean something specific
  in this project (not general programming concepts)
- **Naming patterns** — how the codebase names things in code (e.g., "handler" vs "controller")
- **Overloaded terms** — same word used for different concepts in different files
- **Inconsistent naming** — same concept called different things in different files
- **Acronyms and abbreviations** — project-specific shorthand in code

**DO NOT include:**

- Operational workflows or processes (how things are done — that belongs in rules/memory)
- Features described in README/docs (those are documentation, not vocabulary)
- Memory system entries or session knowledge
- Anything that isn't a term used in actual code identifiers or code comments

The glossary is for **naming consistency in code** — so the AI uses the same
identifier names the codebase uses. If a term doesn't appear as a variable name,
function name, type name, or class name in the code, it probably doesn't belong.

### Phase 2: Check Existing CONTEXT.md

If `CONTEXT.md` exists at the repo root:

1. Read it
2. Cross-reference against the codebase scan — are definitions still accurate?
3. Identify new terms that should be added
4. Identify stale terms that no longer appear in the code
5. Present a diff of proposed changes to the user

If no `CONTEXT.md` exists, proceed to Phase 3.

### Phase 3: Draft CONTEXT.md

Create a draft following this format:

```markdown
# {Project Name}

{One-sentence description of what this project is.}

## Language

**{Term}**:
{One or two sentence definition of what it IS, not what it does.}

**{Another Term}**:
{Definition}
_Avoid_: {alternative words people might use that would cause confusion}
```

**Rules for the glossary:**

- **Keep definitions tight** — one or two sentences max
- **Only project-specific terms** — general programming concepts don't belong
- **Group under subheadings** when natural clusters emerge
- **Cross-reference with code** — if the glossary says "Order", the code should use "Order"
  not "Purchase" or "Transaction"
- **`_Avoid_` is optional** — only add it when there's genuine ambiguity where someone
  (human or AI) might use a different word for the same concept. For code identifiers
  with clear names (e.g., `resolveRepoRoot`), no `_Avoid_` is needed — the name speaks
  for itself. Use `_Avoid_` for domain concepts like "Worktree" where someone might say
  "working copy" or "branch copy" instead.

### Phase 4: Present to User

Display the full draft and ask the user to review:

- Approve as-is
- Correct any definitions
- Add missing terms
- Remove terms that don't belong

Apply corrections and write `CONTEXT.md` to the repo root.

### Phase 5: Commit

Stage and commit `CONTEXT.md` with message: `docs: create/update domain model glossary`
