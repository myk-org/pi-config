# Pi Config — Repo Contributor Rules

This is the **pi-config** repository — the central configuration that controls how pi
operates for all users. Modifying agents, rules, extensions, or prompt templates here
changes the behavior of every pi session that loads this config. Treat changes with care:
a broken rule or misconfigured agent affects everyone.

## Repository Structure

```text
pi-config/
├── agents/                          # Specialist agent definitions
│   ├── api-documenter.md
│   ├── bash-expert.md
│   ├── code-reviewer-guidelines.md
│   ├── code-reviewer-quality.md
│   ├── code-reviewer-security.md
│   ├── debugger.md
│   ├── docker-expert.md
│   ├── docs-fetcher.md
│   ├── frontend-expert.md
│   ├── git-expert.md
│   ├── github-expert.md
│   ├── go-expert.md
│   ├── java-expert.md
│   ├── jenkins-expert.md
│   ├── kubernetes-expert.md
│   ├── planner.md
│   ├── python-expert.md
│   ├── reviewer.md
│   ├── scout.md
│   ├── security-auditor.md
│   ├── technical-documentation-writer.md
│   ├── test-automator.md
│   ├── test-runner.md
│   └── worker.md
├── extensions/                      # Pi extensions (loaded automatically)
│   ├── orchestrator/                # Orchestrator extension
│   │   ├── index.ts                 # Main entry — imports and wires all modules
│   │   ├── agents.ts                # Agent discovery
│   │   ├── ask-user.ts              # ask_user tool
│   │   ├── async-agents.ts          # Async background agent infrastructure
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── btw.ts                   # /btw command
│   │   ├── diffity.ts               # Auto-start diffity diff viewer
│   │   ├── enforcement.ts           # Command enforcement (python/pip, git, security, dangerous)
│   │   ├── git-helpers.ts           # Git utility functions
│   │   ├── icons.ts                 # Shared Nerd Font icon constants
│   │   ├── rules.ts                 # Rule + memory injection (before_agent_start)
│   │   ├── session-validation.ts    # Session start tool checks
│   │   ├── status-line.ts           # Git status, notifications, container indicator
│   │   ├── subagent-tool.ts         # Subagent tool + runSingleAgent
│   │   └── utils.ts                 # Shared utilities
│   └── acpx-provider/              # ACPX provider extension
│       └── index.ts
├── prompts/                         # Prompt templates (slash commands)
│   ├── acpx-prompt.md
│   ├── coderabbit-rate-limit.md
│   ├── implement-and-review.md
│   ├── implement.md
│   ├── pr-review.md
│   ├── query-db.md
│   ├── refine-review.md
│   ├── release.md
│   ├── remember.md
│   ├── review-handler.md
│   ├── review-local.md
│   └── scout-and-plan.md
├── rules/                           # Orchestrator rules (auto-loaded alphabetically)
│   ├── 00-orchestrator-core.md
│   ├── 05-issue-first-workflow.md
│   ├── 10-agent-routing.md
│   ├── 15-mcp-launchpad.md
│   ├── 20-code-review-loop.md
│   ├── 25-documentation-updates.md
│   ├── 30-prompt-templates.md
│   ├── 35-memory.md
│   ├── 40-critical-rules.md
│   ├── 45-file-preview.md
│   └── 50-agent-bug-reporting.md
├── myk_pi_tools/                    # Python CLI tooling package
│   ├── __init__.py
│   ├── cli.py
│   ├── coderabbit/
│   ├── db/
│   ├── memory/
│   ├── pr/
│   ├── release/
│   └── reviews/
├── scripts/                         # Utility scripts
│   └── docker-safe                  # Restricted Docker/Podman CLI wrapper (container only)
├── Dockerfile                       # Container image definition
├── entrypoint.sh                    # Container entrypoint
├── README.md                        # Project README
├── AGENTS.md                        # This file
├── package.json                     # Node.js dependencies (extensions)
└── pyproject.toml                   # Python project config (myk_pi_tools)
```

## Development Guidelines

### Adding a New Agent

1. **Create the agent file** in `agents/` with YAML frontmatter:

   ```markdown
   ---
   name: my-new-agent
   description: What this agent does — one sentence.
   tools: read, write, edit, bash
   ---

   Agent instructions go here...
   ```

2. **Add routing** in `rules/10-agent-routing.md` — add a row to the routing table
   mapping the domain/task to your new agent.

3. **Update the agents list** in `rules/50-agent-bug-reporting.md` — add the agent
   name to the "Agents Covered by This Rule" list so bug reporting covers it.

4. **Test delegation** — start a pi session and verify the orchestrator correctly
   routes tasks to your new agent.

### Removing an Agent

1. **Delete** the agent file from `agents/`.
2. **Remove** the routing entry from `rules/10-agent-routing.md`.
3. **Remove** the agent from the list in `rules/50-agent-bug-reporting.md`.

### Modifying Orchestrator Rules

- Edit files in the `rules/` directory.
- Rules auto-load in **alphabetical order** (hence the numeric prefixes).
- Changes take effect on the **next pi session** — no restart of running sessions.

### Adding a Prompt Template

1. Create a `.md` file in `prompts/` with YAML frontmatter:

   ```markdown
   ---
   description: "Short description of what this command does — /command-name <args>"
   ---
   ```

2. **MUST include the bug reporting policy blockquote** immediately after the
   frontmatter — this is mandatory for every prompt template:

   ```markdown
   > **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug while executing this command — DO NOT work around it silently. Ask the user: "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.
   ```

3. Write the prompt body after the blockquote.

## Docker / Dockerfile

This repo includes a `Dockerfile` for running pi in a sandboxed container.
The image is published at `ghcr.io/myk-org/pi-config:latest`.

**When adding a new feature that requires a new CLI tool or system dependency:**

- ✅ Update the `Dockerfile` to install the new tool
- ✅ Update the README Docker section if new mounts or env vars are needed
- ❌ Never assume a tool exists in the container — check the Dockerfile

## Running Tests

```bash
# Linting / pre-commit checks
pre-commit run --all-files

# Python tests
uv run pytest
```
