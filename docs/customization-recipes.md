# Customization and Extension Recipes

Recipes for tailoring pi to your project — adding specialist agents, building prompt templates, capturing skills, tuning project settings, and connecting MCP servers.

## Add a Project-Scoped Specialist Agent

Create an agent that's available only within a specific project.

```markdown
<!-- File: .pi/agents/terraform-expert.md -->
---
name: terraform-expert
description: Terraform and OpenTofu infrastructure-as-code creation, modification, and troubleshooting.
tools: read, write, edit, bash
---

You are a Terraform Expert specializing in infrastructure-as-code.

## Base Rules

- Execute first, explain after
- Do NOT explain what you will do — just do it
- Do NOT ask for confirmation unless creating/modifying resources
- If a task falls outside your domain, report it and hand off

## Core Expertise

- Terraform and OpenTofu (HCL syntax, modules, state)
- Providers: AWS, GCP, Azure, Kubernetes
- Remote state (S3, GCS, Consul)
- Sentinel and OPA policy-as-code

## Quality Checklist

- [ ] `terraform fmt` passes
- [ ] `terraform validate` passes
- [ ] Variables have descriptions and types
- [ ] Outputs documented
- [ ] State locking configured
```

The agent file must have YAML frontmatter with `name`, `description`, and `tools`. Place it in `.pi/agents/` (project-scoped) or `~/.pi/agent/agents/` (user-global). Pi discovers it automatically on the next session — no restart needed.

- **Supported frontmatter fields:** `name` (required), `description` (required), `tools` (comma-separated), `model` (override LLM model), `provider` (override LLM provider)
- **Override built-in agents:** a project agent with the same `name` as a package agent replaces it
- **Priority:** package agents < user agents < project agents (later overrides earlier by name)

> **Note:** After adding the agent, update the routing table in `rules/10-agent-routing.md` so the orchestrator knows when to use it. See [Understanding Agent Routing and Delegation](agent-routing.html) for details.

## Add a Lightweight Agent with a Model Override

Create a cheap, fast agent for simple tasks by pinning it to a smaller model.

```markdown
<!-- File: .pi/agents/quick-formatter.md -->
---
name: quick-formatter
description: Fast code formatting and linting fixes using a lightweight model.
tools: read, write, edit, bash
model: claude-haiku-4-5
---

You are a code formatter. Run the project's formatter and linter, fix any issues.

## Approach

1. Detect the project type (package.json, pyproject.toml, Cargo.toml)
2. Run the formatter (prettier, ruff format, rustfmt)
3. Run the linter and fix auto-fixable issues
4. Report what changed
```

The `model` field in frontmatter forces this agent to always use the specified model, regardless of what the parent session is running. Use this for agents that don't need a large reasoning model.

## Create a Custom Prompt Template

Build a reusable slash command that becomes available as `/my-command`.

```markdown
<!-- File: .pi/prompts/lint-and-fix.md -->
---
description: "Run linters, fix all auto-fixable issues, and report remaining problems — /lint-and-fix [path]"
argument-hint: "[path]"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug while executing this command — DO NOT work around it silently. Ask the user: "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.

# Lint and Fix

Run all project linters with auto-fix enabled, then report remaining issues.

## Workflow

1. Detect the project type and available linters
2. Run auto-fix:
   - Python: `uv run ruff check --fix . && uv run ruff format .`
   - Node.js: `npx eslint --fix . && npx prettier --write .`
   - Go: `gofmt -w . && golangci-lint run --fix`
3. Run a second pass without `--fix` to collect remaining issues
4. Report: files changed, issues fixed, issues remaining
```

Place the file in `.pi/prompts/` and reload pi (or start a new session). The file name becomes the command name — `lint-and-fix.md` → `/lint-and-fix`. The `$ARGUMENTS` placeholder is replaced with whatever the user types after the command.

> **Warning:** Every prompt template **must** include the Bug Reporting Policy blockquote after the Raw Arguments section. This is mandatory for all templates.

- The `description` field in frontmatter is displayed in command completion
- The `argument-hint` field shows usage hints during autocomplete
- The orchestrator executes the prompt directly — it is **not** delegated to an agent (see [Orchestrator Rules Reference](rules-reference.html))

## Save a Workflow as a Reusable Skill

Capture a successful multi-step workflow from the current conversation so pi can replay it later.

```text
/create-skill debug-container-build
```

Pi will:

1. Analyze the current conversation to extract the steps you followed
2. Ask whether to save **globally** (`~/.agents/skills/`) or **per-project** (`.pi/skills/`)
3. Write a `SKILL.md` file with exact commands, verification steps, and pitfalls

The resulting skill file looks like this:

```markdown
<!-- Generated: ~/.agents/skills/debug-container-build/SKILL.md -->
---
name: debug-container-build
description: "Debug Docker multi-stage build failures by isolating the failing stage and inspecting intermediate layers"
---

# Debug Container Build

## When to Use

- Docker multi-stage build fails at an intermediate stage
- Build cache invalidation causes unexpected rebuilds

## Steps

1. Identify the failing stage: `docker build --target <stage> .`
2. Run the intermediate image interactively: `docker run --rm -it <image> sh`
3. Check file permissions and paths inside the container
4. Fix the Dockerfile and rebuild with `--no-cache` for the failing stage

## Pitfalls

- Alpine images use `ash` not `bash` — use `sh` for shell access
- Multi-stage COPY --from references are positional if stages are unnamed
```

> **Tip:** Run `/create-skill` immediately after solving a tricky problem — the conversation context is freshest. Skill names must be lowercase and hyphenated (e.g., `fix-flaky-tests`, not `Fix Flaky Tests`).

## Configure Project Settings

Customize pi's behavior per-project using `.pi/pi-config-settings.json`.

```json
{
  "co_author": true,
  "use_worktrees": false,
  "dream_interval_hours": 6
}
```

Create this file at `.pi/pi-config-settings.json` in your project root. Settings take effect on the next session start.

| Setting | Type | Default | Effect |
|---------|------|---------|--------|
| `co_author` | boolean | `false` | Add `Co-authored-by: pi` trailer to git commits |
| `use_worktrees` | boolean | `false` | Force worktree-only workflow (no branch switching in main worktree) |
| `dream_interval_hours` | number | `3` | How often auto-dreaming runs (memory consolidation) |

- **Resolution order:** project file → environment variable → default
- **Environment variables:** `PI_CO_AUTHOR`, `PI_USE_WORKTREES`, `PI_DREAM_INTERVAL_HOURS` are used as fallbacks if the setting isn't in the JSON file
- **Live reload:** the settings file is re-read on a throttled interval (every 30 seconds) — edits take effect without restarting

See [Configuration and Environment Variables Reference](configuration-reference.html) for the full list of environment variables.

## Discover and Use MCP Server Tools

Find and call tools from MCP (Model Context Protocol) servers using `mcpl`.

```bash
# Search for a tool across all connected servers
mcpl search "list projects"

# List all tools on a specific server
mcpl list vercel

# Get full schema with an example call
mcpl inspect sentry search_issues --example

# Call a tool with arguments
mcpl call vercel list_projects '{"teamId": "team_xxx"}'

# Verify all server connections are healthy
mcpl verify
```

The orchestrator uses `mcpl search` and `mcpl list` for discovery, then delegates actual tool execution to specialist agents. You don't need to configure MCP servers in pi-config — they're managed by your MCP server configuration (e.g., `mcp.json`).

- **Never guess tool names** — always `mcpl search` or `mcpl list` first
- **Troubleshoot connections:** `mcpl verify` tests all servers, `mcpl session stop` restarts the daemon
- **Timeout issues:** set `MCPL_CONNECTION_TIMEOUT=120` for slow servers

See [Orchestrator Rules Reference](rules-reference.html) for how MCP tools fit into the delegation model.

## Override a Built-In Agent for Your Project

Replace a package-bundled agent with a customized version for your project.

```markdown
<!-- File: .pi/agents/python-expert.md -->
---
name: python-expert
description: Python expert customized for our Django + Celery monorepo.
tools: read, write, edit, bash
---

You are a Python Expert for this Django + Celery monorepo.

## Base Rules

- Execute first, explain after
- Do NOT ask for confirmation unless creating/modifying resources
- If a task falls outside your domain, report it and hand off

## Project Conventions

- Always use `uv run` and `uvx` — never raw `python` or `pip`
- Models go in `apps/<app>/models/` — one model per file
- Use `pytest-django` with `@pytest.mark.django_db` for DB tests
- Celery tasks must have `bind=True, max_retries=3, default_retry_delay=60`
- All API views use `rest_framework.decorators.api_view`, never class-based views

## Quality Checklist

- [ ] `uv run ruff check --fix .` passes
- [ ] `uv run pytest --tb=short` passes
- [ ] Type hints on all public functions
- [ ] Celery tasks have retry config
```

Because the project agent's `name` field matches the built-in `python-expert`, it completely replaces the package version for this project. Other projects continue using the original.

## Add Autocomplete for a Custom Prompt Template

Wire up Tab-completion for a custom prompt template's arguments.

To add autocomplete for your own prompt template, edit `extensions/orchestrator/extended-autocomplete.ts`:

```typescript
// 1. Add the completion function to the `completions` map:
"my-command": (prefix: string) => {
  return filter([
    { value: "--verbose", label: "--verbose", description: "Show detailed output" },
    { value: "--dry-run", label: "--dry-run", description: "Preview without changes" },
    { value: "src/", label: "src/", description: "Source directory" },
    { value: "tests/", label: "tests/", description: "Test directory" },
  ], prefix);
},

// 2. Add the command name to promptTemplateCommands:
const promptTemplateCommands = new Set([
  "external-ai", "pr-review", "coderabbit-rate-limit",
  "review-local", "release", "review-handler", "cron",
  "create-skill", "create-coms-feature-manager",
  "my-command",  // ← add here
]);
```

This gives users Tab-completion when typing `/my-command <Tab>`. Extension commands (registered via `pi.registerCommand`) get autocomplete automatically through the `getArgumentCompletions` wrapper — only prompt templates need this manual step.

> **Note:** This recipe requires modifying the pi-config source. See [Extension Architecture and Lifecycle Hooks](extension-architecture.html) for how the autocomplete system works.

## Store a Permanent Memory via /remember

Save a project convention or preference that persists across sessions.

```text
/remember Always use conventional commits: feat(), fix(), chore(), docs()
```

This creates a **pinned** memory entry that won't decay over time. Pi automatically categorizes it (preference, lesson, decision, pattern, mistake, or done) and stores it in the topic-based memory system.

```text
/remember We deploy to staging via: make deploy-staging ENV=stg
/remember The payments service is owned by team-billing — always tag them on payment PRs
/remember Never use SELECT * in production queries — always specify columns
```

- Pinned memories have maximum stability score and never expire
- Use `/remember` for hard rules; let pi's auto-extraction handle soft preferences (e.g., "I prefer tabs over spaces" said in conversation)
- View stored memories with `memory_search` or `/dream` for consolidation

See [Working with Project Memory](memory-system.html) for the full memory system guide.

## Create a Multi-Agent Prompt Template with Chain

Build a prompt that runs multiple agents in sequence, passing results between them.

```markdown
<!-- File: .pi/prompts/refactor-safely.md -->
---
description: "Scout → plan → refactor → test a component — /refactor-safely <component>"
argument-hint: "<component>"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug while executing this command — DO NOT work around it silently. Ask the user: "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.

# Safe Refactor

Use the subagent tool with a chain of 4 agents:

1. **scout** — Find all files, functions, and tests related to the component described above.
   Return file paths, key functions, import chains, and test coverage.

2. **planner** — Based on {previous}, create a refactoring plan:
   - Files to modify and why
   - New abstractions to introduce
   - Breaking changes and migration steps
   - What tests need updating

3. **worker** — Based on {previous}, execute the refactoring:
   - Make all code changes
   - Update imports across the codebase
   - Keep backward compatibility where noted in the plan

4. **test-automator** — Based on {previous}, verify and update tests:
   - Run existing tests, fix any failures caused by the refactoring
   - Add tests for new abstractions
   - Ensure coverage doesn't decrease
```

The `{previous}` placeholder is automatically replaced with the output of the preceding agent in the chain. See [Using Slash Commands and Prompt Templates](slash-commands.html) for more on how prompt templates interact with the orchestrator.

## Set Up a Project-Scoped .gitignore for Pi Files

Ensure pi's working files don't leak into your repository.

```gitignore
# Add to your project's .gitignore
.pi/
```

The `.pi/` directory contains all pi state — memory, settings, skills, agents, temp files, and async worker data. It should always be gitignored. The container entrypoint adds this automatically, but for native installs, add it manually.

> **Tip:** If you need to version-control your project agents or prompts (so teammates share them), move them to a committed directory and symlink:
> ```bash
> # Version-controlled agents
> mkdir -p .agents/
> ln -s ../.agents .pi/agents
> ```

## Related Pages

- [Specialist Agents Reference](agents-reference.html)
- [Understanding Agent Routing and Delegation](agent-routing.html)
- [Using Slash Commands and Prompt Templates](slash-commands.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
- [Working with Project Memory](memory-system.html)
