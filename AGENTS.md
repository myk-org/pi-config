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
│   ├── ts-expert.md
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
│   │   ├── async-agents.ts          # Async background agent infrastructure (fireAndForget, group-aware delivery)
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── btw.ts                   # /btw command
│   │   ├── cron.ts                   # /cron scheduled tasks (interval/time-based)
│   │   ├── dreaming.ts              # Background memory consolidation (inspired by OpenClaw)
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
│   │   ├── memory-embeddings.ts         # Vector embedding support for semantic memory search (fastembed)
│   │   ├── memory-tree.ts             # Hierarchical topic-based memory organization
│   │   ├── preference-extractor.ts    # Auto-extract user preferences from conversation
│   │   ├── project-settings.ts        # Project-level settings (.pi/pi-config-settings.json)
│   │   ├── situation-report.ts        # Token-budgeted memory context for system prompts
│   │   ├── subagent-tool.ts         # Subagent tool + runSingleAgent (async-only enforcement for reviewers)
│   │   └── utils.ts                 # Shared utilities (getProjectTmpDir, tryGetSystemPromptOptions, etc.)
│   ├── coms/                        # Inter-agent communication extension (standalone)
│   │   ├── index.ts                 # Entry point — registers coms and coms-net
│   │   ├── coms-wrapper.ts          # P2P agent communication wrapper (on-demand /coms command)
│   │   ├── coms-net-wrapper.ts      # Networked agent communication wrapper (on-demand /coms-net command, auto-manages hub server)
│   │   ├── coms-shared.ts           # Shared proxy factory, flag parser, state persistence
│   │   ├── coms-p2p.ts              # P2P implementation (forked from disler/pi-vs-claude-code)
│   │   ├── coms-net.ts              # Networked implementation (forked from disler/pi-vs-claude-code)
│   │   ├── coms-net-server.ts       # Hub server (forked from disler/pi-vs-claude-code)
│   │   └── themeMap.ts              # Theme utilities (forked from disler/pi-vs-claude-code)
│   ├── pidash/                      # Live web dashboard extension (standalone)
│   │   ├── index.ts                 # Entry point
│   │   ├── pidash.ts                # Dashboard logic (connects to pidash daemon, forwards provider response info)
│   │   └── pidash-ui/               # React + shadcn/ui web dashboard
│   │       ├── src/                 # React source (components, hooks, types)
│   │       └── dist/               # Built output (generated, gitignored)
│   ├── pidiff/                      # Diff viewer extension (standalone)
│   │   ├── index.ts                 # Entry point
│   │   ├── pidiff.ts                # Diff viewer logic (spawns/connects to pidiff daemon)
│   │   └── pidiff-ui/               # React diff viewer UI (@pierre/diffs + @pierre/trees)
│   ├── shared/                      # Shared extension utilities
│   │   ├── daemon-manager.ts        # Daemon infrastructure (spawn, health check, WebSocket) — shared by pidash and pidiff
│   │   ├── ws-client.ts             # WebSocket heartbeat + reconnect helpers (used by pidash, pidiff)
│   │   └── ui/                      # Shared shadcn/ui components (used by pidash-ui and pidiff-ui via @ui alias)
│   ├── acpx-provider/              # ACPX provider extension (acpx/runtime library API)
│   │   └── index.ts                # Provider + exported discoverAcpxModels() for external consumers
│   └── image-gen/                   # Image generation extension (standalone)
│       ├── index.ts                # Entry point — registers generate_image tool
│       └── image-gen.ts            # Gemini API image generation (env: PI_IMAGE_MODEL, GEMINI_API_KEY)
├── templates/                       # Immutable prompt templates (source files for /create-* commands)
│   └── coms-feature-manager-prompt.md  # Coms feature manager template
├── prompts/                         # Prompt templates (slash commands)
│   ├── create-coms-feature-manager.md
│   ├── external-ai.md
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
│   ├── 50-agent-bug-reporting.md
│   ├── 55-coms-protocol.md
│   └── 60-task-tracking.md
├── myk_pi_tools/                    # Python CLI tooling package
│   ├── __init__.py
│   ├── ai_cli/
│   ├── cli.py
│   ├── coderabbit/
│   ├── db/
│   ├── memory/
│   ├── platform/
│   │   ├── __init__.py              # Re-exports: Platform, detect_platform, ReviewThread, PRMetadata, ChangedFile
│   │   ├── base.py                  # Platform ABC + platform-neutral dataclasses
│   │   ├── detect.py                # detect_platform() factory — strict detection, no fallbacks
│   │   ├── github.py                # GitHubPlatform implementation (uses gh)
│   │   └── gitlab.py                # GitLabPlatform implementation (uses glab)
│   ├── pr/
│   │   └── pr_review_store.py       # PR review comment tracking (pr-reviews.db, platform column)
│   ├── release/
│   └── reviews/
├── scripts/                         # Utility scripts
│   ├── docker-safe                  # Restricted Docker/Podman CLI wrapper (container only)
│   ├── httpd.py                     # HTTP file server for file preview (used by rules/45-file-preview.md)
│   ├── pidash-server.ts             # Pidash daemon (WebSocket hub for all pi sessions + Discord bot)
│   ├── pidiff-server.ts             # Pidiff daemon (multi-session diff hub with review comments)
│   ├── serve-ui.ts                  # Shared static UI serving + auto-build for daemon servers
│   └── install.py                   # Interactive TUI installer for native deployment (questionary)
├── .coderabbit.yaml                 # CodeRabbit CLI config (assertive profile, linter selection)
├── Dockerfile                       # Container image definition
├── entrypoint.sh                    # Container entrypoint
├── README.md                        # Project README
├── AGENTS.md                        # This file
├── pi-config-settings.example.json    # Example project settings file
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

Rules are loaded from three directories (later layers override same-filename entries):

| Layer | Path | Scope | Number range |
|-------|------|-------|--------------|
| Package | `<pi-config>/rules/` | All users, all projects | `00-69` |
| User | `~/.pi/agent/rules/` | All projects for this user | `70-89` |
| Project | `<project>/.pi/rules/` | Current project only | `90-99` |

- Rules auto-load in **alphabetical order** (hence the numeric prefixes).
- Same-filename override: project > user > package.
- Missing directories are silently skipped.
- Changes take effect on the **next pi session** — no restart of running sessions.

### Async-Only Agents

Some agents are enforced to only run with `async: true` — sync calls are automatically
promoted to async by `subagent-tool.ts`. This prevents the LLM from blocking the session
waiting for long-running agents.

**Currently enforced:**

- `code-reviewer-quality`
- `code-reviewer-guidelines`
- `code-reviewer-security`

**To add/remove agents from the async-only list:**

1. Edit the `ASYNC_ONLY_AGENTS` set in `extensions/orchestrator/subagent-tool.ts`
2. Update this section in `AGENTS.md`

### Project-Scoped Temp Directories

All async agent temp files live under project-scoped subdirectories:

```text
.pi/tmp/
├── debug.log                    # Async debug log
├── cron-<pid>-<suffix>.json     # Cron task state (session-unique suffix prevents container PID collisions)
├── .repeat-<pid>.json           # Repeat command detection
├── nvim-<pid>-<ts>.lua          # Nvim integration (ephemeral)
├── nvim-qf-<pid>-<ts>.json      # Nvim quickfix data (ephemeral)
├── async-cfg-<id>.json          # Async runner config (ephemeral)
├── subagent-<random>/           # Subagent prompt temp dir (ephemeral)
├── async-results-pid-<pid>-<starttime>/  # Async agent completion results (starttime prevents container PID collisions)
└── worker-<id>/                 # Async agent working dir
    ├── status.json              # Agent state (running/complete/failed)
    ├── session.json             # Parent PID + starttime for zombie detection
    ├── output.log               # Agent output
    └── system-prompt.md         # Agent system prompt
```

**Zombie cleanup:** On `session_start`, scans project dir for dead agents.
Checks each agent's `parentPid` + `parentStartTime` against `/proc/PID/stat` field 22.
Dead parent = zombie = delete.

**Shared helper:** `getProjectTmpDir(cwd)` in `utils.ts` — returns `<cwd>/.pi/tmp/`, creates dir if missing.

### Mode-Aware Guards (`ctx.mode`)

Pi runs in four modes: `"tui"` (interactive), `"rpc"` (programmatic), `"json"` (structured output), `"print"` (one-shot).
Use `ctx.mode` to skip features that only make sense in interactive mode:

| Feature | Guard | Reason |
|---------|-------|--------|
| Daemon connections (pidash, pidiff) | `ctx.mode === "tui"` | No UI to display |
| Autocomplete providers | `ctx.mode === "tui"` | No editor input |
| Cron scheduling | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no timers |
| Dreaming (auto-dream timer) | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no background work |

**Keep `ctx.hasUI`** for simple UI guard checks (`notify`, `select`, `confirm`) — these work in both TUI and RPC modes.
**Use `ctx.mode`** when the distinction between interactive and one-shot matters.

### Adding an Extension Command

Extension commands (like `/pidash`, `/pidiff`, `/btw`, `/status`) are registered in
the extension source files under `extensions/`. Each command uses
`context.registerCommand()` with a name, description, and handler.

Known extension commands:

| Command | Source | Description |
|---------|--------|-------------|
| `/btw` | `btw.ts` | Quick side questions |
| `/pidash` | `pidash/pidash.ts` | Manage pidash daemon (start/stop/restart/status) |
| `/pidiff` | `pidiff/pidiff.ts` | Manage pidiff daemon (start/stop/restart/status) |
| `/status` | `status.ts` | Unified session status snapshot |
| `/async-status` | `async-agents.ts` | Background agent status |
| `/dream` | `dreaming.ts` | Memory consolidation |
| `/dream-auto` | `dreaming.ts` | Toggle automatic dreaming |
| `/cron` | `cron.ts` | Schedule recurring tasks |
| `/nvim-changed-files` | `nvim.ts` | Send changed files to nvim quickfix |
| `/coms` | `coms/coms-wrapper.ts` | P2P agent communication (start/stop/status) |
| `/coms-net` | `coms/coms-net-wrapper.ts` | Networked agent communication (start/connect/disconnect/stop/status) |
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

### Adding a Source Template

Source templates live in `templates/` and serve as immutable inputs for `/create-*` slash commands.
The `/create-*` prompt reads the template, analyzes the current project, fills in placeholders,
and writes a customized version to the project's `.pi/prompts/` directory.

**Naming convention:** `create-X.md` (prompt) → `X-prompt.md` (template)

Example: `prompts/create-coms-feature-manager.md` reads from `templates/coms-feature-manager-prompt.md`

**Rules:**

- ✅ Templates are immutable — never modify them at runtime
- ✅ Use `{{PLACEHOLDER}}` syntax for values the `/create-*` command fills in
- ✅ Use `[OPTIONAL]` markers for sections that may not apply to all projects
- ❌ Templates are NOT slash commands — they have no YAML frontmatter

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

**Auto-Injection Pipeline** (`rules.ts`):

- `before_agent_start`: injects situation report + vector-matched memories + session history
- Social closer gate: skips search for trivial messages ("ok", "thanks", "👍")
- `turn_end`: file-change memory reminders (vector search on modified file paths)
- `turn_end`: task-focus enforcement — if turn had no tool calls but active tasks exist, injects follow-up to force LLM to resume work
- Retrieval telemetry: logs injected memories to `.pi/data/memory-telemetry.jsonl`
- Ground Truth instruction: tells LLM to trust injected context as authoritative

**Layer 4 — Vector Embeddings** (`memory-embeddings.ts`):

- Model: `Xenova/bge-small-en-v1.5` (384 dims, runs locally via @huggingface/transformers ONNX)
- Storage: `.pi/memory/embeddings.json`
- Embed on write: `memory_add` embeds each entry immediately
- Dedup on write: `memory_add` checks vector similarity (≥0.85) before inserting — reinforces existing entry if near-duplicate found in same category
- Semantic search: `memory_search` embeds query, cosine similarity against stored vectors
- Hybrid results: union of vector + keyword matches, deduplicated
- Fallback: keyword-only search when @huggingface/transformers is unavailable
- Migration: first `memory_search` call embeds all existing entries missing from store
- No API keys needed — runs entirely locally

**Memory Tools** (`memory-tools.ts`):

- `memory_search`: hybrid keyword + vector search across all topic entries
- `memory_reinforce`: bump evidence count to prevent decay
- `memory_add`: LLM-initiated memory writes (pinned or learned); near-duplicate detection via vector similarity (≥0.85) auto-reinforces instead of adding
- `memory_remove`: LLM-initiated entry removal
- `memory_edit`: update content in-place or invalidate/supersede entries
- `memory_reflect`: synthesize a coherent answer from recalled memories
- `memory_consolidate`: analyze all memories, identify contradictions, merge duplicates, suggest skills
- `memory_topics`: list topic files with hotness scores

**Session Search** (`session-search.ts`):

- JSON-based keyword search over past conversation summaries
- Indexed on session shutdown from compaction summaries
- Auto-injected in `before_agent_start` for relevant past sessions
- Storage: `.pi/data/session-search.json`

**PR Review Store** (`myk_pi_tools/pr/pr_review_store.py`):

- Tracks PR review comments in a local SQLite database
- Storage: `.pi/data/pr-reviews.db`

**Capacity Signal** (`situation-report.ts`):

- Header shows usage %: `# Project Memory [72% — 1,224/1,700 tokens]`
- Consolidation warning injected when usage exceeds 80%

**Preference Auto-Extraction** (`preference-extractor.ts`):

- Detects "I prefer...", "always use...", "never..." in user messages
- Auto-adds to memory with explicit cue weight
- Reinforces existing preferences on repetition

### Project-Level Settings

Settings file: `.pi/pi-config-settings.json` — per-project configuration overriding global env vars.

| Setting | Type | Default | Env var | Description |
|---|---|---|---|---|
| `commit_trailer` | string | disabled | `PI_COMMIT_TRAILER` | Commit trailer name: `"Assisted-by"` = adds `Assisted-by: PI (<model>)`, `"A, B"` = ask user which trailer |
| `allow_push_to_protected_branches` | boolean | disabled | `PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES` | Allow commits/pushes to protected branches |
| `use_worktrees` | boolean | disabled | `PI_USE_WORKTREES` | Force worktree-only workflow |
| `dream_interval_hours` | number | 3 | `PI_DREAM_INTERVAL_HOURS` | Dream frequency |
| `dco` | boolean | disabled | `PI_DCO` | Add --signoff to all commits (DCO) |

Resolution: project file → global `~/.pi/pi-config-settings.json` → env var → default.

Module: `extensions/orchestrator/project-settings.ts`

## Companion Packages

These npm packages are installed alongside pi-config (via Dockerfile + `entrypoint.sh` for containers, `scripts/install.py` for native):

| Package | Purpose |
|---------|--------|
| [`pi-web-access`](https://github.com/pinkpixel/pi-web-access) | Web search, fetch, librarian skills |
| [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) | Task tracking for multi-step workflows — live widget, reminder cadence, dependency management |

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
