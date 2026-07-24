# Repository Structure

```text
pi-config/
├── agents/                          # Specialist agent definitions
│   ├── api-documenter.md
│   ├── bash-expert.md
│   ├── code-reviewer-docs.md
│   ├── code-reviewer-guidelines.md
│   ├── code-reviewer-quality.md
│   ├── code-reviewer-security.md
│   ├── code-reviewer-spec.md
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
│   │   ├── overlay-dashboard.ts     # Shared fullscreen list→detail overlay (async/cron)
│   │   ├── overlay-dashboard-utils.ts # Pure selection reconcile helpers
│   │   ├── async-status-ui.ts       # /async-status overlay (uses overlay-dashboard)
│   │   ├── async-status-parse.ts    # Pure output.log JSONL → display line parser
│   │   ├── cron-status-ui.ts        # /cron list + list-all overlay (uses overlay-dashboard)
│   │   ├── cron-status-format.ts    # Pure cron schedule / next-run display helpers
│   │   ├── async-capability.ts      # supportsAsyncLlm / acpx coerce + async_llm sidecar settings
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── async-wait.ts            # Shared helper for waiting on async result files
│   │   ├── btw.ts                   # /btw command
│   │   ├── cron.ts                   # /cron scheduled tasks (interval/time-based)
│   │   ├── dreaming.ts              # Background memory consolidation (inspired by OpenClaw)
│   │   ├── enforcement.ts           # Command enforcement (python/pip, git, security, dangerous) + memory-based enforcement rules
│   │   ├── enforcement-helpers.ts   # Pure helpers for dangerous-command enforcement (read-only detection, .pi/tmp/ path validation)
│   │   ├── enforcement-rules.ts     # Enforcement rules engine — trigger matching + action execution for memory-based enforcement
│   │   ├── extended-autocomplete.ts  # Slash command argument completions (agents, branches, PRs, tags)
│   │   ├── github-autocomplete.ts   # GitHub issue # autocomplete provider
│   │   ├── git-helpers.ts           # Git utility functions
│   │   ├── icons.ts                 # Shared Nerd Font icon constants
│   │   ├── pi-config-review-state.ts # Review state machine (review loop enforcement)
│   │   ├── review-ui.ts             # Review loop TUI — status bar indicator + transcript status cards
│   │   ├── rule-placeholders.ts     # Substitutes {{REVIEW_LOOP_MAX_CYCLES}} into injected rules text
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
│   │   ├── coms-shared.ts           # Shared utilities: proxy factory, flag parser, state persistence, response formatting, list rendering
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
│   │   ├── pidiff.ts                # Diff viewer logic (spawns/connects to per-project pidiff server via .pi/tmp/ lockfiles)
│   │   └── pidiff-ui/               # React diff viewer UI (@pierre/diffs + @pierre/trees)
│   ├── shared/                      # Shared extension utilities
│   │   ├── create-runtime-provider.ts # createProvider helpers for cli/acpx (auth/fetch/filter)
│   │   ├── daemon-manager.ts        # Server infrastructure (spawn, health check, WebSocket) — shared by pidash and pidiff
│   │   ├── ws-client.ts             # WebSocket heartbeat + reconnect helpers (used by pidash, pidiff)
│   │   └── ui/                      # Shared shadcn/ui components (used by pidash-ui and pidiff-ui via @ui alias)
│   ├── acpx-provider/              # ACPX provider extension (createProvider + acpx/runtime)
│   │   ├── index.ts                # Provider registration + streamAcpx + discoverAcpxModels
│   │   ├── load-runtime.ts         # Resolve acpx/runtime (global npm, then package-local)
│   │   └── runtime-models.ts       # mapAcpxDiscoveredModels → createProvider Model[]
│   ├── cli-provider/               # CLI-backed providers (createProvider; cli-claude/gemini/cursor)
│   │   ├── agents/                 # Per-CLI drivers (cursor/claude/gemini) — add new CLI here
│   │   ├── shared/                 # Shared discovery cache helpers
│   │   ├── sessions.ts             # Resume directory (lastSeen/status)
│   │   ├── session-reaper.ts       # Idle session marker cleanup
│   │   ├── runtime-models.ts       # mapCliDiscoveredModels → createProvider Model[]
│   │   └── index.ts                # Provider registration + streamCli + discoverCliModels
│   └── image-gen/                   # Image generation extension (standalone)
│       ├── index.ts                # Entry point — registers generate_image tool
│       └── image-gen.ts            # Gemini API image generation (settings: image_model; env: GEMINI_API_KEY)
├── templates/                       # Immutable prompt templates (source files for /create-* commands)
│   └── coms-feature-manager-prompt.md  # Coms feature manager template
├── prompts/                         # Prompt templates (slash commands)
│   ├── create-coms-feature-manager.md
│   ├── external-ai.md
│   ├── coderabbit-rate-limit.md
│   ├── domain-model.md
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
│   ├── pidiff-server.ts             # Pidiff per-project server (diff hub with review comments, one per project cwd)
│   ├── serve-ui.ts                  # Shared static UI serving + auto-build for daemon servers
│   ├── symlink-cli-specialists.sh   # Symlink package agents into .cursor/.claude/.gemini/agents (container entrypoint)
│   └── install.py                   # Interactive TUI installer for native deployment (questionary)
├── .coderabbit.yaml                 # CodeRabbit CLI config (assertive profile, linter selection)
├── Dockerfile                       # Container image definition
├── entrypoint.sh                    # Container entrypoint (gitignore + CLI agent symlinks, then pi)
├── README.md                        # Project README
├── AGENTS.md                        # Contributor rules (this repo)
├── pi-config-settings.example.json    # Example project settings file
├── tests/                           # Test suite
│   ├── node/                        # Node.js tests (tsx + node:test)
│   │   ├── acpx-provider/           # ACPX createProvider / runtime-model tests
│   │   ├── cli-provider/            # CLI createProvider / runtime-model tests
│   │   ├── orchestrator/            # Orchestrator extension tests
│   │   ├── pidiff/                  # Pidiff extension tests
│   │   └── shared/                  # Shared tests (coms-shared, daemon-manager, create-runtime-provider)
│   └── python/                      # Python tests (pytest)
├── package.json                     # Node.js dependencies (extensions)
├── tox.toml                         # Test runner config (Python + Node environments)
└── pyproject.toml                   # Python project config (myk_pi_tools)
```
