---
description: "Commit and push the current change set via git-expert — /create-commit <message>"
argument-hint: "<message>"
---

## Raw Arguments

```text
$ARGUMENTS
```

# Create Commit Prompt

Generates the git-expert commit delegation from the template instead of composing
the instruction prose. Only the file list and message vary per commit.

## Workflow

### Step 1: Read the Template

Read the template file:

```text
~/.pi/agent/npm/node_modules/pi-orchestrator-config/templates/commit-prompt.md
```

Developer checkout fallback: `templates/commit-prompt.md` in the pi-config repo.
This is the immutable source template. NEVER modify it.

### Step 2: Fill Placeholders

| Placeholder | Value |
|-------------|-------|
| `{{FILES}}` | Every file to commit from `git status --porcelain` (staged, unstaged, untracked), one hyphen bullet per file, exact paths |
| `{{MESSAGE}}` | The raw arguments — the commit subject. If empty, draft a conventional `type(scope): description` subject from the change set and confirm with the user |
| `{{BODY}}` | Empty by default. Only fill if the user supplied a body |

If `git status` shows files that clearly should not be committed (generated
artifacts, `.env`, secrets), exclude them from `{{FILES}}` and say so.

Never leave a `{{...}}` token in the output.

### Step 3: Delegate

Delegate the filled template to `git-expert` **verbatim** — no extra prose,
no re-wording, no added instructions.

### Step 4: Report

Report git-expert's result: commit sha, branch, push outcome.
