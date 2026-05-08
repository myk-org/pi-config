# Querying the Review Database

```markdown
# Querying the Review Database

Analyze your accumulated code review history to spot recurring feedback, understand which review sources deliver the most value, and track how your team handles suggestions over time. These queries help you tune auto-skip rules and focus reviewer effort where it matters.

## Prerequisites

- `myk-pi-tools` installed (`uv tool install myk-pi-tools`)
- A review database at `<project-root>/.pi/data/reviews.db` (created automatically when you store completed reviews with `myk-pi-tools reviews store`)

## Quick Example

See how often comments from each review source get addressed:

```bash
myk-pi-tools db stats
```

```
source    | total | addressed | not_addressed | skipped | addressed_rate
----------+-------+-----------+---------------+---------+---------------
coderabbit| 48    | 32        | 10            | 6       | 66.7%
human     | 25    | 22        | 2             | 1       | 88.0%
qodo      | 15    | 9         | 4             | 2       | 60.0%
```

This tells you at a glance which sources produce the most actionable feedback.

## Viewing Statistics

### Stats by source

The default view groups comments by their origin — `human`, `qodo`, or `coderabbit`:

```bash
myk-pi-tools db stats
```

This is equivalent to `myk-pi-tools db stats --by-source`.

### Stats by reviewer

Switch to per-author breakdown to see which individual reviewers provide the most feedback:

```bash
myk-pi-tools db stats --by-reviewer
```

```
author          | total | addressed | not_addressed | skipped
----------------+-------+-----------+---------------+--------
coderabbitai    | 48    | 32        | 10            | 6
alice           | 15    | 14        | 1             | 0
bob             | 10    | 8         | 1             | 1
```

### JSON output

Add `--json` to any command for machine-readable output:

```bash
myk-pi-tools db stats --by-source --json
```

## Finding Recurring Patterns

Identify comments that keep appearing with similar wording — these are good candidates for auto-skip rules:

```bash
myk-pi-tools db patterns
```

```
path            | occurrences | reason                    | body_sample
----------------+-------------+---------------------------+-----------------------------
src/api/auth.py | 4           | Style preference, ignored | Consider adding type hints...
src/utils.py    | 3           | Not applicable to project | Add error handling for ed...
```

Raise the threshold to focus on the most persistent patterns:

```bash
myk-pi-tools db patterns --min 3
```

> **Tip:** Patterns with high occurrence counts are strong signals that an auto-skip rule should be configured. The tool uses Jaccard word similarity (60% overlap) to cluster related comments, so minor wording variations still get grouped together.

## Viewing Dismissed Comments

List all comments that were marked as `not_addressed` or `skipped` for a specific repository:

```bash
myk-pi-tools db dismissed --owner myk-org --repo my-project
```

```
path            | line | status        | reply                     | author
----------------+------+---------------+---------------------------+-----------
src/config.py   | 42   | not_addressed | Style preference, ignored | coderabbitai
src/api/main.py | 15   | skipped       | Auto-skipped: duplicate   | qodo-code-review
```

This shows the dismissal reason alongside each comment, helping you understand why feedback was set aside.

> **Note:** Comments with status `addressed` only appear here if they have a special type (`outside_diff_comment`, `nitpick_comment`, or `duplicate_comment`). Normal addressed comments are tracked by GitHub's thread resolution instead.

## Finding Similar Comments

Check whether a new review comment matches something previously dismissed. This is the same similarity check that powers the auto-skip feature during review fetching.

Pipe a JSON object with `path` and `body` fields via stdin:

```bash
echo '{"path": "src/utils.py", "body": "Add error handling for edge cases"}' | \
    myk-pi-tools db find-similar --owner myk-org --repo my-project
```

```
Found similar comment (similarity: 0.85):
  Path: src/utils.py:23
  Status: not_addressed
  Reason: Not applicable — error cases handled upstream
  Original body: Consider adding error handling for edge case...
```

Adjust the similarity threshold (default 0.6) to be more or less strict:

```bash
echo '{"path": "src/utils.py", "body": "Add error handling"}' | \
    myk-pi-tools db find-similar --owner myk-org --repo my-project --threshold 0.8
```

## Running Custom Queries

For ad-hoc exploration, run raw SQL against the database:

```bash
myk-pi-tools db query "SELECT path, COUNT(*) as cnt FROM comments WHERE status = 'skipped' GROUP BY path ORDER BY cnt DESC"
```

### Useful queries

**Top files by total comments:**

```bash
myk-pi-tools db query "SELECT path, COUNT(*) as total FROM comments GROUP BY path ORDER BY total DESC LIMIT 10"
```

**Comments by status breakdown:**

```bash
myk-pi-tools db query "SELECT status, COUNT(*) as cnt FROM comments GROUP BY status"
```

**Recent reviews with comment counts:**

```bash
myk-pi-tools db query "SELECT r.owner, r.repo, r.pr_number, r.created_at, COUNT(c.id) as comments FROM reviews r JOIN comments c ON c.review_id = r.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 10"
```

**High-priority unaddressed comments:**

```bash
myk-pi-tools db query "SELECT c.path, c.line, c.body, c.author FROM comments c WHERE c.priority = 'HIGH' AND c.status = 'not_addressed'"
```

**Common Table Expressions (CTEs) are supported:**

```bash
myk-pi-tools db query "WITH skipped AS (SELECT path, body, skip_reason FROM comments WHERE status = 'skipped') SELECT path, COUNT(*) as cnt FROM skipped GROUP BY path"
```

> **Warning:** Only `SELECT` and `WITH` (CTE) statements are allowed. The database is opened in read-only mode, and modifying keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `PRAGMA`) are blocked.

## Advanced Usage

### Using a custom database path

All `db` subcommands accept `--db-path` to point at a specific database file instead of the auto-detected one:

```bash
myk-pi-tools db stats --db-path /path/to/other/reviews.db
```

By default, the tool auto-detects the database at `<git-root>/.pi/data/reviews.db` based on the current working directory.

### Database schema reference

The database has two tables:

**reviews** — one row per review session:

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| pr_number | INTEGER | Pull request number |
| owner | TEXT | GitHub org or user |
| repo | TEXT | Repository name |
| commit_sha | TEXT | Git commit at review time |
| created_at | TEXT | ISO 8601 timestamp |

**comments** — one row per review comment:

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| review_id | INTEGER | Foreign key to reviews |
| source | TEXT | `human`, `qodo`, or `coderabbit` |
| author | TEXT | Reviewer username |
| path | TEXT | File path |
| line | INTEGER | Line number |
| body | TEXT | Comment text |
| priority | TEXT | `HIGH`, `MEDIUM`, or `LOW` |
| status | TEXT | `pending`, `addressed`, `not_addressed`, or `skipped` |
| reply | TEXT | Human response or dismissal reason |
| skip_reason | TEXT | Raw dismissal reason |
| type | TEXT | `outside_diff_comment`, `nitpick_comment`, `duplicate_comment`, or null |
| posted_at | TEXT | ISO 8601 timestamp |
| resolved_at | TEXT | ISO 8601 timestamp |

### How auto-skip uses this data

When new reviews are fetched, the system automatically queries dismissed comments from the database and compares them against incoming feedback. If a new comment has 60% or greater word overlap with a previously dismissed comment on the same file path, it is auto-skipped with the original dismissal reason. This prevents the same low-value suggestions from resurfacing across PRs.

The `find-similar` command lets you test this matching logic manually before relying on it.

### Querying from the orchestrator

Inside a pi session, use the `/query-db` slash command to run database queries conversationally:

```text
/query-db stats --by-source
/query-db patterns --min 3
/query-db dismissed --owner myk-org --repo my-project
```

You can also ask natural language questions, and the orchestrator will compose the appropriate query.

## Troubleshooting

- **"Database not found"** — No reviews have been stored yet. Run a full review cycle (`myk-pi-tools reviews fetch`, then `myk-pi-tools reviews store`) to populate the database.
- **"Only SELECT/CTE queries are allowed"** — The `query` command blocks write operations. Use built-in subcommands (`stats`, `patterns`, `dismissed`) for standard analysis, or write a `SELECT` statement for custom queries.
- **"Multiple SQL statements are not allowed"** — The `query` command only accepts a single statement. Remove any semicolons separating multiple queries and run them one at a time.
- **Stats show no data for a source** — That review source hasn't produced any comments in stored reviews. Verify that reviews from that source exist by running `myk-pi-tools db query "SELECT DISTINCT source FROM comments"`.
