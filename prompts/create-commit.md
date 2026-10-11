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
| `{{FILES}}` | Every file to commit, one hyphen bullet per file, exact paths — parse `git status --porcelain=v1 -z` per the rules below |
| `{{MESSAGE}}` | Commit subject — the FIRST LINE of the raw arguments, nothing more. If empty, draft a conventional `type(scope): description` subject from the change set and confirm with the user |
| `{{BODY}}` | The remainder of the raw arguments after the first line, if any — never duplicates `{{MESSAGE}}` content. Empty by default |

**Parsing `git status --porcelain=v1 -z`** (NUL-delimited; avoids quote ambiguity):

- Rename (`R`) and copy (`C`) records: list only the NEW/destination path
- C-escaped quoted paths: decode to the real path; deleted paths: keep as-is
- Paths containing newlines or control characters: render them in `printf '%q'` shell-escaped form so the bullet keeps one line — git-expert decodes before staging

If `git status` shows files that clearly should not be committed (generated
artifacts, `.env`, secrets), exclude them from `{{FILES}}` and say so.

Never leave a `{{...}}` token in the output.

### Step 3: Delegate

Delegate the filled template to `git-expert` **verbatim** — no extra prose,
no re-wording, no added instructions.

### Step 4: Report

Report git-expert's result: commit sha, branch, push outcome.
