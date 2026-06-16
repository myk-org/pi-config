# Command Safety Guards and Enforcement

Pi operates with full access to your shell, file system, and git history. That power requires guardrails. The enforcement system is a set of runtime checks that intercept every `bash` command before it executes — blocking dangerous patterns, protecting git branches, and preventing common mistakes that could damage your environment or waste resources.

You don't need to configure enforcement — it's always active. But understanding what it blocks (and why) helps you work with the guardrails instead of fighting them.

## How Enforcement Works

Every time pi (or any specialist agent) calls the `bash` tool, the command passes through a chain of checks in `enforcement.ts`. Each check can:

- **Allow** the command (no interference)
- **Block** the command with an error message explaining what to do instead
- **Prompt for confirmation** (dangerous commands only, when a UI is available)
- **Silently modify** the command (co-author trailers, timeout stripping — rare cases)

Checks run in order. The first check that returns a block stops execution immediately — the command never reaches your shell.

## Blocked Commands

### Python and pip

| Blocked | Use Instead |
|---------|-------------|
| `python script.py` | `uv run script.py` |
| `python3 -m pytest` | `uv run python3 -m pytest` |
| `pip install requests` | `uv add requests` or `uv run --with requests script.py` |
| `pip3 freeze` | `uv pip freeze` |

Pi enforces the use of `uv` for all Python execution. This keeps dependencies managed per-execution without polluting the environment. The check catches `python` and `pip` (and their `3` variants) at the start of a command or after pipe/semicolon/`&&` operators.

> **Note:** Commands that already start with `uv` or `uvx` are not affected — the check only targets bare `python`/`pip` invocations.

### Pre-commit

| Blocked | Use Instead |
|---------|-------------|
| `pre-commit run --all-files` | `prek run --all-files` |

Direct `pre-commit` invocations are blocked. Use the `prek` wrapper instead.

### Remote Script Execution

Pi blocks all forms of piping remote content into a shell or interpreter:

| Pattern | Example |
|---------|---------|
| Pipe to shell | `curl https://example.com/install.sh \| bash` |
| Pipe to interpreter | `wget https://example.com/setup.py \| python3` |
| Process substitution | `bash <(curl https://example.com/install.sh)` |
| Command substitution | `sh -c "$(curl https://example.com/install.sh)"` |
| Eval with download | `` eval `curl https://example.com/config` `` |

**What to do instead:** Download the script first, have the `security-auditor` agent review it, then run it manually if it's safe.

> **Tip:** The check is smart about heredocs — if a `curl | bash` pattern appears inside heredoc content (like documentation examples), it won't trigger a false positive.

### Staging All Files

| Blocked | Use Instead |
|---------|-------------|
| `git add .` | `git add src/main.py src/utils.py` |
| `git add --all` | `git add src/main.py src/utils.py` |
| `git add -A` | `git add src/main.py src/utils.py` |

Pi requires staging specific files to prevent accidentally committing generated files, secrets, or unrelated changes.

### Staging Gitignored Files

If you try to `git add` a file that matches a pattern in `.gitignore`, the command is blocked. Pi runs `git check-ignore` on each file in the `git add` command to catch this.

### Bypassing Git Hooks

| Blocked | Why |
|---------|-----|
| `git commit --no-verify` | Pre-commit hooks must always run |
| `git -c core.hooksPath=/dev/null commit ...` | Disabling hooks via config is not allowed |

### Sleep and Polling Loops

| Blocked | Use Instead |
|---------|-------------|
| `while true; do check; sleep 10; done` | Spawn an async subagent for polling |
| `sleep 120` (standalone, > 30s) | Spawn an async subagent |

Blocking the session with long sleeps or polling loops wastes resources. Pi's async agent system is designed for exactly these cases — see [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

> **Note:** `sleep` commands of 30 seconds or less outside of loops are allowed. Inside loops, the threshold is 5 seconds.

### Temp File Location

| Blocked | Use Instead |
|---------|-------------|
| `mktemp /tmp/foo.XXXXXX` | `mktemp ${PROJECT_TMP_DIR}/foo.XXXXXX` |

All temp files must go to the project-scoped temp directory (`.pi/tmp/`), which is already gitignored. This prevents cluttering system-level `/tmp/` and ensures cleanup on session end.

## Git Branch Protection

Pi enforces a branch-based workflow to prevent accidental changes to production code.

### Protected Branches

For GitHub repositories, pi queries the GitHub API to discover branches marked as protected and always includes `main` and `master`. For non-GitHub repos, only `main` and `master` are protected.

The following operations are blocked on protected branches:

| Operation | Error |
|-----------|-------|
| `git commit` on a protected branch | "Cannot commit to 'main' (protected). Create a feature branch." |
| `git push` while on a protected branch | "Cannot push to 'main' (protected). Create a feature branch." |
| `git push origin main` (explicit target) | "Cannot push to 'main' (protected). Create a feature branch." |

> **Tip:** Protected branch information is cached per session — it's fetched once from the GitHub API and reused for all subsequent checks.

### Detached HEAD Detection

If you're in a detached HEAD state (not on any branch), commits are blocked. Create a branch first:

```
git checkout -b my-feature-branch
```

### Merged Branch Detection

Pi detects two kinds of "already merged" situations:

1. **PR already merged** — If a GitHub PR for the current branch has been merged, further commits and pushes are blocked. Create a new branch from the main branch instead.
2. **Branch merged locally** — If the current branch has been merged into the main branch (checked via `git merge-base --is-ancestor`), commits and pushes are blocked.

Both checks prevent the common mistake of continuing to work on a branch after its PR has been merged.

### Git Commit and Push Agent Restriction

Only the `git-expert` specialist agent is allowed to run `git commit` and `git push`. If any other agent (or the orchestrator) attempts these commands, they are blocked with a message directing the work to `git-expert`.

## Worktree Enforcement

When `use_worktrees` is enabled in your project settings (`.pi/pi-config-settings.json`) or via the `PI_USE_WORKTREES` environment variable, pi blocks branch switching commands:

| Blocked | Use Instead |
|---------|-------------|
| `git checkout feature-branch` | `git worktree add .worktrees/feature-branch -b feature-branch main` |
| `git switch feature-branch` | `git worktree add .worktrees/feature-branch -b feature-branch main` |

> **Note:** `git checkout -- file.txt` (restoring a file, not switching branches) is still allowed — the check looks for the `--` separator.

This prevents branch switching when multiple agents may be working in the same worktree simultaneously. See [Configuration and Environment Variables Reference](configuration-reference.html) for how to enable this setting.

## Dangerous Command Confirmation

Some commands are not blocked outright but require explicit user confirmation before running. These are matched by pattern:

| Pattern | Example Commands |
|---------|-----------------|
| `rm -rf` / `rm --recursive` | `rm -rf /path/to/dir` |
| `sudo` | `sudo apt install ...` |
| `chmod 777` / `chown 777` | `chmod 777 /var/www` |
| `mkfs` | `mkfs.ext4 /dev/sda1` |
| `dd of=/dev/` | `dd if=image.iso of=/dev/sdb` |

When pi detects one of these patterns, it shows a confirmation prompt:

```
⚠️ Dangerous command:

  rm -rf /path/to/old-builds

Allow? [Yes / No]
```

If no UI is available (e.g., running in JSON or print mode), the command is blocked entirely — there's no way to confirm.

## Docker-Safe Wrapper

When pi runs inside a Docker or Podman container, direct `docker` and `podman` CLI commands are blocked. Instead, pi uses the `docker-safe` wrapper script, which only allows read-only inspection commands:

| Allowed via docker-safe | Blocked |
|------------------------|---------|
| `ps`, `logs`, `inspect` | `exec`, `run`, `rm` |
| `top`, `stats`, `port` | `cp`, `build`, `pull` |
| `diff`, `images` | `stop`, `start`, `kill` |
| `version`, `info` | Everything else |

Usage:

```bash
docker-safe ps -a
docker-safe logs my-container --tail 50
docker-safe --runtime podman inspect my-container
```

The runtime defaults to `docker` but can be switched to `podman` via the `--runtime` flag or the `DOCKER_SAFE_RUNTIME` environment variable.

> **Note:** This restriction only applies when pi is running inside a container. Native installations are not affected.

## Memory Write Restrictions

Specialist agents (subagents) cannot write to the project memory system. Only the orchestrator — the top-level pi session — is allowed to add or delete memories.

| Agent Type | `memory add` | `memory search` |
|------------|-------------|----------------|
| Orchestrator | ✅ Allowed | ✅ Allowed |
| Specialist agent | ❌ Blocked | ✅ Allowed |

This prevents specialist agents from creating conflicting or redundant memory entries. Specialists can read memories to inform their work, but any learned insights must be surfaced to the orchestrator for storage. See [Working with Project Memory](memory-system.html) for how memory works.

## Repeat Command Detection

Pi tracks consecutive identical bash commands at the orchestrator level. If the same command is executed **3 or more times in a row**, it's blocked:

```
⛔ Same command executed 3 times in a row.
Use a subagent with async: true for polling/monitoring instead of repeating the command.
```

This catches runaway loops where the LLM keeps retrying a failing command. The detection normalizes commands by stripping `cd` prefixes and whitespace, so `cd /tmp && ls` and `cd /tmp  &&  ls` are treated as the same command.

Repeat state is stored per session in a temp file (`.pi/tmp/.repeat-<pid>.json`) and only applies to the orchestrator — specialist agents are not tracked.

## Async-Only Agent Enforcement

Certain long-running agents are enforced to always run asynchronously. If you (or the LLM) try to dispatch them synchronously, the system automatically promotes the call to `async: true`:

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

These agents cannot be used in chain mode either — they must be dispatched as independent async tasks.

This prevents the session from blocking while waiting for code reviews, which can take minutes. See [Running the Automated Code Review Loop](code-review-loop.html) for how reviews work in practice.

## Co-Author Trailer Injection

While not a safety guard, the enforcement system also handles co-author trailers. When `co_author` is enabled in project settings, pi automatically appends a `Co-authored-by:` line to git commit messages. This is a transparent modification — the command runs with the trailer added, and the user sees the full commit message.

## What to Do When a Command Is Blocked

Every block message includes:

1. **What was blocked** — the exact command or pattern
2. **Why it was blocked** — a brief explanation
3. **What to do instead** — the correct alternative command or approach

In most cases, the LLM adjusts automatically after receiving the block message. If you're running commands manually and encounter a block:

- **Read the suggestion** — the error message always provides an alternative
- **Use the correct tool** — `uv run` instead of `python`, `docker-safe` instead of `docker`, specific file paths instead of `git add .`
- **Delegate to the right agent** — `git-expert` for commits, async subagents for polling
- **Ask pi for help** — describe what you're trying to do and let it route to the appropriate approach

> **Warning:** These guardrails exist to protect your environment. While the enforcement system can't cover every possible dangerous command, it catches the most common patterns that lead to accidental damage, security issues, or wasted resources.

## Related Pages

- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — how async agents work as an alternative to polling loops and long sleeps
- [Running the Automated Code Review Loop](code-review-loop.html) — the async-only review agents in practice
- [Running Pi in a Docker Container](docker-deployment.html) — container setup and the docker-safe wrapper
- [Configuration and Environment Variables Reference](configuration-reference.html) — project settings like `use_worktrees` and `co_author`
- [Working with Project Memory](memory-system.html) — memory tools and the orchestrator-only write restriction
- [Orchestrator Rules Reference](rules-reference.html) — the full set of rules that govern orchestrator behavior

## Related Pages

- [Specialist Agents Reference](agents-reference.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Orchestrator Rules Reference](rules-reference.html)
