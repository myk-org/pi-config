---
name: conflict-resolver
description: "Resolve git merge/rebase conflicts by analyzing git history, commit intent, and code context. Use when merge or rebase produces conflicts."
---

# Git Conflict Resolver

Resolve merge and rebase conflicts by understanding WHY both sides made their changes,
then choosing the right resolution based on intent — not just line-by-line diffing.

## When to Use

- `git merge` / `git rebase` / `git cherry-pick` produced conflicts
- PR can't merge due to conflicts
- Worktree rebase has conflicts after `git rebase origin/main`

## Phase 1: Understand the Conflict

Before touching any file, gather context:

```bash
# List all conflicted files
git diff --name-only --diff-filter=U

# Show conflict details
git status --porcelain | grep "^UU"
```

For EACH conflicted file:

```bash
# See what each side changed
git log --oneline MERGE_HEAD..HEAD -- <file>    # our commits
git log --oneline HEAD..MERGE_HEAD -- <file>    # their commits

# Get blame for context
git blame HEAD -- <file> | head -30
git blame MERGE_HEAD -- <file> | head -30

# View the actual conflict markers
grep -n "<<<<<<\|======\|>>>>>>" <file>
```

**Iron Law: understand BOTH sides before resolving. Never blindly accept one side.**

## Phase 2: Classify the Conflict

Classify each side's changes by intent:

| Type | Indicators | Resolution Priority |
|------|-----------|---------------------|
| Security fix | "security", "vuln", "CVE" in commit message | Highest — always keep |
| Bug fix | "fix", "bug", "patch" in commit message; small targeted change | Highest — always keep |
| Refactor | "refactor", "cleanup", "rename"; no behavior change | Medium — preserve both if compatible |
| Feature | "feat", "add", "implement"; new functionality | Medium — merge carefully |
| Style | "style", "format", "lint"; whitespace/formatting only | Lowest — accept either side |

## Phase 3: Resolve

### Decision Framework

1. **Same intent, compatible changes** → merge both (most common)
2. **Bug fix vs feature** → bug fix wins, integrate feature around it
3. **Conflicting logic** → prefer the more recent or more tested change
4. **Style/format conflicts** → accept either, prefer consistency with surrounding code
5. **Deletions vs modifications** → investigate why deleted; deletion is usually intentional
6. **Lock files** (`package-lock.json`, `uv.lock`, `yarn.lock`, `pnpm-lock.yaml`) → NEVER merge manually. Accept one side, regenerate:

```bash
# For uv.lock
git checkout --theirs uv.lock
uv lock

# For package-lock.json
git checkout --theirs package-lock.json
npm install

# For yarn.lock
git checkout --theirs yarn.lock
yarn install
```

### Resolution Commands

```bash
# Accept theirs entirely (incoming/base branch)
git checkout --theirs <file>
git add <file>

# Accept ours entirely (current branch)
git checkout --ours <file>
git add <file>

# Manual resolution
# 1. Open file, read conflict markers
# 2. Remove <<<<<<< ======= >>>>>>> markers
# 3. Combine changes based on intent analysis
# 4. Verify syntax
git add <file>
```

### For Manual Resolution

1. Read the ENTIRE conflict block — not just the markers
2. Check what comes BEFORE and AFTER the conflict — context matters
3. If both sides add imports → keep both (deduplicate)
4. If both sides modify the same function → merge logic carefully, test
5. If one side deletes code the other modifies → check git log to understand why

## Phase 4: Verify

```bash
# No remaining conflict markers
grep -rn "<<<<<<\|======\|>>>>>>" <resolved-files>

# No unresolved files
git diff --name-only --diff-filter=U

# Syntax check (language-dependent)
# Python
uv run python -c "import ast; ast.parse(open('<file>').read())"
# TypeScript/JavaScript
npx tsc --noEmit
# Go
go build ./...

# Run tests
uv run pytest -q    # or npm test, go test, etc.
```

## Phase 5: Complete

```bash
# For merge
git add <all-resolved-files>
git commit  # uses merge commit message

# For rebase
git add <all-resolved-files>
git rebase --continue
```

## Common Patterns

### Import Conflicts

Both sides added different imports → keep all, deduplicate:

```python
# OURS
from module import foo, bar

# THEIRS
from module import foo, baz

# RESOLVED
from module import bar, baz, foo
```

### Function Modification Conflicts

Both sides changed the same function → merge logic:

1. Read both versions completely
2. Identify what each change does
3. If independent changes → combine both
4. If conflicting behavior → pick the one that matches current requirements

### Config/YAML Conflicts

Both sides added different config entries → merge sections:

```yaml
# Usually safe to keep both additions
# Watch for duplicate keys — last one wins in YAML
```

## Anti-Patterns

| Don't | Why | Instead |
|-------|-----|---------|
| `git checkout --ours .` | Discards ALL incoming changes | Resolve file by file |
| Manually edit lock files | Corrupts dependency resolution | Regenerate from scratch |
| Skip git blame | Wrong intent, wrong resolution | Always check commit history |
| Resolve without understanding | Creates subtle bugs | Read both sides first |
| Accept AI's first suggestion blindly | AI often picks one side | Verify the merge makes sense |
