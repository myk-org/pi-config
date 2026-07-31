# Default grouping (by source)
myk-pi-tools db stats

# Group by reviewer and print JSON
myk-pi-tools db stats --by-reviewer --json
```

**Return value / effect**

- Prints a table or JSON array to stdout.
- Exits with an error if both `--by-source` and `--by-reviewer` are passed.

### `db patterns`

Finds recurring dismissed comment patterns grouped by file path and body similarity.

| Option | Type | Default | Description |
|---|---|---|---|
| `--min` | Integer | `2` | Minimum occurrence count required for a pattern to be reported. |
| `--json` | Flag | `False` | Output JSON instead of a formatted table. |
| `--db-path` | String | auto-detected | Path to the SQLite database file. |

```bash
# Show recurring dismissed patterns with at least 3 occurrences
myk-pi-tools db patterns --min 3
```

**Return value / effect**

- Prints rows with `path`, `occurrences`, `reason`, and `body_sample`.
- Uses dismissed comments (`not_addressed` / `skipped`) as the source set.

### `db dismissed`

Returns stored dismissed comments for a repository.

| Option | Type | Default | Description |
|---|---|---|---|
| `--owner` | String | `(required)` | Repository owner or organization. |
| `--repo` | String | `(required)` | Repository name. |
| `--json` | Flag | `False` | Output JSON instead of a formatted table. |
| `--db-path` | String | auto-detected | Path to the SQLite database file. |

```bash
myk-pi-tools db dismissed --owner myk-org --repo pi-config --json
```

**Return value / effect**

- Prints dismissed review records for the specified repository.
- Returned rows include `path`, `line`, `body`, `status`, `reply`, `skip_reason`, `author`, `type`, and `comment_id`.
- Includes `not_addressed` and `skipped` comments, plus supported addressed body-comment/Qodo sticky types used for auto-skip logic.

### `db query`

Runs a read-only SQL query against the reviews database.

| Parameter / Option | Type | Default | Description |
|---|---|---|---|
| `sql` | String | `(required)` | SQL statement to execute. |
| `--json` | Flag | `False` | Output JSON instead of a formatted table. |
| `--db-path` | String | auto-detected | Path to the SQLite database file. |

> **Warning:** Only `SELECT` and `WITH` (CTE) queries are accepted. Multiple statements and write-oriented keywords are rejected.

```bash
# Count comments by status
myk-pi-tools db query "SELECT status, COUNT(*) AS cnt FROM comments GROUP BY status"

# JSON output
myk-pi-tools db query "SELECT path, line, status FROM comments LIMIT 5" --json
```

**Return value / effect**

- Prints query results as a table or JSON array.
- Returns an empty result set if the database is missing.
- Exits with an error for disallowed SQL.

### `db find-similar`

Reads a candidate comment from stdin and finds a previously dismissed comment with the same path and similar body text.

| Option | Type | Default | Description |
|---|---|---|---|
| `--owner` | String | `(required)` | Repository owner or organization. |
| `--repo` | String | `(required)` | Repository name. |
| `--threshold` | Float | `0.6` | Minimum similarity score from `0.0` to `1.0`. |
| `--json` | Flag | `False` | Output JSON instead of human-readable text. |
| `--db-path` | String | auto-detected | Path to the SQLite database file. |

```bash
echo '{"path":"src/main.py","body":"Add error handling for edge cases"}' | \
  myk-pi-tools db find-similar --owner myk-org --repo pi-config --json
```

**Return value / effect**

- Reads JSON from stdin with required keys `path` and `body`.
- Prints the best match or `null` / “No similar comment found”.
- Uses exact path match plus Jaccard word-overlap similarity.

## Review Handling (`myk-pi-tools reviews`)

### `reviews fetch`

Fetches review threads for the current PR and writes a normalized review JSON file.

| Parameter / Option | Type | Default | Description |
|---|---|---|---|
| `review_url` | String | `""` | Optional PR review URL or discussion URL for context. |
| `--include-resolved` | Flag | `False` | Include resolved threads in the output JSON. |
| `--user` | String | `None` | Filter threads by author username. |
| `--output-dir` | String | `(required)` | Directory for the output JSON file. |

```bash
myk-pi-tools reviews fetch --output-dir .pi/tmp/
```

**Return value / effect**

- Writes `<output-dir>/pr-<number>-reviews.json`.
- Prints the full normalized JSON payload to stdout.
- Output JSON contains `metadata`, `human`, `qodo`, and `coderabbit` arrays.

### `reviews poll`

Polls for new review activity until actionable feedback or approval is detected.

| Parameter / Option | Type | Default | Description |
|---|---|---|---|
| `review_url` | String | `""` | Optional PR review URL or discussion URL for context. |
| `--source` | String | `coderabbit` | Reviewer source to poll: `coderabbit` or `qodo`. |
| `--output-dir` | String | `(required)` | Directory for the review JSON file. |

```bash
# Poll CodeRabbit
myk-pi-tools reviews poll --output-dir .pi/tmp/

# Poll Qodo
myk-pi-tools reviews poll --source qodo --output-dir .pi/tmp/
```

**Return value / effect**

- Loops until one of these conditions is met:
  - approval is detected, or
  - actionable comments are available.
- Updates `<output-dir>/pr-<number>-reviews.json`.
- Prints a JSON object to stdout with review data and an `approved` flag when it returns.
- For `coderabbit`, handles rate-limit and paused-review recovery internally.
- For `qodo`, retries stuck reviews and may request sticky-comment re-evaluation before returning.

### `reviews post`

Posts replies and resolves review threads from a processed reviews JSON file.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `json_path` | String | `(required)` | Path to the processed review JSON file. |

```bash
myk-pi-tools reviews post .pi/tmp/pr-42-reviews.json
```

**Return value / effect**

- Reads the JSON produced by `reviews fetch`.
- Posts replies for processed entries and resolves eligible threads.
- Updates the JSON file with posting and resolution timestamps.
- Exits with an error if required replies are empty or too vague.

> **Note:** Qodo sticky findings are code-enforced to require status `addressed`. Non-`addressed` sticky entries are rejected.

### `reviews pending-fetch`

Fetches the authenticated user’s pending PR review and writes a pending-review JSON file.

| Parameter / Option | Type | Default | Description |
|---|---|---|---|
| `pr_url` | String | `(required)` | GitHub PR URL. |
| `--output-dir` | String | `(required)` | Directory for the output JSON file. |

```bash
myk-pi-tools reviews pending-fetch "https://github.com/owner/repo/pull/123" --output-dir .pi/tmp/
```

**Return value / effect**

- Writes `<output-dir>/pr-<owner>-<repo>-<number>-pending-review.json`.
- Prints the saved file path to stdout.
- Output JSON contains `metadata`, `comments`, and `diff`.

### `reviews pending-update`

Updates accepted pending-review comment bodies, and optionally submits the review.

| Parameter / Option | Type | Default | Description |
|---|---|---|---|
| `json_path` | String | `(required)` | Path to the pending-review JSON file. |
| `--submit` | Flag | `False` | Submit the review after updating comments. Submission only occurs if the JSON metadata also includes a valid `submit_action`. |

```bash
myk-pi-tools reviews pending-update .pi/tmp/pr-owner-repo-123-pending-review.json --submit
```

**Return value / effect**

- Updates comments whose status is `accepted` and that include `refined_body`.
- Backfills missing `node_id` values from the GitHub API before applying updates.
- If both `--submit` and JSON metadata `submit_action` are present, submits the review with `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`.
- Exits with an error if required `node_id` values cannot be resolved.

### `reviews status`

Shows stored review status for a PR and generates an HTML report.

| Option | Type | Default | Description |
|---|---|---|---|
| `--pr` | Integer | auto-detect | PR number. If omitted, the command tries to detect the current branch’s PR. |
| `--output-dir` | String | `(required)` | Directory for the generated HTML report. |

```bash
myk-pi-tools reviews status --output-dir .pi/reports/

myk-pi-tools reviews status --pr 42 --output-dir .pi/reports/
```

**Return value / effect**

- Writes `<output-dir>/review-status-<pr>.html`.
- Prints a terminal table and the HTML report location.
- If no PR can be auto-detected and `--pr` is omitted, lists PRs present in the local reviews database instead of generating a report.

> **Tip:** Use this command against stored review data after `reviews store`. See [Automating Code Reviews](automating-code-reviews.html) for review-loop usage.

### `reviews ask-qodo`

Posts a `/qodo` comment on a PR and waits for a matching reply.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `args` | String | `(required)` | Question text, or `--pr owner/repo <pr_number> <question>` to target a specific PR. |

```bash
# Auto-detect the current PR
myk-pi-tools reviews ask-qodo "What edge cases are missing?"

# Target a specific PR
myk-pi-tools reviews ask-qodo --pr myk-org/pi-config 42 "What edge cases are missing?"
```

**Return value / effect**

- Prints Qodo’s reply body to stdout.
- Auto-detects the current PR if `--pr` is not provided.
- Exits with code `1` if the question is empty, the post fails, or no matching reply arrives before timeout.

### `reviews store`

Stores a completed review JSON payload in the local SQLite database.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `json_path` | String | `(required)` | Path to the completed review JSON file. |

```bash
myk-pi-tools reviews store .pi/tmp/pr-42-reviews.json
```

**Return value / effect**

- Stores review metadata and comment rows in `<project-root>/.pi/data/reviews.db`.
- Anchors the stored review to the current commit SHA.
- Deletes the source JSON file after successful storage.

## Memory Management (`myk-pi-tools memory`)

### Global Option (`memory` group)

This option applies to every `memory` subcommand.

| Option | Type | Default | Description |
|---|---|---|---|
| `--file-path` | String | auto-detected | Path to the memory topics directory. If omitted, uses `<git-root>/.pi/memory/topics/`. |

```bash
myk-pi-tools memory --file-path /tmp/topics show
```

**Return value / effect**

- Overrides the default per-repository topics directory for the current invocation.

### `memory add`

Adds a memory entry to a topic file.

| Option | Type | Default | Description |
|---|---|---|---|
| `--category`, `-c` | String | `(required)` | Memory category: `lesson`, `decision`, `mistake`, `pattern`, `done`, or `preference`. |
| `--summary`, `-s` | String | `(required)` | One-line memory text. |
| `--pinned` | Flag | `False` | Store the entry as pinned. |

```bash
# Learned memory
myk-pi-tools memory add -c lesson -s "Cache mounts need uid"

# Pinned memory
myk-pi-tools memory add -c preference -s "Always use uv run" --pinned
```

**Return value / effect**

- Appends a markdown entry to the category’s topic file.
- Category-to-file mapping:
  - `preference` → `preferences.md`
  - `lesson` → `lessons.md`
  - `pattern` → `patterns.md`
  - `decision` → `decisions.md`
  - `done` → `completions.md`
  - `mistake` → `mistakes.md`
- Pinned entries are written with `*(pinned)*`.

### `memory show`

Prints all topic files as merged markdown.

| Option | Type | Default | Description |
|---|---|---|---|
| `--file-path` | String | auto-detected | Global `memory` option. |

```bash
myk-pi-tools memory show
```

**Return value / effect**

- Prints merged topic-file contents to stdout.
- Reads all `*.md` files from the topics directory in filename order.

### `memory migrate`

Migrates legacy SQLite memory data into topic files.

| Option | Type | Default | Description |
|---|---|---|---|
| `--file-path` | String | auto-detected | Global `memory` option. |

```bash
myk-pi-tools memory migrate
```

**Return value / effect**

- Reads `memories.db` from the parent memory directory.
- Writes migrated entries as learned topic-file entries.
- Deletes legacy files after migration: `memories.db`, `dreams.md`, and `dreams.lock`.
- Prints a migration summary to stderr.

### `memory forget`

Removes a matching memory entry.

| Option | Type | Default | Description |
|---|---|---|---|
| `--category`, `-c` | String | `(required)` | Memory category. |
| `--summary`, `-s` | String | `(required)` | Exact entry text to remove. |
| `--file-path` | String | auto-detected | Global `memory` option. |

```bash
myk-pi-tools memory forget -c mistake -s "Used sleep for polling"
```

**Return value / effect**

- Removes the matching learned or pinned line from the category topic file.
- Removes the matching entry hash from `memory-scores.json` if present.
- Prints either `Forgotten: ...` or `Not found: ...`.

### `memory path`

Prints the active memory topics directory.

| Option | Type | Default | Description |
|---|---|---|---|
| `--file-path` | String | auto-detected | Global `memory` option. |

```bash
myk-pi-tools memory path
```

**Return value / effect**

- Prints the absolute path to the active topics directory.

### `memory status`

Prints the memory enforcement-honesty inventory.

| Option | Type | Default | Description |
|---|---|---|---|
| `--file-path` | String | auto-detected | Global `memory` option. |

```bash
myk-pi-tools memory status
```

**Return value / effect**

- Prints:
  - active topics path,
  - injected topic-entry count,
  - code-tier enforced-entry count,
  - proposed promotion-candidate count.
- Lists code-tier entries when present.
- Reads `memory-scores.json` and `promotions.md` from the parent memory directory.

> **Tip:** See [Implementing Command Guards](safety-enforcements.html) for enforcement behavior and [Memory Architecture](memory-architecture.html) for storage and scoring details.

## Related Pages

- [Built-in Workflow Commands](built-in-workflows.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Curating Project Memory](curating-project-memory.html)
- [Configuration & Settings](configuration.html)
