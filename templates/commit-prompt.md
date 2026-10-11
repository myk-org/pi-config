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
```text

**Commit body** (omit entirely if empty):

```text
{{BODY}}
```text

**Steps:**

1. Stage each file listed above individually (`git add <file>` per file or one command naming every file).
2. Commit with the message (and body if present) above — use a HEREDOC for multi-line.
3. Push the current branch to origin (set upstream with `-u` if the branch has none).
4. Report: commit sha, branch, push result.
