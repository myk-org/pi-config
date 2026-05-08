# CLI Command Reference

The `myk-pi-tools` CLI provides subcommands for PR review management, GitHub releases, project memory, CodeRabbit integration, and review database analytics.

```
myk-pi-tools [OPTIONS] COMMAND [SUBCOMMAND] [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--version` | Show the CLI version and exit |
| `--help` | Show help message and exit |

> **Note:** Most commands that interact with GitHub require the GitHub CLI (`gh`) to be installed and authenticated. See Installation & Setup for prerequisites.

---

## db

Review database query commands. All subcommands read from a SQLite database stored at `<git-root>/.pi/data/reviews.db`.

### db stats

Get review statistics grouped by source or reviewer.

```
myk-pi-tools db stats [OPTIONS]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--by-source` | flag | `false` | Group statistics by source (human/qodo/coderabbit) |
| `--by-reviewer` | flag | `false` | Group statistics by reviewer author |
| `--json` | flag | `false` | Output as JSON instead of formatted table |
| `--db-path` | string | auto-detect | Path to database file |

> **Note:** If neither `--by-source` nor `--by-reviewer` is specified, defaults to `--by-source`. Specifying both is an error.

```bash
# Stats by source (default)
myk-pi-tools db stats

# Stats by reviewer
myk-pi-tools db stats --by-reviewer

# JSON output
myk-pi-tools db stats --by-source --json
```

### db patterns

Find recurring dismissed patterns in review comments. Identifies comments that appear multiple times with similar content, suggesting candidates for auto-skip rules.

```
myk-pi-tools db patterns [OPTIONS]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--min` | integer | `2` | Minimum occurrences to report |
| `--json` | flag | `false` | Output as JSON |
| `--db-path` | string | auto-detect | Path to database file |

```bash
# Find patterns with at least 2 occurrences (default)
myk-pi-tools db patterns

# Find patterns with at least 3 occurrences
myk-pi-tools db patterns --min 3

# JSON output
myk-pi-tools db patterns --json
```

### db dismissed

Get all dismissed (not_addressed or skipped) comments for a specific repository.

```
myk-pi-tools db dismissed --owner OWNER --repo REPO [OPTIONS]
```

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `--owner` | string | — | yes | Repository owner (org or user) |
| `--repo` | string | — | yes | Repository name |
| `--json` | flag | `false` | no | Output as JSON |
| `--db-path` | string | auto-detect | no | Path to database file |

```bash
# Get dismissed comments
myk-pi-tools db dismissed --owner myk-org --repo pi-config

# JSON output
myk-pi-tools db dismissed --owner myk-org --repo pi-config --json
```

### db query

Run a raw SQL query on the review database. Only `SELECT` statements are allowed.

```
myk-pi-tools db query SQL [OPTIONS]
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `SQL` | string | yes | SQL query string (SELECT only) |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | flag | `false` | Output as JSON |
| `--db-path` | string | auto-detect | Path to database file |

```bash
# Get all skipped comments
myk-pi-tools db query "SELECT * FROM comments WHERE status = 'skipped'"

# Count by status
myk-pi-tools db query "SELECT status, COUNT(*) as cnt FROM comments GROUP BY status"

# JSON output
myk-pi-tools db query "SELECT * FROM comments LIMIT 5" --json
```

### db find-similar

Find a previously dismissed comment matching path and body similarity. Reads JSON input from stdin.

```
myk-pi-tools db find-similar --owner OWNER --repo REPO [OPTIONS] < input.json
```

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `--owner` | string | — | yes | Repository owner (org or user) |
| `--repo` | string | — | yes | Repository name |
| `--threshold` | float | `0.6` | no | Minimum similarity threshold (0.0–1.0) |
| `--json` | flag | `false` | no | Output as JSON |
| `--db-path` | string | auto-detect | no | Path to database file |

**Stdin input format:**

```json
{"path": "foo.py", "body": "Add error handling..."}
```

```bash
echo '{"path": "foo.py", "body": "Add error handling..."}' | \
    myk-pi-tools db find-similar --owner myk-org --repo pi-config --json
```

---

## memory

Project memory commands for persistent per-repo learning. The memory file is a Markdown file stored at `<git-root>/.pi/memory/memory.md` by default.

```
myk-pi-tools memory [OPTIONS] SUBCOMMAND
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--file-path` | string | auto-detect | Path to memory file |

### memory add

Add a memory entry to the Learned or Pinned section.

```
myk-pi-tools memory add -c CATEGORY -s SUMMARY [OPTIONS]
```

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `-c`, `--category` | choice | — | yes | Memory category: `lesson`, `decision`, `mistake`, `pattern`, `done`, `preference` |
| `-s`, `--summary` | string | — | yes | Short one-line description |
| `--pinned` | flag | `false` | no | Add to Pinned section (protected from auto-removal) |

```bash
# Add a learned memory
myk-pi-tools memory add -c lesson -s "buildah chown -R skips target dir"

# Add a pinned memory (never auto-removed)
myk-pi-tools memory add -c preference -s "Always use uv run" --pinned
```

### memory show

Display the memory file contents.

```
myk-pi-tools memory show
```

### memory migrate

One-time migration from SQLite database to memory.md. Reads all memories from `memories.db`, writes them to `memory.md`, then deletes the database.

```
myk-pi-tools memory migrate
```

### memory path

Print the resolved memory file path.

```
myk-pi-tools memory path
```

---

## pr

PR review and management commands.

### pr diff

Fetch PR diff and metadata as JSON.

```
myk-pi-tools pr diff [ARGS]
```

Accepts three input forms:

| Form | Example |
|------|---------|
| Owner/repo + PR number | `pr diff myk-org/pi-config 42` |
| GitHub URL | `pr diff https://github.com/myk-org/pi-config/pull/42` |
| PR number (from git context) | `pr diff 42` |

**Output:** JSON object with `metadata`, `diff`, and `files` fields.

```json
{
  "metadata": {
    "owner": "myk-org",
    "repo": "pi-config",
    "pr_number": "42",
    "head_sha": "abc123...",
    "base_ref": "main",
    "title": "Add feature X",
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

```bash
myk-pi-tools pr diff myk-org/pi-config 42
```

### pr claude-md

Fetch CLAUDE.md and AGENTS.md content from a PR's repository. Checks both root and config directories (`.claude/`, `.agents/`) locally and via the GitHub API.

```
myk-pi-tools pr claude-md [ARGS]
```

Accepts the same input forms as `pr diff`.

**Searched locations (in order):**
1. `./CLAUDE.md`
2. `./.claude/CLAUDE.md`
3. `./AGENTS.md`
4. `./.agents/AGENTS.md`
5. Remote equivalents via GitHub API

```bash
myk-pi-tools pr claude-md myk-org/pi-config 42
```

### pr post-comment

Post inline comments to a PR as a single GitHub review with a summary table.

```
myk-pi-tools pr post-comment OWNER_REPO PR_NUMBER COMMIT_SHA JSON_FILE
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `OWNER_REPO` | string | yes | Repository in `owner/repo` format |
| `PR_NUMBER` | string | yes | Pull request number |
| `COMMIT_SHA` | string | yes | Full 40-character SHA of the commit to comment on |
| `JSON_FILE` | string | yes | Path to JSON file, or `-` for stdin |

**JSON input format:**

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

**Severity markers** (parsed from comment body):

| Marker | Meaning |
|--------|---------|
| `### [CRITICAL] Title` | Critical security or functionality issues |
| `### [WARNING] Title` | Important but non-critical issues |
| `### [SUGGESTION] Title` | Code improvements (default if no marker) |

**Output:** JSON with `status`, `comment_count`, `posted`, `failed`, and optionally `error`.

```bash
myk-pi-tools pr post-comment myk-org/pi-config 42 abc123def456... comments.json

# From stdin
cat comments.json | myk-pi-tools pr post-comment myk-org/pi-config 42 abc123def456... -
```

> **Warning:** Only lines that were modified or added in the PR diff can receive inline comments. The commit SHA must be the HEAD of the PR.

---

## release

GitHub release commands for version management and release creation.

### release info

Fetch release validation info and commits since the last tag. Auto-detects repository from git context.

```
myk-pi-tools release info [OPTIONS]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--repo` | string | auto-detect | Repository in `owner/repo` format |
| `--target` | string | auto-detect | Target branch for release |
| `--tag-match` | string | auto-detect | Glob pattern to filter tags (e.g., `v2.10.*`) |

**Validations performed:**
- On target branch
- Clean working tree
- Synced with remote (no unpushed or behind commits)

**Output:** JSON with `metadata`, `validations`, `last_tag`, `all_tags`, `commits`, `commit_count`, `is_first_release`, `target_branch`, and `tag_match`.

> **Tip:** On a version branch like `v2.10`, the command auto-detects `--target v2.10` and `--tag-match v2.10.*`.

**Commit filtering:** The following are excluded from the commit list:
- Merge commits
- CodeRabbit-related commits
- Checkpoint and version bump chores
- Doc regeneration and pre-commit autoupdates

```bash
# Auto-detect everything from git context
myk-pi-tools release info

# Explicit repository and target
myk-pi-tools release info --repo myk-org/pi-config --target main

# Filter tags for a specific version line
myk-pi-tools release info --tag-match "v2.10.*"
```

### release create

Create a GitHub release.

```
myk-pi-tools release create OWNER_REPO TAG CHANGELOG_FILE [OPTIONS]
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `OWNER_REPO` | string | yes | Repository in `owner/repo` format |
| `TAG` | string | yes | Release tag (e.g., `v1.3.0`) |
| `CHANGELOG_FILE` | string | yes | Path to file containing release notes |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--prerelease` | flag | `false` | Mark as pre-release |
| `--draft` | flag | `false` | Create as draft release |
| `--target` | string | — | Target branch for the release |
| `--title` | string | tag name | Release title |

**Output:** JSON with `status`, `tag`, `url`, `prerelease`, and `draft` on success; `status` and `error` on failure.

> **Note:** A warning is emitted to stderr if the tag does not follow semantic versioning format (`vX.Y.Z`).

```bash
myk-pi-tools release create myk-org/pi-config v1.3.0 changelog.md

myk-pi-tools release create myk-org/pi-config v2.0.0-rc1 notes.md \
    --prerelease --target release/v2
```

### release detect-versions

Detect version files in the current repository across multiple ecosystems.

```
myk-pi-tools release detect-versions
```

**Detected file types:**

| File | Ecosystem | Type key |
|------|-----------|----------|
| `pyproject.toml` | Python | `pyproject` |
| `package.json` | Node.js | `package_json` |
| `setup.cfg` | Python | `setup_cfg` |
| `Cargo.toml` | Rust | `cargo` |
| `build.gradle` / `build.gradle.kts` | JVM | `gradle` |
| `__init__.py` / `version.py` with `__version__` | Python | `python_version` |

**Output:**

```json
{
  "version_files": [
    {"path": "pyproject.toml", "current_version": "2.2.0", "type": "pyproject"}
  ],
  "count": 1
}
```

```bash
myk-pi-tools release detect-versions
```

### release bump-version

Update version strings in detected version files. Uses atomic writes to prevent file corruption.

```
myk-pi-tools release bump-version VERSION [OPTIONS]
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `VERSION` | string | yes | New version string (e.g., `1.2.0`) |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--files` | string (multiple) | all detected | Specific files to update (can be repeated) |

> **Warning:** The version must not start with `v`. Use `1.2.0`, not `v1.2.0`.

**Output:** JSON with `status`, `version`, `updated` (list of `{path, old_version, new_version}`), and `skipped` (list of `{path, reason}`).

```bash
# Update all detected version files
myk-pi-tools release bump-version 1.3.0

# Update specific files only
myk-pi-tools release bump-version 1.3.0 --files pyproject.toml --files package.json
```

---

## reviews

Review handling commands for fetching, responding to, and storing PR review threads.

### reviews fetch

Fetch all unresolved review threads from the current branch's PR. Categorizes comments by source (human, qodo, coderabbit) and classifies priority.

```
myk-pi-tools reviews fetch [REVIEW_URL]
```

| Argument | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `REVIEW_URL` | string | `""` | no | Specific review URL for context (e.g., `#pullrequestreview-XXX` or `#discussion_rXXX`) |

**Output:** Saved to `/tmp/pi-work/pr-<number>-reviews.json`.

```bash
# Fetch all unresolved reviews
myk-pi-tools reviews fetch

# Fetch with a specific review URL context
myk-pi-tools reviews fetch "#pullrequestreview-12345"
```

### reviews poll

Poll for reviews with automatic CodeRabbit rate limit handling. Combines rate limit check, trigger, and fetch into a single atomic operation. Loops internally until actionable comments are found.

```
myk-pi-tools reviews poll [REVIEW_URL]
```

| Argument | Type | Default | Required | Description |
|----------|------|---------|----------|-------------|
| `REVIEW_URL` | string | `""` | no | Specific review URL for context |

**Output:** Same format as `reviews fetch` (saved to `/tmp/pi-work/pr-<number>-reviews.json`).

```bash
myk-pi-tools reviews poll
```

### reviews post

Post replies to review threads and resolve them based on status.

```
myk-pi-tools reviews post JSON_PATH
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `JSON_PATH` | string | yes | Path to JSON file created by `reviews fetch` (processed by AI handler) |

Updates the JSON file with `posted_at` timestamps after posting.

```bash
myk-pi-tools reviews post /tmp/pi-work/pr-42-reviews.json
```

### reviews pending-fetch

Fetch the authenticated user's pending (unpublished) review comments from a PR.

```
myk-pi-tools reviews pending-fetch PR_URL
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `PR_URL` | string | yes | GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`) |

**Output:** Saved to `/tmp/pi-work/pr-<number>-pending-review.json`.

```bash
myk-pi-tools reviews pending-fetch https://github.com/myk-org/pi-config/pull/42
```

### reviews pending-update

Update pending review comment bodies and optionally submit the review.

```
myk-pi-tools reviews pending-update JSON_PATH [OPTIONS]
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `JSON_PATH` | string | yes | Path to JSON file created by `reviews pending-fetch` |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--submit` | flag | `false` | Submit the review after updating comments |

```bash
# Update comments only
myk-pi-tools reviews pending-update /tmp/pi-work/pr-42-pending-review.json

# Update and submit
myk-pi-tools reviews pending-update /tmp/pi-work/pr-42-pending-review.json --submit
```

### reviews store

Store a completed review to the SQLite database for analytics. Deletes the JSON file after successful storage.

```
myk-pi-tools reviews store JSON_PATH
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `JSON_PATH` | string | yes | Path to the completed review JSON file |

**Database location:** `<git-root>/.pi/data/reviews.db`

```bash
myk-pi-tools reviews store /tmp/pi-work/pr-42-reviews.json
```

> **Tip:** Use `db stats` and `db patterns` to analyze data stored by this command. See Review Database & Analytics for details.

---

## coderabbit

Commands for managing CodeRabbit automated reviews.

### coderabbit check

Check if CodeRabbit is rate limited on a PR.

```
myk-pi-tools coderabbit check OWNER_REPO PR_NUMBER
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `OWNER_REPO` | string | yes | Repository in `owner/repo` format |
| `PR_NUMBER` | integer | yes | Pull request number |

**Output:** JSON with rate limit status.

```json
{"rate_limited": false}
```

```json
{"rate_limited": true, "wait_seconds": 90, "comment_id": 12345}
```

```bash
myk-pi-tools coderabbit check myk-org/pi-config 42
```

### coderabbit trigger

Wait an optional duration, then trigger a CodeRabbit review on a PR by posting `@coderabbitai review`. Polls until the review starts (max 10 minutes, 60-second intervals).

```
myk-pi-tools coderabbit trigger OWNER_REPO PR_NUMBER [OPTIONS]
```

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `OWNER_REPO` | string | yes | Repository in `owner/repo` format |
| `PR_NUMBER` | integer | yes | Pull request number |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--wait` | integer | `0` | Seconds to wait before posting the review trigger |

```bash
# Trigger immediately
myk-pi-tools coderabbit trigger myk-org/pi-config 42

# Wait 90 seconds then trigger
myk-pi-tools coderabbit trigger myk-org/pi-config 42 --wait 90
```

---

## Exit Codes

All commands use the following exit code conventions:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (invalid input, API failure, missing dependencies) |

Error details are printed to stderr. JSON output goes to stdout.

---

## Environment and Dependencies

| Dependency | Required for |
|------------|-------------|
| `gh` (GitHub CLI) | All commands that interact with GitHub (pr, release, reviews, coderabbit) |
| `git` | Repository detection, branch info, commit history, release validation |

See Installation & Setup for installation instructions.
