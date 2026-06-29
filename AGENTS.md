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
│   │   ├── async-agents.ts          # Async background agent infrastructure (fireAndForget, group-aware delivery, onComplete callbacks)
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── btw.ts                   # /btw command
│   │   ├── cron.ts                   # /cron scheduled tasks (interval/time-based)
│   │   ├── dreaming.ts              # Background memory consolidation (inspired by OpenClaw)
│   │   ├── enforcement.ts           # Command enforcement (python/pip, git, security, dangerous)
│   │   ├── enforcement-helpers.ts   # Pure helpers for dangerous-command enforcement (read-only detection, .pi/tmp/ path validation)
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
│   ├── pr/
│   │   └── pr_review_store.py       # PR review comment tracking (pr-reviews.db)
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
├── tests/                           # Test suite
│   ├── node/                        # Node.js tests (tsx + node:test)
│   │   └── orchestrator/            # Orchestrator extension tests
│   └── python/                      # Python tests (pytest)
├── package.json                     # Node.js dependencies (extensions)
├── tox.toml                         # Test runner config (Python + Node environments)
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

### Writing Effective Rules

- Fewer lines = more compliance. Compress rules to one sentence per concept.
- Reserve MANDATORY/NEVER/FORBIDDEN for actions that cause data loss, security issues, or irreversible changes. When everything is critical, nothing stands out.
- Use precise language — ambiguous rules get exploited. "Never use bash" contradicts "slash commands execute directly" unless scoped: "Outside slash commands, never use bash."
- Keep one ❌/✅ anti-pattern example per section only when it shows a specific recurring mistake. Generic examples ("DO answer the question") add nothing.
- Merge related sub-sections that say the same thing from different angles into one section.
- Use numbered checklists instead of ASCII flowcharts — fewer tokens, easier to follow sequentially.
- Never move rules between files, only compress within each file.

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

All async agent temp files live under `.pi/tmp/`:

```text
.pi/tmp/
├── debug.log                                 # Async debug log
├── cron-<pid>-<suffix>.json                  # Cron task state
├── async-results-pid-<pid>-<starttime>/      # Async agent completion results
└── worker-<id>/                              # Async agent working dir
    ├── status.json                           # Agent state (running/complete/failed)
    ├── session.json                          # Parent PID + starttime for zombie detection
    ├── output.log                            # Agent output
    └── system-prompt.md                      # Agent system prompt
```

**Zombie cleanup:** On `session_start`, checks each agent's `parentPid` + `parentStartTime` against `/proc/PID/stat` — dead parent = zombie = delete.

**Shared helper:** `getProjectTmpDir(cwd)` in `utils.ts` — returns `<cwd>/.pi/tmp/`, creates dir if missing.

**Enforcement:** `rm -rf` within `.pi/tmp/` or `/tmp/<something>` is silently allowed
(paths resolved via `realpathSync()` to prevent symlink traversal).
Read-only commands with dangerous patterns in args are also excluded from confirmation.

### Mode-Aware Guards (`ctx.mode`)

Modes: `"tui"` (interactive), `"rpc"` (programmatic), `"json"` (structured output), `"print"` (one-shot).

| Feature | Guard | Reason |
|---------|-------|--------|
| Daemon connections (pidash, pidiff) | `ctx.mode === "tui"` | No UI to display |
| Autocomplete providers | `ctx.mode === "tui"` | No editor input |
| Cron scheduling | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no timers |
| Dreaming (auto-dream timer) | `ctx.mode !== "print" && ctx.mode !== "json"` | One-shot, no background work |

Use `ctx.hasUI` for simple UI guards (`notify`, `select`, `confirm`); use `ctx.mode` when interactive vs. one-shot distinction matters.

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

1. Create a `.md` file in `prompts/` with YAML frontmatter (`description: "..."`).
2. **MUST include the bug reporting policy blockquote** after `## Raw Arguments` / `$ARGUMENTS` —
   mandatory for every template. See any existing prompt in `prompts/` for the exact format.
3. Write the prompt body after the blockquote.
4. **If the prompt accepts arguments**, add autocomplete in `extensions/orchestrator/extended-autocomplete.ts` — add to `completions` map and `promptTemplateCommands`.

### Adding a Source Template

Source templates in `templates/` are immutable inputs for `/create-*` slash commands.
The `/create-*` prompt reads the template, fills `{{PLACEHOLDER}}` values, and writes to `.pi/prompts/`.

**Naming convention:** `create-X.md` (prompt) → `X-prompt.md` (template). Example: `prompts/create-coms-feature-manager.md` → `templates/coms-feature-manager-prompt.md`.

Templates are immutable (never modify at runtime), use `{{PLACEHOLDER}}` for dynamic values,
`[OPTIONAL]` for conditional sections, and have no YAML frontmatter (they are not slash commands).

### Modifying Slash Command Arguments

When adding, changing, or removing arguments for any slash command (prompt template
or extension command):

- ✅ Update autocomplete in `extensions/orchestrator/extended-autocomplete.ts`
- Extension commands: update the entry in the `completions` map
- Prompt templates: update the entry in `completions` AND ensure the command is in `promptTemplateCommands`
- If adding a new completable command, follow the existing patterns (static items, cached fetchers, etc.)

### Memory Evolution — Scored Learning, Situation Reports, Memory Tree

Scored, prioritized, topic-organized memory system. Architecture inspired by [OpenHuman](https://github.com/tinyhumansai/openhuman) — clean-room TypeScript, MIT licensed.

**Layer 1 — Scored Memory** (`memory-scoring.ts`): Stability formula
`cue_weight × exp(-Δt / half_life) × ln(1 + evidence_count)` across 6 categories with decay half-lives
(preference=90d, lesson=60d, done=14d). Lifecycle: active → provisional → candidate → dropped.
Per-category budget caps, pinned/forgotten overrides. Storage: `.pi/memory/memory-scores.json`.

**Layer 2 — Situation Reports** (`situation-report.ts`): Token-budgeted context injected into system prompt.
Sections by priority: preferences → lessons → mistakes → patterns → decisions → completions;
lower-priority sections truncated when budget exceeded.

**Layer 3 — Memory Tree** (`memory-tree.ts`): Entries organized into topic files under
`.pi/memory/topics/` (~3000 tokens each). Topics have hotness scores;
cold topics auto-archived after 2× half-life without reinforcement.

**Auto-Injection Pipeline** (`rules.ts`):

- `before_agent_start`: injects situation report + vector-matched memories + session history (skips trivial messages like "ok", "thanks")
- `turn_end`: file-change memory reminders (vector search on modified paths) + task-focus enforcement (no tool calls but active tasks → injects follow-up)
- Retrieval telemetry logged to `.pi/data/memory-telemetry.jsonl`; Ground Truth instruction tells LLM to trust injected context

**Layer 4 — Vector Embeddings** (`memory-embeddings.ts`): Model `Xenova/bge-small-en-v1.5` (384 dims, local ONNX).
Storage: `.pi/memory/embeddings.json`. Embeds on write with dedup
(≥0.85 similarity → reinforce instead of add), hybrid keyword+vector search, keyword-only fallback. No API keys.

**Memory Tools** (`memory-tools.ts`): `memory_search` (hybrid search), `memory_reinforce` (bump evidence),
`memory_add` (write + dedup), `memory_remove` (delete), `memory_edit` (update/invalidate),
`memory_reflect` (synthesize answer), `memory_consolidate` (analyze/merge/deduplicate),
`memory_topics` (list topics + hotness).

**Session Search** (`session-search.ts`): Keyword search over past conversation summaries,
indexed on shutdown, auto-injected for relevant sessions. Storage: `.pi/data/session-search.json`.

**PR Review Store** (`myk_pi_tools/pr/pr_review_store.py`): Tracks PR review comments in SQLite (`.pi/data/pr-reviews.db`).
Stores both posted and skipped findings with status/skip_reason columns.
Skipped findings are auto-matched in subsequent review cycles to avoid re-raising dismissed items.

**Learned Review Preferences** (`.pi/data/review-guidelines.md`): Per-repo review guidelines
learned from user skip decisions. When a user skips a finding for a generalizable reason
(project convention, intentional pattern), the AI appends a one-line guideline to this file.
All 3 code-reviewer agents read this file before reviewing and suppress matching findings.

**Layer 5 — Enforcement Rules** (`enforcement-rules.ts`): Code-enforced memory entries that the LLM cannot ignore.
Memory entries gain optional fields: `trigger` (what activates the rule), `action` (block/run_after/warn),
`verifier` (semantic condition checked at turn_end). Enforcement hooks:

- `tool_result`: after a tool completes, checks triggers and executes actions (block, run_after, warn)
- `turn_end`: checks semantic verifiers and forces retry via `sendMessage(triggerTurn: true)` on violations

Trigger types: `bash_contains <str>`, `bash_regex <pattern>`, `tool_name <name>`, `file_modified <glob>`.
Action types: `block` (prevent), `run_after` (execute command after), `warn` (append warning).
Verifier format: `tool_called <tool> before <command>` (checks tool ordering within a turn).

Entries are added via `memory_add` with optional `trigger`, `action`, `verifier` parameters.
Stored in the same `memory-scores.json` — no separate storage system.

**Memory injection position**: memories injected at **tail** of system prompt (after rules/instructions).
Research proves tail position gets highest LLM attention (U-shaped attention curve).

**Capacity Signal** (`situation-report.ts`): Header shows usage % (e.g. `[72% — 1,224/1,700 tokens]`), consolidation warning at >80%.

**Preference Auto-Extraction** (`preference-extractor.ts`): Detects "I prefer…"/"always use…"/"never…" patterns, auto-adds to memory, reinforces on repetition.

### Project-Level Settings

Settings file: `.pi/pi-config-settings.json` — per-project configuration overriding global env vars.

| Setting | Type | Default | Env var | Description |
|---|---|---|---|---|
| `commit_trailer` | string | disabled | `PI_COMMIT_TRAILER` | Commit trailer name: `"Assisted-by"` = adds `Assisted-by: PI (<model>)`, `"A, B"` = ask user which trailer |
| `allow_push_to_protected_branches` | boolean | disabled | `PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES` | Allow commits/pushes to protected branches |
| `use_worktrees` | boolean | disabled | `PI_USE_WORKTREES` | Force worktree-only workflow |
| `dream_interval_hours` | number | 3 | `PI_DREAM_INTERVAL_HOURS` | Dream frequency |
| `dco` | boolean | disabled | `PI_DCO` | Add --signoff to all commits (DCO) |
| `comment_signature` | boolean | disabled | — | Append AI signature to all PR comments |

Resolution: project file → global `~/.pi/pi-config-settings.json` → env var → default.

Module: `extensions/orchestrator/project-settings.ts`

## Companion Packages

These npm packages are installed alongside pi-config (via Dockerfile + `entrypoint.sh` for containers, `scripts/install.py` for native):

| Package | Purpose |
|---------|--------|
| [`pi-web-access`](https://github.com/pinkpixel/pi-web-access) | Web search, fetch, librarian skills |
| [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) | Task tracking for multi-step workflows — live widget, reminder cadence, dependency management |

## Docker / Dockerfile

Image: `ghcr.io/myk-org/pi-config:latest`. When adding features requiring new CLI tools or system dependencies,
update the `Dockerfile` (and README Docker section if new mounts/env vars are needed) —
never assume a tool exists in the container.

## Generated Documentation (`docs/`)

Generated by [docsfy](https://github.com/myk-org/docsfy),
served via [GitHub Pages](https://myk-org.github.io/pi-config/).
Never edit `docs/` manually — re-run `docsfy generate` to update.

---

## Running Tests

```bash
# All tests (Python + Node)
tox

# Linting / pre-commit checks
pre-commit run --all-files

# Python tests only
uv run pytest

# Node tests only
npx tsx --test tests/node/**/*.test.ts
```
