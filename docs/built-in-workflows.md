# Built-in Workflow Commands

Built-in workflow commands cover implementation, review, release, memory, and glossary tasks. Text after the command name is passed to the command as its raw arguments.

> **Note:** Commands that invoke `myk-pi-tools` require `uv` and `myk-pi-tools` on PATH. See [myk_pi_tools CLI Reference](cli-reference.html) for the underlying CLI commands.

## Implementation Commands

### `/implement`

Runs a three-stage workflow: scout the codebase, build an implementation plan, then apply the code changes.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<task>` | string | (required) | Task description to explore, plan, and implement. |

**Return value / effect:** Produces a scoped code exploration summary, an implementation plan, and the resulting code changes.

```text
/implement Add rate limiting to the login endpoint
```

### `/implement-and-review`

Implements a task, runs parallel review passes, then performs a follow-up fix pass.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<task>` | string | (required) | Task description for implementation and review. |

| Review pass | Purpose |
| :--- | :--- |
| Quality | Code quality review |
| Guidelines | Project guideline adherence |
| Security | Bug and security review |
| Docs | Documentation review |
| Spec | Specification compliance review |

**Return value / effect:** Applies the requested changes, gathers review feedback from parallel review passes, then fixes the reported issues.

```text
/implement-and-review Refactor the settings loader to support env overrides
```

> **Tip:** For planning without code changes, see [Installation & Quickstart](quickstart.html) for `/scout-and-plan`.

## Review Commands

### `/issue-review`

Reviews a GitHub issue for spec quality, feasibility, and scope, then updates the issue body after user approval.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `[issue number or URL]` | string | auto-detect | Issue number, full GitHub issue URL, or empty to auto-detect. |

| Auto-detect source | Order | Description |
| :--- | :--- | :--- |
| Branch name | 1 | Extracts issue numbers from branch names such as `feat/issue-42-...` or `fix/issue-42-...` |
| Assigned issues | 2 | Uses `gh issue list --assignee @me --state open --limit 1` |
| User input | 3 | Prompts the user if nothing is detected |

**Prerequisites:** GitHub CLI (`gh`) authenticated and repository access available.

**Return value / effect:** Creates a multi-step review plan, gathers issue context, reviews the issue from multiple angles, and edits the issue body with the approved fixes.

```text
/issue-review
/issue-review 42
/issue-review https://github.com/owner/repo/issues/42
```

### `/pr-review`

Reviews a GitHub pull request, presents findings, posts selected inline comments, and stores the posted comments.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `[PR number or URL]` | string | current branch PR | Pull request number, full GitHub PR URL, or empty to auto-detect from the current branch. |

**Prerequisites:** `uv`, `myk-pi-tools`, and `gh`.

**Return value / effect:** Clones the PR, runs review passes for quality, guidelines, security, docs, and spec, then posts selected findings and stores them for later review-cycle tracking.

```text
/pr-review
/pr-review 123
/pr-review https://github.com/owner/repo/pull/123
```

### `/review-local`

Reviews local changes without posting to GitHub.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `[base branch]` | string | staged + unstaged changes | Base branch to diff against. If omitted, reviews local staged and unstaged changes. |

**Return value / effect:** Builds a diff, runs the same five review passes used by `/pr-review`, merges findings, and presents them in the session.

```text
/review-local
/review-local main
/review-local feature/other-branch
```

### `/refine-review`

Fetches the user’s pending GitHub review comments, refines them, and optionally submits the review.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<PR URL>` | string | (required) | Full GitHub pull request URL containing the pending review. |
| `[instructions]` | string | empty | Optional refinement guidance included in the command arguments. |

**Prerequisites:** `uv`, `myk-pi-tools`, and an existing pending review on the target PR.

**Return value / effect:** Fetches pending comments, generates refined versions, lets the user accept or edit them, updates the review JSON, and optionally submits the review.

```text
/refine-review https://github.com/owner/repo/pull/123
```

See [Automating Code Reviews](automating-code-reviews.html) for automated PR review workflows.

## Release Command

### `/release`

Creates a GitHub release from commit history and optionally updates version files before creating the release.

| Parameter / Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `[version]` | string | auto-detect bump | Explicit version to release. If omitted, the workflow derives the release level from commit history. |
| `--dry-run` | flag | off | Previews the release workflow without creating the release. |
| `--prerelease` | flag | off | Marks the release as a prerelease. |
| `--draft` | flag | off | Creates the release as a draft. |
| `--target <branch>` | string | current or auto-detected target | Target branch to validate and release from. |
| `--tag-match <pattern>` | string | none | Tag glob used during release info lookup. |

**Prerequisites:** `myk-pi-tools`, a clean working tree, the correct target branch, and a synced remote.

**Return value / effect:** Validates release state, inspects version files, builds a PR-grouped changelog, optionally bumps versions, and creates the GitHub release.

```text
/release
/release 1.17.1
/release --dry-run
/release --prerelease
/release --draft
```

## Memory And Skill Commands

### `/remember`

Stores a pinned project memory.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<what to remember>` | string | (required) | Memory content to store. |

| Category | Meaning |
| :--- | :--- |
| `lesson` | Something learned |
| `decision` | Design or architecture choice |
| `mistake` | Something to avoid repeating |
| `pattern` | Recurring convention or approach |
| `done` | Completed task or milestone |
| `preference` | User preference |

**Return value / effect:** Chooses a category, runs the memory add workflow with `--pinned`, and confirms the saved memory.

```text
/remember Prefer uv over pip for all Python installs in this repo
```

See [Curating Project Memory](curating-project-memory.html) for memory storage and organization.

### `/create-skill`

Creates a reusable skill from the current conversation.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `[name]` | string | prompt if empty | Skill name. Must be lowercase, hyphenated, start with a letter, and be at most 64 characters. |
| Scope | choice | ask user | Where to create the skill: **Global** or **Project**. |

| Scope | Location | Effect |
| :--- | :--- | :--- |
| Global | `~/.agents/skills/<name>/SKILL.md` | Skill is available across projects |
| Project | `.pi/skills/<name>/SKILL.md` | Skill is available only in the current project |

**Return value / effect:** Extracts the completed workflow from the current conversation and writes a `SKILL.md` file with frontmatter and step-by-step instructions.

```text
/create-skill debug-container-build
/create-skill
```

See [Managing Custom Agents](managing-custom-agents.html) for related customization patterns.

## Glossary Command

### `/domain-model`

Scans code identifiers and drafts or updates a root `CONTEXT.md` glossary.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `[focus area]` | string | full codebase | Optional focus area to narrow the glossary scan. |

**Return value / effect:** Identifies project-specific terms from code, compares them with any existing `CONTEXT.md`, and presents a draft glossary for approval or editing.

```text
/domain-model
/domain-model providers and sessions
```

## Review Database Command

### `/query-db`

Runs review analytics queries through `myk-pi-tools db`.

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<query>` | string | (required for useful output) | Database subcommand and flags after `db`. |

**Prerequisites:** `uv` and `myk-pi-tools`.

| Example query | Effect |
| :--- | :--- |
| `stats --by-source` | Shows stats grouped by review source |
| `stats --by-reviewer` | Shows stats grouped by reviewer author |
| `patterns --min 2` | Shows recurring dismissed patterns |
| `dismissed --owner X --repo Y` | Lists dismissed comments for a repository |
| `query "SELECT * FROM comments WHERE status='skipped' LIMIT 10"` | Runs a custom SELECT query |

**Return value / effect:** Executes the requested review database query and prints the results using the underlying CLI behavior.

```text
/query-db stats --by-source
/query-db patterns --min 2
/query-db dismissed --owner myk-org --repo pi-config
/query-db query "SELECT * FROM comments WHERE status='skipped' LIMIT 10"
```

## Shared Command Behavior

### Argument Handling

| Behavior | Effect |
| :--- | :--- |
| Text after command name | Passed to the command as raw arguments |
| Empty required argument | Command aborts or prompts, depending on the workflow |
| Interactive choice needed | Command asks the user through the Pi UI |

### Side Effects

| Command area | Possible side effect |
| :--- | :--- |
| Implementation | Code changes |
| Issue and PR review | GitHub issue or PR updates |
| Release | Version bumps, changelog generation, GitHub release creation |
| Memory and skill | Memory entries or `SKILL.md` files |
| Glossary | `CONTEXT.md` creation or update |

> **Warning:** Commands that mutate GitHub state, create releases, or write project files may prompt for confirmation before final actions.

See [Creating Slash Commands](custom-slash-commands.html) for custom prompt commands and [myk_pi_tools CLI Reference](cli-reference.html) for the underlying CLI details.

## Related Pages

- [Creating Slash Commands](custom-slash-commands.html)
- [myk_pi_tools CLI Reference](cli-reference.html)
- [Automating Code Reviews](automating-code-reviews.html)
- [Managing Custom Agents](managing-custom-agents.html)
- [Curating Project Memory](curating-project-memory.html)
