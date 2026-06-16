# myk-pi-tools CLI Reference

`myk-pi-tools` is the Python CLI package that provides tooling for the pi orchestrator. It wraps GitHub API operations, review handling, release management, memory persistence, and external AI CLI integration.

**Version:** 3.9.1
**Install:** `pip install myk-pi-tools` (included in pi-config Docker image and native install)
**Entry point:** `myk-pi-tools`
**Requires:** Python ≥ 3.12, GitHub CLI (`gh`) for most commands

```bash
myk-pi-tools --version
myk-pi-tools --help
```

> **Note:** Most subcommands that interact with GitHub require the `gh` CLI to be installed and authenticated. See [Installing and Starting Your First Session](quickstart.html) for setup.

---

## Subcommand Overview

| Subcommand | Description |
|---|---|
| [`memory`](#memory) | Project memory commands — persistent per-repo learning |
| [`pr`](#pr) | PR review and management commands |
| [`release`](#release) | GitHub release commands |
| [`reviews`](#reviews) | Review handling commands (fetch, poll, post, store) |
| [`db`](#db) | Review database query commands |
| [`coderabbit`](#coderabbit) | CodeRabbit rate limit and trigger commands |
| [`ai-cli`](#ai-cli) | AI CLI commands (cursor, claude, gemini) |

---

## `memory`

Project memory commands — persistent per-repo learning. Stores entries as Markdown topic files under `.pi/memory/topics/`.

**Group option:**

| Option | Type | Default | Description |
|---|---|---|---|
| `--file-path` | string | `.pi/memory/topics/` (auto-detected from git root) | Path to memory topics directory |

See [Working with Project Memory](memory-system.html) for how memory integrates with the orchestrator.

### `memory add`

Add a memory entry to the appropriate topic file.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `-c`, `--category` | choice | yes | — | Memory category: `lesson`, `decision`, `mistake`, `pattern`, `done`, `preference` |
| `-s`, `--summary` | string | yes | — | Short description (one line) |
| `--pinned` | flag | no | `false` | Add to Pinned section (protected from dreaming) |

**Category-to-file mapping:**

| Category | Topic File |
|---|---|
| `preference` | `preferences.md` |
| `lesson` | `lessons.md` |
| `pattern` | `patterns.md` |
| `decision` | `decisions.md` |
| `done` | `completions.md` |
| `mistake` | `mistakes.md` |

```bash
# Add a learned memory
myk-pi-tools memory add -c lesson -s "buildah chown -R skips target dir"

# Add a pinned memory (user-requested, never auto-removed)
myk-pi-tools memory add -c preference -s "Always use uv run" --pinned
```

**Effect:** Appends a line to the topic file. Pinned entries are marked with `*(pinned)*` and are protected from dreaming consolidation.

### `memory show`

Show all memory entries across all topic files.

```bash
myk-pi-tools memory show
```

**Output:** Combined contents of all `.md` files in the topics directory, sorted alphabetically, printed to stdout.

### `memory forget`

Remove a memory entry from its topic file and clean up the corresponding entry in `memory-scores.json`.

| Option | Type | Required | Description |
|---|---|---|---|
| `-c`, `--category` | choice | yes | Memory category: `lesson`, `decision`, `mistake`, `pattern`, `done`, `preference` |
| `-s`, `--summary` | string | yes | Entry text to forget (must match exactly) |

```bash
myk-pi-tools memory forget -c lesson -s "buildah chown -R skips target dir"
myk-pi-tools memory forget -c pattern -s "Container build monitor: old pattern"
```

**Effect:** Removes the matching line from the topic file. Also removes the corresponding hash entry from `.pi/memory/memory-scores.json` if present. Outputs confirmation or "Not found" to stderr.

### `memory migrate`

One-time migration from legacy SQLite database to topic files.

```bash
myk-pi-tools memory migrate
```

**Effect:** Reads all memories from `.pi/memory/memories.db`, writes them as learned entries to topic files, then deletes `memories.db`, `dreams.md`, and `dreams.lock`.

### `memory path`

Print the memory topics directory path.

```bash
myk-pi-tools memory path
# Output: /home/user/project/.pi/memory/topics
```

---

## `pr`

PR review and management commands. All subcommands accept PR references in multiple formats.

**Argument formats (shared across `pr diff` and `pr claude-md`):**

| Format | Example |
|---|---|
| `<owner/repo> <pr_number>` | `myk-org/pi-config 42` |
| `<github_url>` | `https://github.com/myk-org/pi-config/pull/42` |
| `<pr_number>` (auto-detect repo) | `42` |

> **Note:** The `<pr_number>` format requires running from within a git repository with `gh` configured.

### `pr diff`

Fetch PR diff and metadata. Outputs JSON to stdout.

```bash
myk-pi-tools pr diff myk-org/pi-config 42
myk-pi-tools pr diff https://github.com/myk-org/pi-config/pull/42
myk-pi-tools pr diff 42
```

**Output:** JSON object with structure:

```json
{
  "metadata": {
    "owner": "myk-org",
    "repo": "pi-config",
    "pr_number": "42",
    "head_sha": "abc123...",
    "base_ref": "main",
    "title": "PR title",
    "state": "open"
  },
  "diff": "...",
  "files": [
    {
      "path": "src/main.py",
      "status": "modified",
      "additions": 10,
      "deletions": 3,
      "patch": "..."
    }
  ]
}
```

### `pr claude-md`

Fetch `CLAUDE.md` and `AGENTS.md` content for a PR's repository.

Checks local files first (if current repo matches target), then falls back to GitHub API.

```bash
myk-pi-tools pr claude-md myk-org/pi-config 42
myk-pi-tools pr claude-md https://github.com/myk-org/pi-config/pull/42
```

**Files checked:**

| Local Path | Remote Path |
|---|---|
| `./CLAUDE.md` | `CLAUDE.md` |
| `./.claude/CLAUDE.md` | `.claude/CLAUDE.md` |
| `./AGENTS.md` | `AGENTS.md` |
| `./.agents/AGENTS.md` | `.agents/AGENTS.md` |

**Output:** Combined content of all found files to stdout. Empty string if none found.

### `pr store-pr-review`

Store posted PR review comments to the `pr-reviews.db` database. Tracks comments posted by `/pr-review` and `/refine-review` for past-cycle verification on subsequent runs.

| Argument | Type | Required | Description |
|---|---|---|---|
| `JSON_FILE` | string | yes | Path to JSON file with review data |

```bash
myk-pi-tools pr store-pr-review comments.json
```

**Input JSON format:**

```json
{
  "metadata": {
    "owner": "myk-org",
    "repo": "pi-config",
    "pr_number": 42,
    "head_sha": "abc123..."
  },
  "comments": [
    {
      "thread_id": "...",
      "comment_id": 123,
      "path": "file.py",
      "line": 42,
      "body": "Comment text",
      "severity": "WARNING",
      "posted_at": "2026-06-16T12:00:00Z"
    }
  ]
}
```

**Effect:** Inserts the review and all comments into `.pi/data/pr-reviews.db`. If `head_sha` is not provided in metadata, it is auto-detected from the local git HEAD.

**Database schema:** Two tables — `pr_reviews` (PR metadata with head SHA and timestamp) and `pr_comments` (individual comments with thread ID, path, line, body, severity, and posting timestamp).

### `pr post-comment`

Post inline comments to a PR as a single GitHub review with a summary table.

| Argument | Type | Required | Description |
|---|---|---|---|
| `OWNER_REPO` | string | yes | Repository in `owner/repo` format |
| `PR_NUMBER` | string | yes | Pull request number |
| `COMMIT_SHA` | string | yes | The 40-character SHA of the commit to comment on |
| `JSON_FILE` | string | yes | Path to JSON file with comments, or `"-"` for stdin |

```bash
myk-pi-tools pr post-comment myk-org/pi-config 42 abc123def456... comments.json
cat comments.json | myk-pi-tools pr post-comment myk-org/pi-config 42 abc123def456... -
```

**Input JSON format:**

```json
[
  {
    "path": "src/main.py",
    "line": 42,
    "body": "### [CRITICAL] SQL Injection\n\nDescription..."
  },
  {
    "path": "src/utils.py",
    "line": 15,
    "body": "### [WARNING] Missing error handling\n\nDescription..."
  }
]
```

**Severity markers:** The review summary table auto-categorizes comments by severity prefix in the `body`:

| Prefix | Severity |
|---|---|
| `### [CRITICAL]` | Critical issue |
| `### [WARNING]` | Warning |
| `### [SUGGESTION]` | Suggestion (default) |

**Output:** JSON result with `status`, `comment_count`, `posted`, and `failed` arrays.

> **Tip:** Only lines that were modified or added in the PR can receive inline comments. Comments on unchanged lines will fail.

---

## `release`

GitHub release commands. See [Common Workflow Recipes](workflow-recipes.html) for end-to-end release workflows.

### `release info`

Fetch release validation info and commits since last tag. Outputs JSON to stdout.

| Option | Type | Default | Description |
|---|---|---|---|
| `--repo` | string | auto-detected from git context | Repository in `owner/repo` format |
| `--target` | string | auto-detected default branch | Target branch for release |
| `--tag-match` | string | none | Glob pattern to filter tags (e.g., `v2.10.*`) |

```bash
# Auto-detect everything
myk-pi-tools release info

# Specify repo
myk-pi-tools release info --repo myk-org/pi-config

# Filter tags for a version branch
myk-pi-tools release info --target v2.10 --tag-match "v2.10.*"
```

**Validations performed:**
- On target branch check
- Clean working tree check
- Remote sync check (fetch, unpushed/behind counts)

**Version branch auto-detection:** If the current branch matches `vMAJOR.MINOR` (e.g., `v2.10`), the command automatically sets the target and tag-match pattern.

**Commit filtering:** Merge commits, "address review" commits, "chore: checkpoint/bump version" commits, and similar noise are automatically excluded from the output.

**Output:** JSON with `metadata`, `validations`, `last_tag`, `all_tags`, `commits`, `commit_count`, `is_first_release`, `target_branch`, and `tag_match`.

### `release create`

Create a GitHub release.

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `OWNER_REPO` | argument | yes | — | Repository in `owner/repo` format |
| `TAG` | argument | yes | — | Release tag (e.g., `v1.3.0`) |
| `CHANGELOG_FILE` | argument | yes | — | Path to file containing release notes |
| `--prerelease` | flag | no | `false` | Mark as pre-release |
| `--draft` | flag | no | `false` | Create as draft |
| `--target` | string | no | — | Target branch for the release |
| `--title` | string | no | tag name | Release title |

```bash
myk-pi-tools release create myk-org/pi-config v1.3.0 CHANGELOG.md
myk-pi-tools release create myk-org/pi-config v2.0.0-rc1 notes.md --prerelease --draft
myk-pi-tools release create myk-org/pi-config v1.3.0 CHANGELOG.md --target main --title "Release 1.3.0"
```

**Output:** JSON with `status`, `tag`, `url`, `prerelease`, and `draft` on success. JSON with `status` and `error` on failure.

> **Warning:** Tags that don't follow semantic versioning (`vX.Y.Z`) trigger a warning but are still accepted.

### `release detect-versions`

Detect version files in the current repository. Scans for well-known version file patterns.

```bash
myk-pi-tools release detect-versions
```

**Supported file types:**

| File | Type Key | Parser |
|---|---|---|
| `pyproject.toml` | `pyproject` | `[project].version` |
| `package.json` | `package_json` | `version` field |
| `setup.cfg` | `setup_cfg` | `[metadata].version` |
| `Cargo.toml` | `cargo` | `[package].version` |
| `build.gradle` / `build.gradle.kts` | `gradle` | `version = "..."` |
| `*/__init__.py`, `*/version.py` | `python_version` | `__version__ = "..."` |

**Output:** JSON with `version_files` array (each with `path`, `current_version`, `type`) and `count`.

> **Note:** Directories like `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `build`, and others are automatically excluded from scanning.

### `release bump-version`

Update version strings in detected version files. Does not perform any git operations.

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `VERSION` | argument | yes | — | New version string (e.g., `1.2.0`) |
| `--files` | string (repeatable) | no | all detected | Specific files to update |

```bash
# Update all detected version files
myk-pi-tools release bump-version 1.3.0

# Update specific files only
myk-pi-tools release bump-version 1.3.0 --files pyproject.toml --files package.json
```

> **Warning:** The version must NOT start with `v` or `V`. Use `1.3.0`, not `v1.3.0`.

**Output:** JSON with `status`, `version`, `updated` array (with `path`, `old_version`, `new_version`), and `skipped` array.

**Effect:** Writes are atomic (temp file + rename) to prevent corruption.

---

## `reviews`

Review handling commands for the automated review workflow. See [Running the Automated Code Review Loop](code-review-loop.html) for the full workflow.

### `reviews fetch`

Fetch review threads from the current branch's PR.

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `REVIEW_URL` | string | no | `""` | Specific review URL for context (e.g., `#pullrequestreview-XXX`) |
| `--include-resolved` | flag | no | `false` | Include resolved threads (adds `is_resolved` field to output) |
| `--user` | string | no | none | Filter threads by author username |
| `--output-dir` | string | yes | — | Directory for output JSON file |

```bash
myk-pi-tools reviews fetch --output-dir /tmp/pi-work
myk-pi-tools reviews fetch "#pullrequestreview-12345" --output-dir /tmp/pi-work
myk-pi-tools reviews fetch --include-resolved --output-dir /tmp/pi-work
myk-pi-tools reviews fetch --user coderabbitai --output-dir /tmp/pi-work
```

**Output:** JSON saved to `<output-dir>/pr-<number>-reviews.json` with structure:

```json
{
  "metadata": { "owner": "...", "repo": "...", "pr_number": "..." },
  "human": [ ... ],
  "qodo": [ ... ],
  "coderabbit": [ ... ]
}
```

Comments are auto-categorized by source based on author username. Each comment includes `thread_id`, `node_id`, `comment_id`, `path`, `line`, `body`, and `priority`.

**Exit codes:** `0` = success, non-zero = failure.

### `reviews poll`

Poll for reviews until new actionable comments appear. Loops internally — does not return on "no new comments."

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `REVIEW_URL` | string | no | `""` | Specific review URL for context |
| `--source` | choice | no | `coderabbit` | Which reviewer to poll for: `coderabbit` or `qodo` |
| `--output-dir` | string | yes | — | Directory for output JSON file |

```bash
myk-pi-tools reviews poll --output-dir /tmp/pi-work
myk-pi-tools reviews poll --source qodo --output-dir /tmp/pi-work
myk-pi-tools reviews poll "#pullrequestreview-12345" --source coderabbit --output-dir /tmp/pi-work
```

**Behavior by source:**

| Source | Behavior |
|---|---|
| `coderabbit` | Checks approval status, handles rate limits (auto-waits + re-triggers), polls until actionable comments appear |
| `qodo` | Fetches and checks for new Qodo comments (no rate limit handling) |

**Output:** Returns `{"approved": true}` if CodeRabbit approved the PR, otherwise returns the fetch JSON.

### `reviews post`

Post replies and resolve review threads from a processed JSON file.

| Argument | Type | Required | Description |
|---|---|---|---|
| `JSON_PATH` | string | yes | Path to JSON file with review data (created by `fetch`, processed by AI) |

```bash
myk-pi-tools reviews post /tmp/pi-work/pr-42-reviews.json
```

**Status handling:**

| Status | Action |
|---|---|
| `addressed` | Post reply and resolve thread |
| `not_addressed` | Post reply and resolve thread |
| `skipped` | Post reply with skip reason, resolve thread (bot sources only; human threads are not resolved) |
| `pending` | Skip (not processed yet) |
| `failed` | Retry posting |

**Effect:** Updates the JSON file with `posted_at` timestamps after successful posting.

### `reviews pending-fetch`

Fetch the authenticated user's pending (unsubmitted) review comments from a PR.

| Argument/Option | Type | Required | Description |
|---|---|---|---|
| `PR_URL` | string | yes | GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`) |
| `--output-dir` | string | yes | Directory for output JSON file |

```bash
myk-pi-tools reviews pending-fetch https://github.com/myk-org/pi-config/pull/42 --output-dir /tmp/pi-work
```

**Output:** JSON saved to `<output-dir>/pr-<owner>-<repo>-<number>-pending-review.json` with `metadata` and `comments` arrays.

### `reviews pending-update`

Update pending review comment bodies and optionally submit the review.

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `JSON_PATH` | argument | yes | — | Path to JSON file with pending review data |
| `--submit` | flag | no | `false` | Submit the review after updating comments |

```bash
# Update comment bodies only
myk-pi-tools reviews pending-update /tmp/pi-work/pr-42-pending-review.json

# Update and submit
myk-pi-tools reviews pending-update /tmp/pi-work/pr-42-pending-review.json --submit
```

**Comment status handling:**
- `accepted`: Update comment body with `refined_body`
- Other statuses: Skip (no update)

**Submit action:** When `--submit` is set, uses the `submit_action` field from the JSON metadata (`COMMENT`, `APPROVE`, or `REQUEST_CHANGES`).

### `reviews status`

Show review status for the current PR. Queries the reviews database and displays all comments across all review cycles.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | no | auto-detected from current branch | PR number |
| `--output-dir` | string | yes | — | Directory for output HTML report |

```bash
myk-pi-tools reviews status --output-dir /tmp/pi-work
myk-pi-tools reviews status --pr 42 --output-dir /tmp/pi-work
```

**Output:** TUI table to stdout and an HTML report saved to `<output-dir>/review-status-<pr>.html`.

### `reviews store`

Store a completed review JSON to the SQLite database for analytics.

| Argument | Type | Required | Description |
|---|---|---|---|
| `JSON_PATH` | string | yes | Path to the completed review JSON file |

```bash
myk-pi-tools reviews store /tmp/pi-work/pr-42-reviews.json
```

**Effect:** Inserts the review and all comments into `.pi/data/reviews.db`. The JSON file is deleted after successful storage.

**Database schema:** Two tables — `reviews` (PR metadata) and `comments` (individual review comments with source, status, reply, priority, timestamps).

---

## `db`

Review database query commands. Operates on the SQLite database at `<git-root>/.pi/data/reviews.db`.

All subcommands support `--db-path` to override the default database location and `--json` for JSON output.

### `db stats`

Get review statistics.

| Option | Type | Default | Description |
|---|---|---|---|
| `--by-source` | flag | `true` (default when neither flag set) | Group by source (human/qodo/coderabbit) |
| `--by-reviewer` | flag | `false` | Group by reviewer author |
| `--json` | flag | `false` | Output as JSON |
| `--db-path` | string | auto-detected | Path to database file |

```bash
myk-pi-tools db stats
myk-pi-tools db stats --by-reviewer
myk-pi-tools db stats --by-source --json
```

> **Warning:** `--by-source` and `--by-reviewer` are mutually exclusive.

**Output columns (by-source):** `source`, `total`, `addressed`, `not_addressed`, `skipped`, `addressed_rate`
**Output columns (by-reviewer):** `author`, `total`, `addressed`, `not_addressed`, `skipped`

### `db patterns`

Find recurring dismissed patterns. Identifies comments that appear multiple times with similar content.

| Option | Type | Default | Description |
|---|---|---|---|
| `--min` | integer | `2` | Minimum occurrences to report |
| `--json` | flag | `false` | Output as JSON |
| `--db-path` | string | auto-detected | Path to database file |

```bash
myk-pi-tools db patterns
myk-pi-tools db patterns --min 3
myk-pi-tools db patterns --json
```

**Output columns:** `path`, `occurrences`, `reason`, `body_sample`

### `db dismissed`

Get dismissed comments for a repository.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `--owner` | string | yes | — | Repository owner (org or user) |
| `--repo` | string | yes | — | Repository name |
| `--json` | flag | no | `false` | Output as JSON |
| `--db-path` | string | no | auto-detected | Path to database file |

```bash
myk-pi-tools db dismissed --owner myk-org --repo pi-config
myk-pi-tools db dismissed --owner myk-org --repo pi-config --json
```

**Output columns:** `path`, `line`, `status`, `reply`, `author`

### `db query`

Run a raw SELECT query against the reviews database.

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `SQL` | argument | yes | — | SQL SELECT statement |
| `--json` | flag | no | `false` | Output as JSON |
| `--db-path` | string | no | auto-detected | Path to database file |

> **Warning:** Only `SELECT` and `WITH` (CTE) statements are allowed. Other SQL statements are rejected. Multiple statements (separated by `;`) are also blocked.

```bash
myk-pi-tools db query "SELECT * FROM comments WHERE status = 'skipped'"
myk-pi-tools db query "SELECT status, COUNT(*) as cnt FROM comments GROUP BY status"
myk-pi-tools db query "WITH recent AS (SELECT * FROM comments ORDER BY posted_at DESC LIMIT 10) SELECT * FROM recent"
myk-pi-tools db query "SELECT * FROM comments LIMIT 5" --json
```

### `db find-similar`

Find a previously dismissed comment matching a path and body. Uses exact path match combined with body similarity (Jaccard word overlap). Reads JSON from stdin.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `--owner` | string | yes | — | Repository owner |
| `--repo` | string | yes | — | Repository name |
| `--threshold` | float | no | `0.6` | Minimum similarity threshold (0.0–1.0) |
| `--json` | flag | no | `false` | Output as JSON |
| `--db-path` | string | no | auto-detected | Path to database file |

**Input:** JSON from stdin with `path` and `body` fields.

```bash
echo '{"path": "foo.py", "body": "Add error handling..."}' | \
    myk-pi-tools db find-similar --owner myk-org --repo pi-config --json
```

**Output:** Matching comment with `similarity` score, `path`, `line`, `status`, `reply`, and `body`; or "No similar comment found."

---

## `coderabbit`

CodeRabbit rate limit and review trigger commands.

### `coderabbit check`

Check if CodeRabbit is rate-limited on a PR.

| Argument | Type | Required | Description |
|---|---|---|---|
| `OWNER_REPO` | string | yes | Repository in `owner/repo` format |
| `PR_NUMBER` | integer | yes | Pull request number |

```bash
myk-pi-tools coderabbit check myk-org/pi-config 42
```

**Output:** JSON with rate limit status and wait time.

### `coderabbit trigger`

Wait and trigger a CodeRabbit review on a PR. Posts `@coderabbitai review` and polls until the review starts (max 10 minutes).

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `OWNER_REPO` | argument | yes | — | Repository in `owner/repo` format |
| `PR_NUMBER` | integer | yes | — | Pull request number |
| `--wait` | integer | no | `0` | Seconds to wait before posting review trigger |

```bash
myk-pi-tools coderabbit trigger myk-org/pi-config 42
myk-pi-tools coderabbit trigger myk-org/pi-config 42 --wait 120
```

**Effect:** Optionally waits the specified seconds, then posts a `@coderabbitai review` comment. Polls every 60 seconds (up to 10 attempts) until the review begins.

---

## `ai-cli`

AI CLI commands for routing prompts to external AI agents (Cursor, Claude, Gemini). Wraps the [`ai-cli-runner`](https://pypi.org/project/ai-cli-runner/) package. See [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html) for workflows.

### `ai-cli run`

Run a prompt via an external AI CLI provider.

| Argument/Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `PROMPT` | argument | yes | — | The prompt text to send |
| `-p`, `--provider` | choice | yes | — | AI provider: `cursor`, `claude`, `gemini` |
| `-m`, `--model` | string | no | provider default | Model name (e.g., `gpt-5.4-high`) |
| `--resume` | flag | no | `false` | Continue the most recent session |
| `--session-id` | string | no | — | Resume a specific session by ID |
| `--cwd` | string | no | current directory | Working directory |
| `--cli-flags` | string (repeatable) | no | — | Extra CLI flags (e.g., `--cli-flags=--trust`) |

**Default models per provider:**

| Provider | Default Model |
|---|---|
| `cursor` | `composer-2-fast` |
| `claude` | `claude-sonnet-4-6` |
| `gemini` | `gemini-2.5-flash` |

> **Warning:** `--session-id` and `--resume` are mutually exclusive.

```bash
myk-pi-tools ai-cli run "Review this code for bugs" -p claude
myk-pi-tools ai-cli run "Refactor the auth module" -p cursor -m gpt-5.4-high
myk-pi-tools ai-cli run "Continue the previous task" -p gemini --resume
myk-pi-tools ai-cli run "Fix tests" -p claude --session-id abc123
myk-pi-tools ai-cli run "Review code" -p cursor --cli-flags=--trust --cli-flags=--verbose
```

**Output:** JSON to stdout with `success`, `provider`, `model`, `text` (response), `session_id`, and `usage` (token counts, cost). On failure: `success: false` with `error` field.

### `ai-cli save-config`

Save agent/peer configuration for the `/external-ai` slash command. Persists to `.pi/external-ai-config.json`.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `--agents` | string | no* | — | Save `lastAgents` value (e.g., `cursor --model gpt-5.4-high`) |
| `--peers` | string | no* | — | Save `lastPeers` value (e.g., `cursor,claude`) |

*At least one of `--agents` or `--peers` must be provided.

```bash
myk-pi-tools ai-cli save-config --agents "cursor --model gpt-5.4-high"
myk-pi-tools ai-cli save-config --peers "cursor,claude"
myk-pi-tools ai-cli save-config --agents "gemini" --peers "cursor,claude"
```

**Effect:** Merges into `.pi/external-ai-config.json`. Each option updates only its field — the other is preserved. Outputs the saved config JSON to stdout.

### `ai-cli models`

List available models for a provider.

| Argument | Type | Required | Description |
|---|---|---|---|
| `PROVIDER` | choice | yes | AI provider: `cursor`, `claude`, `gemini` |

```bash
myk-pi-tools ai-cli models cursor
myk-pi-tools ai-cli models claude
myk-pi-tools ai-cli models gemini
```

**Output:** JSON array of model name strings to stdout.

---

## Exit Codes

All subcommands follow a consistent pattern:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (missing dependencies, invalid arguments, API failure) |

Commands that output JSON include a `status` or `success` field in the response that mirrors the exit code.

---

## Environment and Prerequisites

| Dependency | Required By | Purpose |
|---|---|---|
| `gh` (GitHub CLI) | `pr`, `release`, `reviews`, `coderabbit`, `db` | GitHub API access |
| `git` | `release info`, `memory`, `db` | Repository context detection |
| `ai-cli-runner` | `ai-cli` | External AI CLI abstraction |

> **Tip:** All dependencies are pre-installed in the pi-config Docker image. See [Running Pi in a Docker Container](docker-deployment.html) for details.

## Related Pages

- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Common Workflow Recipes](workflow-recipes.html)
- [Using External AI Agents (Cursor, Claude, Gemini)](external-ai-agents.html)
- [Working with Project Memory](memory-system.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
