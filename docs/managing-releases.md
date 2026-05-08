# Managing Releases and Versioning

Create a GitHub release with an auto-generated changelog, bump version numbers across all your project files, and publish — all from a single `/release` command.

## Prerequisites

- **myk-pi-tools** CLI installed (`uv tool install myk-pi-tools` or `uv tool install git+https://github.com/myk-org/pi-config`)
- **gh** CLI installed and authenticated with GitHub
- **git** installed and configured
- Your repository uses [conventional commits](https://www.conventionalcommits.org/) (e.g., `feat:`, `fix:`, `chore:`)
- Working tree is clean and synced with the remote

## Quick Example

```text
/release
```

That's it. The command will:

1. Validate your branch and working tree
2. Detect version files in your project
3. Analyze commits since the last tag and generate a changelog
4. Propose a version bump and ask for approval
5. Update all version files, create a PR, and merge it
6. Create a GitHub release with the changelog

## Step-by-Step: Creating a Release

### 1. Run the release command

From your default branch with a clean working tree:

```text
/release
```

### 2. Review the proposed release

The command analyzes your commits since the last tag and proposes a version bump based on conventional commit types:

| Commit type | Bump | Example |
|---|---|---|
| `feat:` | **Minor** (1.2.0 → 1.3.0) | `feat: add retry logic` |
| `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | **Patch** (1.2.0 → 1.2.1) | `fix: handle null response` |
| Any commit with `!:` or `BREAKING CHANGE` in body | **Major** (1.2.0 → 2.0.0) | `feat!: redesign auth API` |

> **Note:** If any `feat:` commit is present, the minimum bump is always **minor**, even if other commits are only fixes.

You'll see:

- The proposed version (e.g., `v1.3.0, minor bump`)
- Which version files will be updated and their current versions
- A preview of the generated changelog

### 3. Approve or adjust

Respond to the approval prompt:

| Response | Action |
|---|---|
| `yes` | Proceed with proposed version and all files |
| `major`, `minor`, or `patch` | Override the bump type |
| `exclude N` | Remove file N from the version bump |
| `no` | Cancel the release |

### 4. Automatic version bump

If version files are detected, the command:

- Creates a branch (`chore/bump-version-<VERSION>-<timestamp>`)
- Updates all version files with the new version
- Syncs the lockfile if `uv.lock` exists
- Opens a PR, merges it, and syncs your local branch

### 5. GitHub release is created

A GitHub release is published with:

- A semantic version tag (e.g., `v1.3.0`)
- The auto-generated changelog as release notes
- A compare link showing all changes since the last release

## Supported Version Files

The command automatically detects and updates version strings in these files:

| File | Ecosystem |
|---|---|
| `pyproject.toml` | Python |
| `package.json` | Node.js |
| `setup.cfg` | Python (legacy) |
| `Cargo.toml` | Rust |
| `build.gradle` / `build.gradle.kts` | Java / Kotlin |
| `__init__.py` / `version.py` (with `__version__`) | Python |

No configuration needed — files are found by scanning the repository root and Python packages automatically.

## Changelog Format

The generated changelog groups commits into sections with emoji headers:

```markdown
### ✨ Features
- **Retry logic** — Add configurable retry with exponential backoff (#42)

### 🐛 Bug Fixes
- **Null response** — Handle null API response in parser (#38)

### 🔧 Maintenance
- **Dependencies** — Update ruff to 0.5.0 (#40)

**Full Changelog**: https://github.com/owner/repo/compare/v1.2.0...v1.3.0
```

Entries always reference PR numbers (not commit hashes) and follow the format: `- **Title** — description (#PR)`.

Noise commits are filtered out automatically — merge commits, version bumps, pre-commit autoupdates, review-response commits, and doc regeneration won't clutter your changelog.

## Common Options

```text
/release 2.0.0          # Set an explicit version (skips approval)
/release --dry-run       # Preview the release without creating anything
/release --prerelease    # Mark the release as a pre-release
/release --draft         # Create a draft release (not published)
/release --target v2.10  # Release from a specific branch
```

You can combine flags:

```text
/release --draft --prerelease
```

## Advanced Usage

### Releasing from version branches

If your project maintains version branches (e.g., `v2.10`), the release command auto-detects this when you run `/release` from that branch. It will:

- Scope tag discovery to `v2.10.*` tags only
- Target the version branch instead of the default branch

You can also be explicit:

```text
/release --target v2.10 --tag-match "v2.10.*"
```

### Explicit version with no approval

When you already know the version, pass it directly to skip the approval prompt:

```text
/release 1.17.1
```

### Excluding files from the version bump

During the approval step, you can exclude specific version files:

```text
exclude 2
```

This removes file number 2 from the list. The remaining files are still updated.

### Using the CLI directly

The `/release` command orchestrates several subcommands under the hood. You can use them individually if needed:

```bash
# Check release prerequisites and list commits since last tag
myk-pi-tools release info

# Check prerequisites for a specific branch
myk-pi-tools release info --target v2.10 --tag-match "v2.10.*"

# Detect version files in the current repo
myk-pi-tools release detect-versions

# Bump version in specific files
myk-pi-tools release bump-version 1.3.0 --files pyproject.toml --files package.json

# Create a GitHub release from a changelog file
myk-pi-tools release create owner/repo v1.3.0 /path/to/changelog.md
myk-pi-tools release create owner/repo v1.3.0 /path/to/changelog.md --prerelease
myk-pi-tools release create owner/repo v1.3.0 /path/to/changelog.md --draft --target main
```

> **Tip:** The `bump-version` command requires the version number **without** a `v` prefix. Use `1.3.0`, not `v1.3.0`.

## Troubleshooting

**"Must be on default branch"**
You're on a feature branch. Switch to your default branch (usually `main`) and pull latest changes before releasing.

**"Working tree must be clean"**
You have uncommitted changes. Commit or stash them before running `/release`.

**"Must be synced with remote"**
Your local branch is ahead or behind the remote. Run `git pull` and `git push` to sync.

**"myk-pi-tools: command not found"**
Install the CLI tool:

```bash
uv tool install myk-pi-tools
```

**Admin merge fails during version bump**
If you don't have admin permissions to merge the version bump PR, the command will ask you to merge it manually. Merge the PR in GitHub, confirm in the prompt, and the release continues.
