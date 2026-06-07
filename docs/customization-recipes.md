# Customization and Extension Recipes

Practical, copy-paste recipes for customizing pi-config — adding agents, writing prompts, creating skills, configuring project settings, and connecting MCP servers.

## Add a New Specialist Agent

Create a specialist agent that the orchestrator routes tasks to automatically.

**Step 1 — Create the agent file** (`agents/rust-expert.md`):

```markdown
---
name: rust-expert
description: Rust code creation, modification, refactoring, and fixes. Specializes in ownership, lifetimes, async, and idiomatic Rust.
tools: read, write, edit, bash
---

You are a Rust Expert specializing in safe, performant, and idiomatic Rust code.

## Base Rules

- Execute first, explain after
- Do NOT explain what you will do — just do it
- Do NOT ask for confirmation unless creating/modifying resources
- If a task falls outside your domain, report it and hand off

## Core Expertise

- Ownership, borrowing, lifetimes
- Async: tokio, async-std
- Error handling: thiserror, anyhow
- Testing: cargo test, proptest
- Tooling: clippy, rustfmt, cargo-audit

## Quality Checklist

- [ ] `cargo clippy` passes with no warnings
- [ ] `cargo test` passes
- [ ] Error types use thiserror for libraries, anyhow for binaries
- [ ] Public APIs have doc comments
- [ ] Formatted with rustfmt
```

**Step 2 — Add routing** in `rules/10-agent-routing.md`:

```markdown
| Rust (.rs)                                                   | `rust-expert`                    |
```

**Step 3 — Register for bug reporting** in `rules/50-agent-bug-reporting.md` — add `rust-expert` to the agents list.

The agent file uses YAML frontmatter with three required fields: `name`, `description`, and `tools`. The body contains the system prompt. Changes take effect on the next pi session.

- **Minimal agent:** Only `name` and `description` are required in frontmatter. `tools` defaults to all available tools.
- **Read-only agents:** Set `tools: read, bash` for agents that should not modify files (like `scout` or `debugger`).
- **Model override:** Add `model: claude-haiku-4-5` to frontmatter for fast, cheap agents (the `scout` agent does this).

## Add a Project-Local Agent

Override or extend agents for a specific project without modifying pi-config.

Create `.pi/agents/qa-checker.md` in your project root:

```markdown
---
name: qa-checker
description: Project-specific QA validation — runs smoke tests and checks acceptance criteria.
tools: read, bash
---

You are a QA checker for this project. Run the smoke test suite and verify
acceptance criteria from the linked GitHub issue.

## Steps

1. Read the issue description for acceptance criteria
2. Run `make smoke-test`
3. Verify each criterion is met
4. Report pass/fail with evidence
```

Project agents (`.pi/agents/`) override package agents with the same name. User agents (`~/.pi/agent/agents/`) sit in between — the priority order is: package → user → project (later wins).

> **Tip:** Use project-local agents for workflows unique to one repository. Use user agents (`~/.pi/agent/agents/`) for personal agents shared across all your projects.

## Create a Custom Prompt Template

Add a new slash command that the orchestrator executes directly.

Create `prompts/lint-fix.md` in the pi-config repo (or `.pi/prompts/lint-fix.md` for project-local):

```markdown
---
description: "Run linter and auto-fix all issues — /lint-fix [path]"
argument-hint: "[path]"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension
> issues, or to the relevant tool's repository for CLI issues.

# Lint and Fix

Detect the project's linter and auto-fix all issues.

## Steps

1. Detect linter from project files:
   - `pyproject.toml` with `[tool.ruff]` → `uv run ruff check --fix .`
   - `package.json` with `eslint` → `npx eslint --fix .`
   - `Makefile` with `lint` target → `make lint`

2. Delegate to the appropriate language expert:
   - Python → `python-expert`
   - JS/TS → `ts-expert`
   - Go → `go-expert`

3. If a path was provided in raw arguments, scope to that path only.

4. Report what was fixed.
```

The `$ARGUMENTS` placeholder is replaced with whatever the user types after the command (e.g., `/lint-fix src/`). The `description` field appears in autocomplete. The bug reporting blockquote is mandatory for all prompt templates.

- **Project-local prompts** go in `.pi/prompts/` and are only available in that project.
- **Argument autocomplete:** If your command needs Tab completions, add an entry in `extensions/orchestrator/extended-autocomplete.ts`. See [Slash Commands and Extension Commands Reference](commands-reference.html) for all available commands.

## Create a Reusable Skill with /create-skill

Capture a successful workflow as a reusable skill that pi can apply to future tasks.

```text
/create-skill debug-flaky-test
```

Pi will:
1. Ask whether to save **globally** (`~/.agents/skills/`) or **per-project** (`.pi/skills/`)
2. Review the current conversation for steps, commands, and pitfalls
3. Write a `SKILL.md` file with the extracted workflow

The generated skill follows this structure:

```markdown
---
name: debug-flaky-test
description: "Diagnose and fix flaky tests caused by timing-sensitive assertions or shared state"
---

# Debug Flaky Test

## When to Use

- Test passes locally but fails in CI
- Test fails intermittently with no code changes

## Steps

1. Run the test 10 times: `uv run pytest tests/test_api.py -x --count=10`
2. Check for shared state: grep for module-level variables and class attributes
3. Check for timing: search for `sleep`, `time.time()`, hardcoded timeouts
4. Add isolation: use `tmp_path` fixtures, reset state in `setUp`/`tearDown`
5. Verify: run 50 times in CI-like conditions

## Pitfalls

- Don't just increase sleep timeouts — find the race condition
- Shared database fixtures are the #1 cause of flaky tests
```

Skills are automatically discovered by pi at session start. Global skills are available everywhere; project skills only in that project.

> **Tip:** The dreaming system (`/dream`) can also auto-generate project-level skills when it detects recurring multi-step workflows in your conversation history.

## Configure Project Settings

Customize pi behavior per-project using `.pi/pi-config-settings.json`.

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 2
}
```

Place this file at `.pi/pi-config-settings.json` in your project root.

| Setting | Type | Default | Effect |
|---------|------|---------|--------|
| `co_author` | boolean | `false` | Add co-author trailer to git commits |
| `use_worktrees` | boolean | `false` | Force worktree-only workflow for branches |
| `dream_interval_hours` | number | `3` | Hours between automatic memory consolidation |

Resolution order: project file → environment variable → default. Environment variables (`PI_CO_AUTHOR`, `PI_USE_WORKTREES`, `PI_DREAM_INTERVAL_HOURS`) serve as global fallbacks when no project file exists.

> **Note:** Changes to the settings file are picked up automatically within 30 seconds — no session restart needed. See [Configuration and Environment Variables Reference](configuration-reference.html) for the full list of env vars.

## Save a Memory with /remember

Persist a lesson, preference, or decision across sessions.

```text
/remember Always run pre-commit hooks before pushing — CI rejects unformatted code
```

Pi determines the best category automatically (`lesson`, `preference`, `decision`, `mistake`, `pattern`, or `done`) and saves it as a **pinned** memory that won't decay over time.

Under the hood, this runs:

```bash
uv run myk-pi-tools memory add -c lesson -s "Always run pre-commit hooks before pushing — CI rejects unformatted code" --pinned
```

See [Working with Project Memory](memory-system.html) for the full memory system.

## Search MCP Servers for Available Tools

Find and use tools from MCP servers configured via mcpl.

```bash
# Search for a tool by what it does
mcpl search "list projects"

# List all configured MCP servers
mcpl list

# List tools on a specific server
mcpl list vercel

# Get full schema with example call
mcpl inspect sentry search_issues --example

# Call a tool
mcpl call vercel list_projects '{"teamId": "team_xxx"}'
```

The orchestrator uses `mcpl search` or `mcpl list` to discover tools, then delegates actual tool execution to specialist agents. See [Orchestrator Rules Reference](rules-reference.html) for the MCP launchpad rules.

- **Verify connections:** Run `mcpl verify` to test all server connections.
- **Debug issues:** Run `mcpl session stop` to restart the daemon, then retry.
- **Timeout tuning:** Set `MCPL_CONNECTION_TIMEOUT=120` for slow servers.

## Add a Project-Local Prompt Template

Create a slash command available only in one project.

```bash
mkdir -p .pi/prompts
```

Create `.pi/prompts/deploy-staging.md`:

```markdown
---
description: "Deploy current branch to staging — /deploy-staging"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?"

# Deploy to Staging

1. Delegate to `git-expert`: ensure working tree is clean, all changes committed
2. Delegate to `worker`: run `make docker-build && make deploy-staging`
3. Delegate to `worker`: run `curl -sf https://staging.example.com/health` to verify
4. Report deployment status
```

After creating the file, run `/reload` in your pi session to register the new command. It will appear as `/deploy-staging` with Tab completion.

## Override a Built-in Agent for One Project

Customize a built-in agent's behavior in a specific project without forking pi-config.

Create `.pi/agents/python-expert.md` in your project:

```markdown
---
name: python-expert
description: Python expert customized for this Django project. Uses poetry, Django conventions, and pytest-django.
tools: read, write, edit, bash
---

You are a Python Expert for this Django project.

## Base Rules

- Execute first, explain after
- Do NOT explain what you will do — just do it
- If a task falls outside your domain, report it and hand off

## Project Conventions

- Package manager: poetry (NOT uv for this project)
- Framework: Django 5.x with DRF
- Tests: pytest-django with factory_boy fixtures
- Run tests: `poetry run pytest --reuse-db`
- Migrations: always run `poetry run python manage.py makemigrations` after model changes

## Quality Checklist

- [ ] `poetry run ruff check .` passes
- [ ] `poetry run pytest` passes
- [ ] Django migrations created for model changes
- [ ] ViewSet permissions tested
```

Since project agents override package agents by name, the orchestrator will use your customized `python-expert` instead of the built-in one — only in this project.

## Create a Multi-Agent Chain Prompt

Build a prompt that chains multiple specialist agents together.

Create `.pi/prompts/refactor-and-test.md`:

```markdown
---
description: "Refactor a module and add tests — /refactor-and-test <module>"
argument-hint: "<module>"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command — DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?"

Use the subagent tool with a chain of 3 agents:

1. **scout** — Find all usages, callers, and tests for the module from raw arguments.
   Return file locations, public API, and dependency graph.

2. **worker** — Based on {previous}, refactor the module:
   - Extract complex functions
   - Improve naming
   - Remove dead code
   - Preserve the public API

3. **test-automator** — Based on {previous}, add missing test coverage:
   - Unit tests for extracted functions
   - Edge case tests identified during refactoring
   - Verify existing tests still pass
```

The `{previous}` placeholder passes the output of one agent to the next. This pattern is used by the built-in `/implement` and `/scout-and-plan` commands.

## Set Up a Coms Feature Manager

Generate a project-specific inter-agent review workflow using the built-in template.

```text
/create-coms-feature-manager
```

Pi will:
1. Read the immutable template from `templates/coms-feature-manager-prompt.md`
2. Analyze your project (detect test commands, test locations, project type)
3. Ask if you need live/E2E verification
4. Fill all placeholders with project-specific values
5. Write `.pi/prompts/coms-feature-manager.md`

After running `/reload`, use `/coms-feature-manager` to activate a manager agent that reviews and directs a coder peer via the coms system.

> **Note:** This requires a running coms session. See [Communicating Between Pi Sessions](inter-agent-communication.html) for setup.

## Enable Co-Author Commit Trailers

Add pi as a co-author on all git commits in a project.

```bash
mkdir -p .pi
echo '{ "co_author": true }' > .pi/pi-config-settings.json
```

Or set globally via environment variable:

```bash
export PI_CO_AUTHOR=true
```

When enabled, the git-expert agent adds a `Co-authored-by` trailer to commit messages. The project setting overrides the env var.

## Force Worktree-Only Workflow

Prevent branch switching in the main worktree — essential for multi-PR parallel work.

```json
{
  "use_worktrees": true
}
```

Save to `.pi/pi-config-settings.json`. When enabled, pi uses `git worktree` for every branch operation instead of `git checkout`/`git switch`, preventing corruption when multiple agents work simultaneously.

## Adjust Dreaming Frequency

Control how often the background memory consolidation runs.

```json
{
  "dream_interval_hours": 1
}
```

The dreaming system scans conversation history and writes memories to topic files. The default interval is 3 hours. Set a lower value for active sessions where you want faster learning, or a higher value (up to 24) to reduce background work.

- **Manual trigger:** Run `/dream` to consolidate immediately.
- **Toggle auto-dreaming:** Run `/dream-auto off` to disable, `/dream-auto on` to re-enable.

## Create a Read-Only Analysis Agent

Build an agent that can investigate but never modify files.

```markdown
---
name: perf-analyzer
description: Performance analysis — profiles code, identifies bottlenecks, suggests optimizations. Does not modify files.
tools: read, bash
---

You are a performance analysis specialist. Profile code and identify bottlenecks.

## Base Rules

- Execute first, explain after
- Do NOT modify files — only analyze and report
- If a task falls outside your domain, report it and hand off

## Approach

1. Profile the target code path
2. Identify the top 3 bottlenecks
3. Measure baseline metrics
4. Report findings with specific optimization recommendations
5. Estimate expected improvement for each recommendation
```

By setting `tools: read, bash`, the agent cannot use `write` or `edit`. This is the same pattern used by `scout`, `planner`, `debugger`, and the code reviewer agents.

## Related Pages

- [Specialist Agents Reference](agents-reference.html)
- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Working with Project Memory](memory-system.html)
