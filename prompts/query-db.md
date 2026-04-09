---
description: "Query the reviews database for analytics — /query-db [stats|patterns|dismissed|query|find-similar] [OPTIONS]"
---

Execute this workflow step by step. Run bash commands directly.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, stop — install from https://docs.astral.sh/uv/getting-started/installation/

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, ask user to install: `uv tool install myk-pi-tools`

## Available Queries

Parse `{{args}}` and run the appropriate command:

### Stats by Source

```bash
myk-pi-tools db stats --by-source
```

### Stats by Reviewer

```bash
myk-pi-tools db stats --by-reviewer
```

### Duplicate Patterns

```bash
myk-pi-tools db patterns --min 2
```

### Dismissed Comments

```bash
myk-pi-tools db dismissed --owner <owner> --repo <repo>
```

### Custom Query

```bash
myk-pi-tools db query "SELECT * FROM comments WHERE status = 'skipped' ORDER BY id DESC LIMIT 10"
```

### Find Similar Comments

```bash
echo '[{"body": "Consider adding error handling", "path": "src/main.py"}]' | myk-pi-tools db find-similar
```

## Database Schema Reference

**reviews table:** id, pr_number, owner, repo, commit_sha, created_at

**comments table:** id, review_id (FK), source (human/qodo/coderabbit), thread_id, node_id, comment_id, author, path, line, body, priority (HIGH/MEDIUM/LOW), status (pending/addressed/skipped/not_addressed), reply, skip_reason, posted_at, resolved_at

**Constraints:** Only SELECT statements and CTEs are allowed. INSERT/UPDATE/DELETE/DROP are blocked.

## Workflow

1. Parse `{{args}}` to determine which query to run
2. Execute the appropriate `myk-pi-tools db` command
3. Present results in a clear, formatted way
4. For natural language questions, compose the appropriate SQL query
