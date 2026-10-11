# Commit Delegation — Template

> **Usage:** The orchestrator fills every `{{PLACEHOLDER}}` and delegates the
> filled text to git-expert. Delete this usage block when done.

---

Commit and push the current change set.

**Files to stage — EXACTLY these, never `git add .` or `git add -A`:**

{{FILES}}

**Commit message** (subject only — never body content):

````text
{{MESSAGE}}
````

**Commit body** (omit entirely if empty):

````text
{{BODY}}
````

**Steps:**

1. Stage each file listed above individually — always `git add -- <file>`
   (the `--` terminator is mandatory; never let a path be read as an option),
   one command naming every file is fine. Quote paths containing spaces or
   special characters; if a path contains glob characters or pathspec magic
   (`*`, `?`, `:` …), stage it as `git add -- ':(literal)<file>'` so it is
   treated as an exact path, never a pattern. If a path was rendered in
   shell-escaped form (`printf '%q'`), decode it before staging.
2. Commit with the message (and body if present) above — use a HEREDOC for multi-line.
   The message and body must never duplicate each other.
3. Push the current branch to origin (set upstream with `-u` if the branch has none).
4. Report: commit sha, branch, push result.
