---
description: "Create a GitHub release with changelog — /release [--dry-run] [--prerelease] [--draft] [--target <branch>]"
---

Execute this workflow step by step. Run bash commands directly — do NOT delegate to subagents for CLI commands.

[PUSH_APPROVED]

## Prerequisites Check (MANDATORY)

```bash
myk-pi-tools --version
```

If not found, ask user to install: `uv tool install myk-pi-tools`

## Phase 1: Validation

Parse `{{args}}` for flags: `--dry-run`, `--prerelease`, `--draft`, `--target <branch>`, `--tag-match <pattern>`.

Build the release info command:

- If `--target <branch>` was passed: `myk-pi-tools release info --target <branch>`
- If `--tag-match <pattern>` was also passed: add `--tag-match <pattern>`
- Otherwise: `myk-pi-tools release info`

Run the command. Check validations:

- Must be on default branch (or target/auto-detected version branch)
- Working tree must be clean
- Must be synced with remote

If validation fails, display the error and stop.

## Phase 2: Version Detection

```bash
myk-pi-tools release detect-versions
```

Parse the JSON output. Key fields:

- `version_files[].path` — file path relative to repo root
- `version_files[].current_version` — current version string
- `count` — number of detected files (0 = skip version bumping)

Store for Phase 4.

## Phase 3: Changelog Analysis

Parse commits from Phase 1 output. Categorize by conventional commit type:

- Breaking Changes → MAJOR bump
- Features (`feat:`) → MINOR bump
- Bug Fixes (`fix:`), Docs (`docs:`), Maintenance (`chore:`) → PATCH bump

Determine the version bump type and generate a changelog in markdown format.

## Phase 4: User Approval

Present the proposed release info to the user.

**If version files were detected:**

Show:

- Proposed version (e.g., v1.2.0, minor bump)
- List of version files to update with current → new version
- Changelog preview

Ask the user (options):

- `yes` — Proceed with proposed version and all listed files
- `major`/`minor`/`patch` — Override the version bump type
- `exclude N` — Exclude file by number from the version bump
- `no` — Cancel the release

**If --dry-run:** Show what would happen and stop here.

**Without version files:** Show proposed version and changelog, ask for confirmation.

## Phase 5: Bump Version (if version files detected)

Skip if no version files detected in Phase 2 or all excluded.

```bash
myk-pi-tools release bump-version <VERSION> --files <file1> --files <file2>
```

Where `<VERSION>` is without `v` prefix (e.g., `1.2.0`).

Parse JSON output. Only stage files listed in `updated[]` array. If `skipped[]` is non-empty, inform the user.

Then create branch, stage, sync lockfile, commit, push — ALL in one sequence:

```bash
BUMP_BRANCH="chore/bump-version-<VERSION>-$(date +%s)"
git checkout -b "$BUMP_BRANCH"
git add <updated-files>
# MANDATORY: sync uv.lock when pyproject.toml is bumped
if [ -f uv.lock ]; then uv lock && git add uv.lock; fi
echo -e "chore: bump version to <VERSION>" | git commit -F -
git push -u origin "$BUMP_BRANCH"
```

Create and merge PR:

```bash
PR_URL=$(gh pr create --title "chore: bump version to <VERSION>" --body "Bump version to <VERSION>" --base <target_branch>)
gh pr merge --merge --admin --delete-branch
```

If `--admin` merge fails:

- **Permission denied** — Show PR_URL, tell user to merge manually, wait for confirmation, verify merge state
- **Other errors** — Abort and display error

After merge, sync local:

```bash
git checkout <target_branch>
git pull origin <target_branch>
```

## Phase 6: Create Release

```bash
CHANGELOG_FILE=$(mktemp /tmp/pi-release-XXXXXX.md)
```

Write changelog content to the file.

```bash
myk-pi-tools release create <owner>/<repo> <tag> "$CHANGELOG_FILE" [--prerelease] [--draft] [--target <target_branch>]
```

Clean up:

```bash
rm -f "$CHANGELOG_FILE"
```

## Phase 7: Summary

Display:

- Release URL
- Version bumped (if applicable)
- Files updated (if applicable)
- Changelog summary
