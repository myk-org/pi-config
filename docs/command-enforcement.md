# Command Safety Guards and Enforcement

Pi's enforcement system intercepts every `bash` tool call before execution, applying a layered set of safety guards that protect your environment from accidental damage, security risks, and workflow anti-patterns. Whether you're running pi in a container or natively, these guards prevent common mistakes — staging the wrong files, committing to protected branches, executing remote scripts, or running destructive commands without confirmation.

Understanding these guardrails helps you work *with* the system rather than against it. When a command is blocked, pi tells you exactly why and what to do instead.

## How Enforcement Works

The enforcement system is registered as a `tool_call` event handler in the orchestrator extension. Every time pi (or a specialist agent) attempts to run a bash command, the handler inspects the command string and either:

- **Allows** it — execution proceeds normally
- **Blocks** it — returns an error message explaining why and what to do instead
- **Prompts for confirmation** — asks the user before proceeding (dangerous commands only)

| Step | What Happens | Example |
|------|-------------|---------|
| 1. Command intercepted | `tool_call` event fires for every `bash` invocation | `git add .` |
| 2. Guards evaluated | Each guard checks the command in order | "Does this match `git add .`?" → Yes |
| 3. Decision returned | Block with reason, prompt user, or allow | `⛔ 'git add .' forbidden. Stage specific files.` |
| 4. Agent sees result | The blocked command's reason appears as the tool result | Agent retries with `git add src/file.ts` |

> **Note:** Enforcement applies to **all** agents — both the orchestrator and specialist subagents. Some guards are scoped to specific contexts (container-only, orchestrator-only, specialist-only).

## Blocked Commands

### Python and pip (Direct Execution)

Pi requires all Python execution to go through `uv`, which provides isolated, reproducible environments.

| Blocked | Use Instead |
|---------|-------------|
| `python script.py` | `uv run script.py` |
| `python3 -c "..."` | `uv run python3 -c "..."` |
| `pip install requests` | `uv add requests` |
| `pip3 install -r requirements.txt` | `uv sync` |
| `pre-commit run --all-files` | `prek run --all-files` |

Commands that already start with `uv` or `uvx` are allowed through. The check also catches piped variants like `something | python3`.

### Remote Script Execution

Pi blocks all patterns that pipe downloaded content directly into a shell or interpreter. This prevents supply-chain attacks from untrusted sources.

**Blocked patterns:**

- **Pipe to shell:** `curl https://example.com/install.sh | bash`
- **Pipe to interpreter:** `wget https://example.com/setup.py | python3`
- **Process substitution:** `bash <(curl https://example.com/install.sh)`
- **Command substitution:** `sh -c "$(curl https://example.com/install.sh)"`
- **Eval:** `eval $(curl https://example.com/script.sh)`
- **Backtick substitution:** `` `curl https://example.com/script.sh` ``

**What to do instead:** Download the script first, audit it with the `security-auditor` agent, then run it if safe:

```bash
curl -o /tmp/pi-work/myproject/install.sh https://example.com/install.sh
# Security audit happens here
bash /tmp/pi-work/myproject/install.sh
```

> **Tip:** Content inside heredocs (`<< 'EOF' ... EOF`) is stripped before the remote execution check. So documentation examples containing `curl | bash` won't trigger false positives.

### Sleep and Polling Loops

Pi blocks patterns that would tie up the session for extended periods:

| Blocked Pattern | Threshold | Alternative |
|----------------|-----------|-------------|
| `sleep N` (standalone) | N > 30 seconds | Use a subagent with `async: true` |
| `while ... sleep N ... done` | N > 5 seconds | Use a subagent with `async: true` |

These guards prevent the LLM from implementing naive polling loops that block the entire session. Long-running monitoring belongs in async background agents.

### Temp File Location

All temp files must use the `/tmp/pi-work/<project>/` prefix (where `<project>` is the basename of the current working directory). Bare `mktemp` calls without this prefix are blocked:

| Blocked | Use Instead |
|---------|-------------|
| `mktemp /tmp/XXXXXX` | `mktemp /tmp/pi-work/$(basename $PWD)/XXXXXX` |

This ensures temp files are organized by project and persist correctly across container restarts when `/tmp/pi-work` is mounted from the host.

## Git Branch Protection

Pi enforces a branching workflow that prevents accidental commits to protected branches. Protection checks run against the **effective working directory** — if a command starts with `cd /path && git ...` or uses `git -C /path`, the guard resolves the correct repo.

### Protected Branch Detection

Pi determines protected branches in this order:

1. **GitHub API** — queries `gh api repos/{owner}/{repo}/branches` for branches with `protected: true`
2. **Fallback** — always includes `main` and `master` regardless of API results
3. **Cache** — results are cached per repository for the session lifetime (one API call per repo)

### What's Protected

| Action | Guard | Error Message |
|--------|-------|---------------|
| Commit on protected branch | Blocked | `⛔ Cannot commit to 'main' (protected). Create a feature branch.` |
| Push to protected branch | Blocked | `⛔ Cannot push to 'main' (protected). Create a feature branch.` |
| Push explicitly naming a protected branch | Blocked | `⛔ Cannot push to 'main' (protected). Create a feature branch.` |
| Commit in detached HEAD | Blocked | `⛔ Detached HEAD. Create a branch first: git checkout -b my-branch` |
| Commit on already-merged branch | Blocked | `⛔ Branch 'my-feature' already merged into 'main'. Create a new branch.` |
| Commit on branch with merged PR | Blocked | `⛔ PR #42 for 'my-feature' already merged. Create a new branch from main.` |
| Push on already-merged branch | Blocked | `⛔ Branch 'my-feature' already merged into 'main'. Create a new branch.` |

> **Note:** When you combine `git checkout` and `git commit` in a single bash call (e.g., `git checkout -b feature && git commit -m "init"`), the branch check runs *before* execution. Split them into separate bash calls so the checkout happens first.

### Git Staging Guards

| Action | Guard | Error Message |
|--------|-------|---------------|
| `git add .` or `git add -A` or `git add --all` | Blocked | `⛔ 'git add .' / 'git add -A' forbidden. Stage specific files.` |
| `git add <gitignored-file>` | Blocked | `⛔ '<file>' is in .gitignore. Do not stage ignored files.` |

Staging guards force explicit, intentional file selection. This prevents accidentally committing build artifacts, secrets, or other ignored files.

### Git Hook Bypass Prevention

| Action | Guard |
|--------|-------|
| `git commit --no-verify` | Blocked — pre-commit hooks must run |
| `core.hooksPath=/dev/null` | Blocked — hook bypass is forbidden |

### Agent-Restricted Git Operations

Git `commit` and `push` commands are only allowed from the `git-expert` agent. If any other agent attempts these operations, the command is blocked with a message to delegate to `git-expert`.

## Worktree Enforcement

When the `use_worktrees` project setting is enabled (via `.pi/pi-config-settings.json` or `PI_USE_WORKTREES` env var), pi blocks branch switching entirely:

| Blocked Command | What to Do Instead |
|----------------|-------------------|
| `git checkout <branch>` | `git worktree add .worktrees/<name> -b <branch> main` |
| `git switch <branch>` | `git worktree add .worktrees/<name> -b <branch> main` |

> **Note:** `git checkout -- <file>` (restoring file contents, note the `--`) is still allowed — only branch-switching checkouts are blocked.

This setting is essential for multi-PR workflows where parallel agents work in the same repository. See [Configuration and Environment Variables Reference](configuration-reference.html) for how to enable it.

## Dangerous Command Confirmation

Some commands are too risky to block outright but require explicit user approval. When pi detects a dangerous command, it presents a confirmation prompt:

```
⚠️ Dangerous command:

  rm -rf /tmp/pi-work/old-project

Allow? [Yes / No]
```

**Commands that trigger confirmation:**

| Pattern | Examples |
|---------|---------|
| `rm -rf` or `rm -r` | `rm -rf build/`, `rm -r node_modules/` |
| `sudo` | `sudo apt install ...` |
| `chmod 777` or `chown 777` | `chmod 777 script.sh` |
| `mkfs` | `mkfs.ext4 /dev/sda1` |
| `dd ... of=/dev/` | `dd if=/dev/zero of=/dev/sda` |

> **Warning:** If pi is running without a UI (e.g., in `json` or `print` mode), dangerous commands are **blocked entirely** rather than prompted — there's no way to ask for confirmation.

## Repeat Command Detection

The orchestrator tracks consecutive identical bash commands to prevent polling-by-spam — where the LLM runs the same command over and over hoping for a different result.

**How it works:**

1. Each command is normalized (leading `cd ... &&` prefixes stripped, whitespace collapsed)
2. The normalized command is compared against the last command via a per-process temp file
3. On the 3rd consecutive identical execution, the command is blocked

**Block message:** `⛔ Same command executed 3 times in a row. Use a subagent with async: true for polling/monitoring instead of repeating the command.`

> **Note:** Repeat detection only applies to the **orchestrator**. Specialist subagents (which set `PI_SUBAGENT_CHILD=1`) are exempt, since they may legitimately retry commands.

## Docker-Safe Wrapper (Container Only)

When pi runs inside a Docker or Podman container, direct `docker` and `podman` CLI commands are blocked. Instead, pi provides the `docker-safe` wrapper script that only allows **read-only inspection commands**.

**Allowed commands through `docker-safe`:**

| Command | Purpose |
|---------|---------|
| `docker-safe ps` | List containers |
| `docker-safe logs` | View container logs |
| `docker-safe inspect` | Inspect container or image metadata |
| `docker-safe top` | Display running processes in a container |
| `docker-safe stats` | Show resource usage statistics |
| `docker-safe port` | List port mappings |
| `docker-safe diff` | Show filesystem changes in a container |
| `docker-safe images` | List images |
| `docker-safe version` | Show Docker/Podman version |
| `docker-safe info` | Show system-wide information |

**Everything else** (`exec`, `run`, `rm`, `cp`, `build`, etc.) is blocked.

To use Podman instead of Docker, pass `--runtime podman` or set `DOCKER_SAFE_RUNTIME=podman`.

> **Tip:** Container detection uses filesystem checks (`/.dockerenv`, `/run/.containerenv`) and cgroup inspection. This guard only activates when pi detects it's running inside a container.

## Memory Write Restrictions for Subagents

Specialist agents cannot modify pi's memory system. Any `myk-pi-tools memory add` or `myk-pi-tools memory delete` command from a subagent is blocked:

```
Memory writes are restricted to the orchestrator. Specialists can only search/list memories.
```

This ensures memory consistency — only the orchestrator (which has full context of the conversation) can add or remove memories. Specialist agents can still **search** memories via `memory_search`. See [Working with Project Memory](memory-system.html) for how the memory system works.

## Async-Only Agents

Some agents are enforced to always run asynchronously. If the LLM attempts to call them synchronously, the system auto-promotes them to `async: true`. If they appear in a chain, the call is rejected entirely (chains are inherently synchronous).

**Currently enforced async-only agents:**

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

This prevents code reviews from blocking the session — they can take minutes to complete and the user should be able to continue working.

> **Note:** The `ASYNC_ONLY_AGENTS` set is defined in `extensions/orchestrator/subagent-tool.ts`. Changes to this list should be kept in sync with `rules/20-code-review-loop.md`.

## Timeout Stripping

For known long-running commands (specifically `myk-pi-tools reviews poll`), pi silently removes any `timeout` parameter the LLM sets. These poll commands can run for 30+ minutes waiting for rate limits to clear. Rather than blocking the command (which causes retry loops), the timeout is simply deleted so the command runs to completion.

## Co-Author Trailer Injection

While not a safety guard per se, the enforcement handler also manages automatic co-author trailer injection. When the `co_author` setting is enabled and a `git commit` command doesn't already include a `Co-authored-by:` trailer, enforcement automatically appends one with the current model ID. This works for both `-m "message"` style commits and `echo "message" | git commit -F -` piped commits.

## What to Do When a Command Is Blocked

Every block message includes three things:

1. **What was blocked** — the exact command or pattern that triggered the guard
2. **Why it was blocked** — the safety reason
3. **What to do instead** — the correct alternative command or approach

The agent (or orchestrator) automatically retries using the suggested alternative in most cases. If you see repeated blocks, check that:

- You're on a feature branch, not `main` or `master`
- You're staging specific files, not using `git add .`
- Your worktree setting matches your workflow (see [Configuration and Environment Variables Reference](configuration-reference.html))
- Long-running tasks are dispatched as async agents

## Extending the Enforcement System

The enforcement handler is a single `tool_call` event listener registered in `extensions/orchestrator/enforcement.ts`. To add a new guard:

1. **Add your check** inside the `pi.on("tool_call", ...)` callback, after the existing guards
2. **Return a block object** with `{ block: true, reason: "..." }` to prevent execution
3. **Return `undefined`** to allow the command through
4. **For confirmation prompts**, use `ctx.ui.select()` — check `ctx.hasUI` first to handle headless mode

The handler receives the full `event.input.command` string and the `ctx` object with `cwd`, `hasUI`, `ui`, and `model` properties. You can also **modify** the command in-place by reassigning `event.input.command` (as co-author trailer injection does).

**Hook signature:**

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (!isToolCallEventType("bash", event)) return undefined;
  const command = event.input.command;

  // Your guard logic here
  if (shouldBlock(command)) {
    return { block: true, reason: "Explanation and alternative" };
  }

  return undefined; // Allow
});
```

Git helper functions (`getCurrentBranch`, `getMainBranch`, `getProtectedBranches`, `hasGitSub`, `isBranchMerged`, etc.) are exported from `extensions/orchestrator/git-helpers.ts` for use in enforcement checks. The `DANGEROUS` regex array is also exported from there.

## Related Pages

- [Extension Architecture and Lifecycle Hooks](extension-architecture.html) — how `tool_call` event handlers fit into pi's extension lifecycle
- [Running the Automated Code Review Loop](code-review-loop.html) — async-only enforcement for review agents in practice
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html) — using async agents instead of blocked polling loops
- [Configuration and Environment Variables Reference](configuration-reference.html) — `use_worktrees`, `co_author`, and other settings that affect enforcement
- [Running Pi in a Docker Container](docker-deployment.html) — container setup and the `docker-safe` wrapper
- [Working with Project Memory](memory-system.html) — memory write restrictions and the orchestrator-only policy
- [Orchestrator Rules Reference](rules-reference.html) — the rule files that complement enforcement with behavioral guidance

## Related Pages

- [Extension Architecture and Lifecycle Hooks](extension-architecture.html)
- [Orchestrator Rules Reference](rules-reference.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Running Pi in a Docker Container](docker-deployment.html)
- [Running the Automated Code Review Loop](code-review-loop.html)
