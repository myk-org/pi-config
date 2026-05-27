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
│   │   ├── async-agents.ts          # Async background agent infrastructure (fireAndForget support)
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── btw.ts                   # /btw command
│   │   ├── cron.ts                   # /cron scheduled tasks (interval/time-based)
│   │   ├── dreaming.ts              # Background memory consolidation (inspired by OpenClaw)
│   │   ├── pidash.ts                # Live web dashboard extension (connects to pidash daemon, forwards provider response info)
│   │   ├── pidash-ui/               # React + shadcn/ui web dashboard
│   │   │   ├── src/                 # React source (components, hooks, types)
│   │   │   └── dist/               # Built output (generated, gitignored)
│   │   ├── pidiff.ts                # Standalone diff viewer extension (spawns/connects to pidiff daemon)
│   │   ├── pidiff-ui/               # React diff viewer UI (@pierre/diffs + @pierre/trees)
│   │   ├── daemon-manager.ts        # Shared daemon infrastructure (pidash + pidiff)
│   │   ├── enforcement.ts           # Command enforcement (python/pip, git, security, dangerous)
│   │   ├── extended-autocomplete.ts  # Slash command argument completions (agents, branches, PRs, tags)
│   │   ├── github-autocomplete.ts   # GitHub issue # autocomplete provider
│   │   ├── git-helpers.ts           # Git utility functions
│   │   ├── icons.ts                 # Shared Nerd Font icon constants
│   │   ├── rules.ts                 # Rule + memory injection (before_agent_start)
│   │   ├── session-search.ts            # Keyword search over past conversation summaries
│   │   ├── session-validation.ts    # Session start tool checks + upgrade changelog notification
│   │   ├── nvim.ts                  # Neovim integration (quickfix, /nvim-changed-files)
│   │   ├── status.ts                # /status command — unified session status snapshot
│   │   ├── status-line.ts           # Git status, notifications, container indicator, last-activity timestamp
│   │   ├── memory-scoring.ts          # Stability-based memory scoring engine
│   │   ├── memory-tools.ts              # AI-accessible memory tools (search, reinforce, add, remove)
│   │   ├── memory-tree.ts             # Hierarchical topic-based memory organization
│   │   ├── preference-extractor.ts    # Auto-extract user preferences from conversation
│   │   ├── prompt-guard.ts            # Prompt injection detection for tool results
│   │   ├── situation-report.ts        # Token-budgeted memory context for system prompts
│   │   ├── subagent-tool.ts         # Subagent tool + runSingleAgent (async-only enforcement for reviewers)
│   │   └── utils.ts                 # Shared utilities
│   └── acpx-provider/              # ACPX provider extension (acpx/runtime library API)
│       └── index.ts                # Provider + exported discoverAcpxModels() for external consumers
├── prompts/                         # Prompt templates (slash commands)
│   ├── external-ai.md
│   ├── coderabbit-rate-limit.md
│   ├── dream.md
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
│   ├── ai_cli/
│   ├── cli.py
│   ├── coderabbit/
│   ├── db/
│   ├── memory/
│   ├── pr/
│   ├── release/
│   └── reviews/
├── scripts/                         # Utility scripts
│   ├── docker-safe                  # Restricted Docker/Podman CLI wrapper (container only)
│   ├── httpd.py                     # HTTP file server for file preview (used by rules/45-file-preview.md)
│   ├── pidash-server.ts             # Pidash daemon (WebSocket hub for all pi sessions + Discord bot)
│   ├── pidiff-server.ts             # Pidiff daemon (multi-session diff hub with review comments)
│   └── serve-ui.ts                  # Shared static UI serving + auto-build for daemon servers
├── .coderabbit.yaml                 # CodeRabbit CLI config (assertive profile, linter selection)
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

### Async-Only Agents

Some agents are enforced to only run with `async: true` — sync calls are rejected
by `subagent-tool.ts` with an error. This prevents the LLM from blocking the session
waiting for long-running agents.

**Currently enforced:**

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

**To add/remove agents from the async-only list:**

1. Edit the `ASYNC_ONLY_AGENTS` set in `extensions/orchestrator/subagent-tool.ts`
2. Update this section in `AGENTS.md`

### Adding an Extension Command

Extension commands (like `/pidash`, `/pidiff`, `/btw`, `/status`) are registered in
the extension source files under `extensions/orchestrator/`. Each command uses
`context.registerCommand()` with a name, description, and handler.

Known extension commands:

| Command | Source | Description |
|---------|--------|-------------|
| `/btw` | `btw.ts` | Quick side questions |
| `/pidash` | `pidash.ts` | Manage pidash daemon (start/stop/restart/status) |
| `/pidiff` | `pidiff.ts` | Manage pidiff daemon (start/stop/restart/status) |
| `/status` | `status.ts` | Unified session status snapshot |
| `/async-status` | `async-agents.ts` | Background agent status |
| `/dream` | `dreaming.ts` | Memory consolidation |
| `/dream-auto` | `dreaming.ts` | Toggle automatic dreaming |
| `/cron` | `cron.ts` | Schedule recurring tasks |
| `/nvim-changed-files` | `nvim.ts` | Send changed files to nvim quickfix |
| `/external-ai-models-refresh` | `extended-autocomplete.ts` | Refresh AI CLI model cache |

### Adding a Prompt Template

1. Create a `.md` file in `prompts/` with YAML frontmatter:

   ```markdown
   ---
   description: "Short description of what this command does — /command-name <args>"
   ---
   ```

2. **MUST include the bug reporting policy blockquote** after the
   Raw Arguments section — this is mandatory for every prompt template.
   The Raw Arguments block (`## Raw Arguments` + `$ARGUMENTS`) comes first
   (pi substitutes it at load time), then the command title, then the policy:

   ```markdown
   > **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug while executing this command — DO NOT work around it silently. Ask the user: "Should I create a GitHub issue for this?" Route to `myk-org/pi-config` for prompt/extension issues, or to the relevant tool's repository for CLI issues.
   ```

3. Write the prompt body after the blockquote.

4. **If the prompt accepts arguments**, add autocomplete support in
   `extensions/orchestrator/extended-autocomplete.ts` — add an entry to the
   `completions` map and include the command name in `promptTemplateCommands`.
   This gives users Tab-completion for your command's arguments.

### Modifying Slash Command Arguments

When adding, changing, or removing arguments for any slash command (prompt template
or extension command):

- ✅ Update autocomplete in `extensions/orchestrator/extended-autocomplete.ts`
- Extension commands: update the entry in the `completions` map
- Prompt templates: update the entry in `completions` AND ensure the command is in `promptTemplateCommands`
- If adding a new completable command, follow the existing patterns (static items, cached fetchers, etc.)

### Memory Evolution — Scored Learning, Situation Reports, Memory Tree

Three-layer memory system with scored,
prioritized, topic-organized context injection.

Architecture inspired by [OpenHuman](https://github.com/tinyhumansai/openhuman).
Clean-room TypeScript implementation under MIT — not a code translation.

**Layer 1 — Scored Memory** (`memory-scoring.ts`):

- Stability formula: `cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)`
- 6 categories with decay half-lives (preference=90d, lesson=60d, done=14d)
- Lifecycle states: active → provisional → candidate → dropped
- Per-category budget caps, pinned/forgotten overrides
- Companion file: `.pi/memory/memory-scores.json`

**Layer 2 — Situation Reports** (`situation-report.ts`):

- Token-budgeted context replaces raw memory dump in system prompt
- Sections by priority: preferences → lessons → mistakes → patterns → decisions → completions
- Lower-priority sections truncated when budget exceeded

**Layer 3 — Memory Tree** (`memory-tree.ts`):

- Entries organized into topic files under `.pi/memory/topics/`
- Each topic limited to ~3000 tokens
- Topics have hotness scores (reinforcement frequency)
- Cold topics archived automatically (no reinforcement for 2× half-life)

**Memory Tools** (`memory-tools.ts`):

- `memory_search`: keyword search across all topic entries
- `memory_reinforce`: bump evidence count to prevent decay
- `memory_add`: LLM-initiated memory writes (pinned or learned)
- `memory_remove`: LLM-initiated entry removal
- `memory_topics`: list topic files with hotness scores

**Session Search** (`session-search.ts`):

- JSON-based keyword search over past conversation summaries
- Indexed on session shutdown from compaction summaries
- Storage: `.pi/data/session-search.json`

**Capacity Signal** (`situation-report.ts`):

- Header shows usage %: `# Project Memory [72% — 1,224/1,700 tokens]`
- Consolidation warning injected when usage exceeds 80%

**Preference Auto-Extraction** (`preference-extractor.ts`):

- Detects "I prefer...", "always use...", "never..." in user messages
- Auto-adds to memory with explicit cue weight
- Reinforces existing preferences on repetition

## Docker / Dockerfile

This repo includes a `Dockerfile` for running pi in a sandboxed container.
The image is published at `ghcr.io/myk-org/pi-config:latest`.

**When adding a new feature that requires a new CLI tool or system dependency:**

- ✅ Update the `Dockerfile` to install the new tool
- ✅ Update the README Docker section if new mounts or env vars are needed
- ❌ Never assume a tool exists in the container — check the Dockerfile

## Generated Documentation (`docs/`)

The `docs/` directory contains documentation generated by [docsfy](https://github.com/myk-org/docsfy).
Served via [GitHub Pages](https://myk-org.github.io/pi-config/).

**Rules:**

- ❌ **NEVER** edit files in `docs/` manually — they are regenerated and will be overwritten
- ✅ To update docs, re-run `docsfy generate` to regenerate from source

---

## Running Tests

```bash
# Linting / pre-commit checks
pre-commit run --all-files

# Python tests
uv run pytest
```
