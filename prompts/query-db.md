---
description: Query the reviews database for analytics and insights
argument-hint: "<query>"
---

## Raw Arguments

```text
$ARGUMENTS
```

# Review Database Query Command

Query the reviews database for analytics and insights about PR review history.

## Prerequisites Check (MANDATORY)

### Step 0: Check uv

```bash
uv --version
```

If not found, install from <https://docs.astral.sh/uv/getting-started/installation/>

## Usage

```bash
/query-db stats --by-source        # Stats by source
/query-db stats --by-reviewer      # Stats by reviewer
/query-db patterns --min 2         # Find duplicate patterns
/query-db dismissed --owner X --repo Y
/query-db query "SELECT * FROM comments WHERE status='skipped' LIMIT 10"
/query-db find-similar < comments.json   # Find similar dismissed comments
```

## Available Queries

### Stats by Source

Show addressed rate by source (human vs AI reviewers):

```bash
uvx myk-pi-tools@latest db stats --by-source
```

### Stats by Reviewer

Show statistics by individual reviewer:

```bash
uvx myk-pi-tools@latest db stats --by-reviewer
```

### Duplicate Patterns

Find recurring dismissed suggestions:

```bash
uvx myk-pi-tools@latest db patterns --min 2
```

### Dismissed Comments

Get all dismissed comments for a specific repo:

```bash
uvx myk-pi-tools@latest db dismissed --owner <owner> --repo <repo>
```

### Custom Query

Run a custom SELECT query:

```bash
uvx myk-pi-tools@latest db query "SELECT * FROM comments WHERE status = 'skipped' ORDER BY id DESC LIMIT 10"
```

### Find Similar Comments

Find comments similar to previously dismissed ones. Accepts JSON input via stdin:

```bash
echo '[{"body": "Consider adding error handling", "path": "src/main.py"}]' | uvx myk-pi-tools@latest db find-similar
```

Input format: JSON array of objects with `body` (required) and optionally `path` fields.

Returns matches with similarity scores to help identify recurring patterns that were previously dismissed.

## Database Schema

**reviews table:**

| Column | Type |
| --- | --- |
| id | INTEGER PRIMARY KEY |
| pr_number | INTEGER |
| owner | TEXT |
| repo | TEXT |
| commit_sha | TEXT |
| created_at | TEXT (ISO 8601) |

**comments table:**

| Column | Type |
| --- | --- |
| id | INTEGER PRIMARY KEY |
| review_id | INTEGER (FK -> reviews.id) |
| source | TEXT (human/qodo/coderabbit) |
| thread_id | TEXT |
| node_id | TEXT |
| comment_id | INTEGER |
| author | TEXT |
| path | TEXT |
| line | INTEGER |
| body | TEXT |
| priority | TEXT (HIGH/MEDIUM/LOW) |
| status | TEXT (pending/addressed/skipped/not_addressed) |
| reply | TEXT |
| skip_reason | TEXT |
| posted_at | TEXT (ISO 8601) |
| resolved_at | TEXT (ISO 8601) |

## Database Location and Constraints

The reviews database is located at `<project-root>/.claude/data/reviews.db`.

**Query Constraints:**

- Only SELECT statements and CTEs (Common Table Expressions) are allowed
- INSERT, UPDATE, DELETE, DROP, and other modifying statements are blocked
- This ensures the database remains read-only for analytics queries

## Workflow

1. Parse the raw arguments above to determine which query to run
2. Execute the appropriate `db` subcommand
3. Present results in a clear, formatted way
4. For natural language questions, compose the appropriate query
