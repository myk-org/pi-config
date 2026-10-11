# Commit Delegation — Template

> **Usage:** The orchestrator fills every `{{PLACEHOLDER}}` and delegates the
> filled text to git-expert. Delete this usage block when done.

---

Commit and push the current change set.

**Files to stage — EXACTLY these, never `git add .` or `git add -A`:**

{{FILES}}

**Commit message:**

```text
{{MESSAGE}}
```

**Commit body** (omit entirely if empty):

```text
{{BODY}}
```

**Steps:**

1. Stage each file listed above individually — always `git add -- <file>`
   (the `--` terminator is mandatory; never let a path be read as an option),
   one command naming every file is fine. Quote paths containing spaces or
   special characters.
2. Commit with the message (and body if present) above — use a HEREDOC for multi-line.
3. Push the current branch to origin (set upstream with `-u` if the branch has none).
4. Report: commit sha, branch, push result.
