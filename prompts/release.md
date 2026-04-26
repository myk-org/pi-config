---
description: Create a GitHub release with automatic changelog generation
argument-hint: "[version]"
---

## Raw Arguments

```text
$ARGUMENTS
```

# GitHub Release Command

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

Creates a GitHub release with automatic changelog generation based on conventional commits.
Optionally detects and updates version files before creating the release.

## Prerequisites Check (MANDATORY)

### Step 1: Check myk-pi-tools

```bash
myk-pi-tools --version
```

If not found, prompt to install: `uv tool install myk-pi-tools`

## Usage

- `/release` - Normal release (auto-detect version bump)
- `/release 1.17.1` - Release with explicit version (skip approval)
- `/release --dry-run` - Preview without creating
- `/release --prerelease` - Create prerelease
- `/release --draft` - Create draft release

## Workflow

### Phase 1: Validation

If `--target <branch>` was passed to the release command:

```bash
myk-pi-tools release info --target <branch>
```

If `--tag-match <pattern>` was also passed:

```bash
myk-pi-tools release info --target <branch> --tag-match <pattern>
```

Otherwise (auto-detect from current branch):

```bash
myk-pi-tools release info
```

Note: If on a version branch (e.g., `v2.10`), the command auto-detects the target
and filters tags to that version range. No `--target` flag needed.

Check validations:

- Must be on default branch (or target branch if `--target` specified, or auto-detected version branch like `v2.10`)
- Working tree must be clean
- Must be synced with remote

### Phase 2: Version Detection

```bash
myk-pi-tools release detect-versions
```

Parse the JSON output. If version files are found, store them for Phase 4.
If no version files are detected, skip version bumping phases and continue normally.

Store the detect-versions JSON output for use in Phase 4. The key fields are:

- `version_files[].path` -- file path relative to repo root
- `version_files[].current_version` -- current version string
- `count` -- number of detected files (0 means skip version bumping)

### Phase 3: Changelog Analysis & Version

Parse commits from Phase 1 output and categorize by conventional commit type:

- Breaking Changes → MAJOR
- Features (`feat:`) → MINOR
- Bug Fixes (`fix:`), Docs (`docs:`), Maintenance (`chore:`, `refactor:`, `test:`, `ci:`) → PATCH

**Changelog formatting rules (MANDATORY):**

1. **Use standardized emoji section headers:**
   - `### ⚠️ Breaking Changes`
   - `### ✨ Features`
   - `### 🐛 Bug Fixes`
   - `### 🏗️ Architecture`
   - `### 📚 Documentation`
   - `### 🔧 Maintenance`

2. **Always use PR/issue references, never commit hashes:**
   - ✅ `- **Feature name** — description (#42)`
   - ❌ `- Feature name (c958777)`
   - Extract PR number from merge commit messages or commit body
   - Only fall back to commit hash if absolutely no PR/issue reference exists

3. **Each entry needs a bold title + description:**
   - ✅ `- **Date range filter** — Filter dashboard by date range with URL persistence (#141)`
   - ❌ `- add date range filter to dashboard (#141)`

4. **Semver enforcement:** If ANY `feat:` commit is present, version bump MUST be MINOR minimum, never PATCH.

5. **Always append a compare link at the bottom:**

   ```text
   **Full Changelog**: https://github.com/{owner}/{repo}/compare/{last_tag}...{new_tag}
   ```

Generate changelog from the categorized commits following these rules.

**Version determination:**

1. If the raw arguments contain an explicit version (e.g., `1.17.1`, `2.0.0`), use it directly.
   Skip Phase 4 (User Approval) entirely — the user already told you the version.
2. Otherwise, determine the version bump type from the commit categories and propose a version.

### Phase 4: User Approval

**Skip this phase entirely if an explicit version was provided in the raw arguments.**

Display the proposed release information. If version files were detected in Phase 2,
include them in the approval prompt.

**With version files:**

Present using AskUserQuestion. Show:

- Proposed version (e.g., v1.2.0, minor bump)
- List of version files to update with current to new version
- Changelog preview

User options:

- 'yes' -- Proceed with proposed version and all listed files
- 'major/minor/patch' -- Override the version bump type
- 'exclude N' -- Exclude file by number from the version bump (e.g., 'exclude 2')
- 'no' -- Cancel the release

To exclude files, remove them from the list. Pass remaining file paths as
`--files <path>` arguments to `bump-version` in Phase 5.

**Without version files:**

Same as before -- show proposed version and changelog, ask for confirmation.

### Phase 5: Bump Version (if version files detected)

Skip this phase if no version files were detected in Phase 2.

Run the bump command with the confirmed version and files:

```bash
myk-pi-tools release bump-version <VERSION> --files <file1> --files <file2>
```

Where `<VERSION>` is the version number without `v` prefix (e.g., `1.2.0`, not `v1.2.0`).

Parse the JSON output from bump-version. Only stage the files listed in the
`updated[]` array. If `skipped[]` is non-empty, inform the user which files were
skipped and why before proceeding.

Then create a branch, stage files, sync lockfile, commit, and push — **all in one sequence**:

```bash
BUMP_BRANCH="chore/bump-version-<VERSION>-$(date +%s)"
git checkout -b "$BUMP_BRANCH"
git add <updated-files>
# MANDATORY: sync uv.lock when pyproject.toml is bumped
if [ -f uv.lock ]; then uv lock && git add uv.lock; fi
git commit -m "chore: bump version to <VERSION>"
git push -u origin "$BUMP_BRANCH"
```

> **DO NOT split this block.** The `uv lock` step syncs the lockfile after
> `pyproject.toml` version changes. Skipping it leaves a dirty `uv.lock`
> after the release merge.

Note: The timestamp suffix prevents conflicts with previous bump attempts.

Create a PR and capture its URL:

```bash
PR_URL=$(gh pr create --title "chore: bump version to <VERSION>" \
  --body "Bump version to <VERSION>" --base <target_branch>)
```

Merge the PR using admin privileges:

```bash
gh pr merge --merge --admin --delete-branch
```

If the `--admin` merge fails, check the error:

- **Permission denied / not admin** -- Fall back to manual merge:
  1. Display `PR_URL` to the user
  2. Tell the user: "Admin merge failed. Please merge the PR manually
     (or wait for CI checks to pass). Let me know when it's merged."
  3. Use `AskUserQuestion` to wait for confirmation
  4. After user confirms, verify the PR is merged:

     ```bash
     gh pr view "$PR_URL" --json state --jq '.state'
     ```

     If the state is not `MERGED`, ask the user again.
- **Other errors** (network, auth, etc.) -- Abort the release and
  display the error.

After merge (either admin or manual), sync the local target branch:

```bash
git checkout <target_branch>
git pull origin <target_branch>
```

Where `<target_branch>` is the branch from Phase 1 validation
(default branch or `--target` value).

### Phase 6: Create Release

Create a temp file with cleanup, write changelog to it, and create release:

```bash
CHANGELOG_FILE=$(mktemp /tmp/pi-release-XXXXXX.md)
trap "rm -f $CHANGELOG_FILE" EXIT

cat > "$CHANGELOG_FILE" << 'EOF'
<changelog content from Phase 3>
EOF

myk-pi-tools release create {owner}/{repo} {tag} "$CHANGELOG_FILE" [--prerelease] [--draft] [--target {target_branch}]
```

### Phase 7: Summary

Display release URL and summary.
If version files were bumped, include the list of updated files in the summary.
