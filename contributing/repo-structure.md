# Repository Structure

```text
pi-config/
├── agents/                          # Specialist agent definitions
│   ├── _partials/                   # Shared agent prompt fragments ({{INCLUDE:...}})
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
│   ├── conflict-resolver.md
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
│   │   ├── cron-status-ui.ts        # /cron list overlay (uses overlay-dashboard)
│   │   ├── cron-status-format.ts    # Pure cron schedule / next-run display helpers
│   │   ├── cron-store.ts            # Durable cron envelopes, atomic mutation, and leader locks
│   │   ├── settings-tui.ts          # /pi-config-settings thin TUI overlay adapter (uses project-settings + overlay-dashboard)
│   │   ├── settings-tui-helpers.ts  # Pure TUI presentation & model-picker helpers (categories, formatting, secret prefill, model-picker filtering)
│   │   ├── settings-tui-submenus.ts # Submenu components (input, number, picker, select, string-list, overrides)
│   │   ├── async-capability.ts      # Internal ops provider settings lookup (getInternalOpsProvider)
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── async-wait.ts            # Shared helper for waiting on async result files
│   │   ├── cron.ts                   # /cron scheduled tasks and session/project scope handling
│   │   ├── dreaming.ts              # Background memory consolidation (inspired by OpenClaw)
│   │   ├── skill-maintenance.ts     # /adopt-skill, marked-skill write guard, in-turn nudge, provenance + one-line notice
│   │   ├── enforcement.ts           # Command enforcement (python/pip, git, security, dangerous) + memory-based enforcement rules
│   │   ├── enforcement-helpers.ts   # Pure helpers for dangerous-command enforcement (read-only detection, .pi/tmp/ path validation)
│   │   ├── enforcement-rules.ts     # Enforcement rules engine — trigger matching + action execution for memory-based enforcement
│   │   ├── extended-autocomplete.ts  # Slash command argument completions (agents, branches, PRs, tags)
│   │   ├── github-autocomplete.ts   # GitHub issue # autocomplete provider
│   │   ├── git-helpers.ts           # Git utility functions
│   │   ├── icons.ts                 # Shared Nerd Font icon constants
│   │   ├── malformed-response-recovery.ts # Bounded auto-retry on MALFORMED_RESPONSE provider stop reasons (#1333)
│   │   ├── markdown-transformer.ts  # Display-only markdown transforms (memory badges, coms headers, review findings, settings, task/async status)
│   │   ├── parse-model-override.ts  # Parse provider/model-id override strings for subagent model param
│   │   ├── pi-config-review-state.ts # Review state machine (review loop enforcement)
│   │   ├── resolve-agent-model.ts   # Resolve effective model/provider for an agent (priority chain)
│   │   ├── review-ui.ts             # Review loop TUI — status bar indicator + transcript status cards
│   │   ├── review-learning.ts      # Distill addressed review findings into memory lessons after `reviews address` (issue #918)
│   │   ├── pr-retro.ts             # Opt-in post-merge PR retrospective trigger (gated on `pr_retro_on_merge`, issue #1343)
│   │   ├── rule-placeholders.ts     # Rule assembly: frontmatter gates, {{IF}}/{{IFNOT}} conditionals, {{REVIEW_LOOP_MAX_CYCLES}}
│   │   ├── rules.ts                 # Rule + memory injection (before_agent_start)
│   │   ├── session-search.ts            # Keyword search over past conversation summaries
│   │   ├── state-jsonl.ts               # JSONL state persistence (JsonlStateStore + JsonlAppendLog)
│   │   ├── session-validation.ts    # Session start tool checks + upgrade changelog notification
│   │   ├── nvim.ts                  # Neovim integration (quickfix, /nvim-changed-files)
│   │   ├── status.ts                # /status command — unified session status snapshot (incl. worktree summary)
│   │   ├── status-bar.ts            # Ordered status bar slot registry (time, async, crons, dream, git, worktrees, trail, review)
│   │   ├── status-line.ts           # Git status ([wt] tag, 4a-worktrees badge), notifications, container indicator, last-activity timestamp
│   │   ├── worktree.ts              # /worktree command — interactive overlay + list/prune subcommands
│   │   ├── worktree-helpers.ts      # Pure worktree helpers (COMS peer matching, remove guards, table/status/prune formatting, clipboard)
│   │   ├── memory-scoring.ts          # Stability-based memory scoring engine
│   │   ├── memory-tools.ts              # AI-accessible memory tools (search, reinforce, add, remove)
│   │   ├── memory-embeddings.ts         # Vector embedding support for semantic memory search (fastembed)
│   │   ├── memory-tree.ts             # Hierarchical topic-based memory organization
│   │   ├── preference-extractor.ts    # Auto-extract user preferences from conversation
│   │   ├── project-settings.ts        # Deep settings store — schema-driven validation/parsing (settings-keys.json), legacy .jsonc migration, single coordinated cache, source detection, and locked atomic persistence with backups
│   │   ├── situation-report.ts        # Token-budgeted memory context for system prompts
│   │   ├── subagent-child-spec.ts     # Shared sync/async subagent child CLI args, prompt, and env builder
│   │   ├── subagent-tool.ts         # Subagent tool + runSingleAgent (async-only enforcement for reviewers)
│   │   └── utils.ts                 # Shared utilities (getProjectTmpDir, tryGetSystemPromptOptions, etc.)
│   ├── coms/                        # Inter-agent communication extension (standalone)
│   │   ├── index.ts                 # Entry point — registers coms
│   │   ├── coms-wrapper.ts          # P2P agent communication wrapper (on-demand /coms command)
│   │   ├── coms-shared.ts           # Shared utilities: proxy factory, flag parser, state persistence, response formatting, list rendering
│   │   ├── coms-p2p.ts              # P2P implementation (forked from disler/pi-vs-claude-code)
│   │   └── themeMap.ts              # Theme utilities (forked from disler/pi-vs-claude-code)
│   ├── pidash/                      # Live web dashboard extension (standalone)
│   │   ├── index.ts                 # Entry point
│   │   ├── pidash.ts                # Dashboard logic (connects to pidash daemon, forwards provider response info)
│   │   ├── browser-ops.ts           # #968 browser operations — settings read/write (project-settings modules) + pi mcp CLI
│   │   └── pidash-ui/               # React + shadcn/ui web dashboard
│   │       ├── src/                 # React source (components, hooks, types)
│   │       └── dist/               # Built output (generated, gitignored)
│   ├── pidiff/                      # Diff viewer extension (standalone)
│   │   ├── index.ts                 # Entry point
│   │   ├── pidiff.ts                # Diff viewer logic (spawns/connects to per-project pidiff server via .pi/run/ lockfiles)
│   │   └── pidiff-ui/               # React diff viewer UI (@pierre/diffs + @pierre/trees; deep DiffSessionController in src/lib/diff-session-controller.ts)
│   ├── openai-compatible-discovery/ # Config-gated /v1/models discovery on configured providers
│   │   └── index.ts                 # Augments the source provider in Pi's ordinary model picker
│   ├── reload-flag/                 # Agent-triggered extension reload (deploy → flag → ctx.reload → done marker)
│   │   └── index.ts                 # Watches .pi/run/reload.flag; nonce handshake via reload.pending/reload.done
│   ├── shared/                      # Shared extension utilities
│   │   ├── oneshot.ts               # Argv oneshot helpers (`pi -p` / `--mode json` skip register)
│   │   ├── provider-stream-log.ts   # Shared provider_stream_event hook (#848; gated on log_providers=debug)
│   │   ├── resolve-binary.ts        # In-process PATH binary resolution
│   │   ├── openai-compatible-discovery.ts # Discovery config, requests, header resolution, cache, diagnostics
│   │   ├── daemon-manager.ts        # Server infrastructure (spawn, health check, WebSocket) — shared by pidash and pidiff
│   │   ├── ui-bridge.ts            # #968 bidirectional prompt bridging (select/confirm/input in TUI + browser, first answer wins)
│   │   ├── live-ctx.ts              # isLiveExtensionCtx / resolveSessionStartCtx / firstLiveExtensionCtx
│   │   ├── malformed-recovery-bridge.ts # Cross-extension malformed-response recovery coordination with COMS (#1333)
│   │   ├── session-bridge-map.ts    # Shared strict per-session globalThis[Symbol.for(...)] Map registry helper (#1337)
│   │   ├── task-store-bridge.ts     # Session-keyed pitasks store & telemetry bridge (#1016, #1337)
│   │   ├── workload-bridge.ts       # Session-keyed orchestrator workload bridge for coms/pitasks (#1083, #1337)
│   │   ├── file-lock.ts             # Shared cross-process file/dir locking + syncSleep
│   │   ├── ws-client.ts             # WebSocket heartbeat + reconnect helpers (used by pidash, pidiff)
│   │   ├── pi-agent-dir.ts          # resolvePiAgentDir helper (used by restore-default-model, last-thinking-level, session-search, openai-compatible-discovery)
│   │   ├── coms-active.ts           # Process-local P2P coms active flag (rules + coms; avoids circular imports)
│   │   ├── widget-visibility.ts     # Shared collapse/expand widget state (expanded/collapsed, header-always-visible), globalThis reload persistence, shortcut validation/registration, and ui:toggle-all-widgets bridge
│   │   └── ui/                      # Shared UI components and browser helpers (cn, createBrowserLogger, useSharedWebSocket) used by pidash-ui and pidiff-ui
│   ├── providers/                  # Default model restore & thinking-level persistence extension
│   │   ├── index.ts                # Extension entry — delegates to registerSessionRestore (skips meta invocations)
│   │   ├── session-restore.ts      # Unified session_start / model_select / thinking_level_select / session_shutdown restore lifecycle (#1360)
│   │   ├── restore-default-model.ts # Cold-start restore of saved default (provider-agnostic) after auth-race fallback (#753)
│   │   └── last-thinking-level.ts  # Per-model thinking-level persistence, locking, clamping, and policy helpers
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
│   ├── retro.md
│   ├── review-handler.md
│   ├── review-local.md
│   └── scout-and-plan.md
├── rules/                           # Orchestrator rules (auto-loaded alphabetically)
│   ├── 00-orchestrator-core.md
│   ├── 05-issue-first-workflow.md
│   ├── 10-agent-routing.md
│   ├── 20-code-review-loop.md
│   ├── 25-documentation-updates.md
│   ├── 30-prompt-templates.md
│   ├── 35-memory.md
│   ├── 40-critical-rules.md
│   ├── 45-file-preview.md
│   ├── 50-agent-bug-reporting.md
│   ├── 55-coms-protocol.md
│   └── 60-task-tracking.md
├── docs/                           # Hand-written docs source (pi-docsite renders HTML, llms.txt, search index)
├── contributing/                   # Contributor docs (repo structure, testing/packaging, enforcement honesty map, disposition audits)
├── myk_pi_tools/                    # Python CLI tooling package
│   ├── __init__.py
│   ├── ai_cli/
│   ├── cli.py
│   ├── coderabbit/
│   ├── db/
│   │   ├── sqlite_helpers.py        # Shared SQLite path, RO/RW connectors, and idempotent migration engine
│   │   ├── storage.py               # Unified reviews.db storage module (ReviewDB, schema, migrations, title backfill)
│   │   ├── query.py                 # Backwards-compatible re-export shim for myk_pi_tools.db.storage
│   │   └── commands.py              # CLI commands for querying reviews.db
│   ├── memory/
│   ├── pr/
│   │   └── pr_review_store.py       # PR review comment tracking (pr-reviews.db)
│   ├── release/
│   └── reviews/
├── scripts/                         # Utility scripts
│   ├── docker-safe                  # Restricted Docker/Podman CLI wrapper (container only)
│   ├── remap-node-identity.sh       # Container init: remap `node` to PI_HOST_UID/GID (sourced by init-entrypoint.sh)
│   ├── httpd.py                     # HTTP file server for file preview (used by rules/45-file-preview.md)
│   ├── pidash-server.ts             # Pidash daemon (WebSocket hub for all pi sessions + Discord bot)
│   ├── pidiff-server.ts             # Pidiff per-project server (diff hub with review comments, one per project cwd)
│   ├── pidiff-git-diff.ts           # Batched git cat-file blob reader, diff status parser, and worktree list parser
│   ├── pidiff-git-ignore.ts         # Chokidar gitignore filter (top-level dirs vs nested prefixes)
│   ├── serve-ui.ts                  # Shared static UI serving + auto-build for daemon servers
│   ├── pr-retro-collect.mjs         # Deterministic $0 PR + session + check-config telemetry collector (issue #1343)
│   └── install.py                   # Interactive TUI installer for native deployment (questionary)
├── packages/                        # Workspace packages
│   ├── pi-sidecar/                  # HTTP sidecar wrapping Pi SDK (@myk-org/pi-sidecar)
│       ├── src/                     # TypeScript source
│       │   ├── index.ts             # Public API + startSidecar()
│       │   ├── server.ts            # CLI entry point
│       │   ├── sessions.ts          # SessionStore — active sessions, SSE streaming, redaction holdback, abort, transcripts
│       │   ├── provider-runtime.ts  # ProviderRuntime seam + PiProviderRuntime (extension resolution, snapshots, SDK runtime, discovery, session creation)
│       │   ├── http-tool-executor.ts # HTTP-backed custom tool execution
│       │   ├── watchdog.ts          # Health-check poller for companion backend
│       │   ├── pi-version.ts        # Pi SDK version floor assertion
│       │   └── logger.ts            # Structured logger
│       ├── pi_sidecar_client/       # Python client (pi-sidecar-client on PyPI)
│       │   └── __init__.py          # SidecarClient, call_ai_once, call_ai
│       ├── scripts/                 # Sidecar scripts
│       │   ├── start-sidecar.sh     # Dev launcher (background, tsx from source)
│       │   ├── clean-dist.mjs       # Portable postbuild: strip dist/.gitignore + Python artifacts
│       │   └── enforce-protobufjs-floor.mjs # Postinstall protobufjs version fix
│       ├── tests/                   # Sidecar tests
│       │   ├── test_ts/             # TypeScript unit tests (node:test)
│       │   ├── test_python/         # Python client tests (pytest)
│       │   └── e2e/                 # End-to-end live battery (opt-in: pytest -m e2e)
│       ├── examples/               # Usage examples (Python + TypeScript)
│       ├── package.json            # @myk-org/pi-sidecar (npm workspace package)
│       ├── pyproject.toml          # pi-sidecar-client (PyPI)
│       └── tsconfig.json           # TypeScript config
│   └── pi-vertex-claude/              # Vertex AI Claude provider (@myk-org/pi-vertex-claude)
│       ├── index.ts                   # Provider extension entry point
│       ├── test/                      # Tests (vitest)
│       │   ├── vertex-claude.test.ts
│       │   └── vertex-claude.integration.test.ts
│       ├── package.json               # @myk-org/pi-vertex-claude (npm workspace package)
│       └── vitest.config.ts           # Test config
├── .coderabbit.yaml                 # CodeRabbit CLI config (assertive profile, linter selection)
├── Dockerfile                       # Container image definition
├── init-entrypoint.sh               # Container init (UID remap, HOME map, docker.sock, then entrypoint.sh)
├── entrypoint.sh                    # Container entrypoint (pi/package updates + gitignore, then pi)
├── README.md                        # Project README
├── AGENTS.md                        # Contributor rules & navigation pointers (this repo)
├── CODING_STANDARDS.md              # Review-only engineering judgement standards (this repo)
├── pi-config-settings.example.json  # Example project settings file (plain JSON)
├── tests/                           # Test suite
│   ├── node/                        # Node.js tests (tsx + node:test)
│   │   ├── providers/               # index, session-restore, restore-default-model, last-thinking-level tests
│   │   ├── orchestrator/            # Orchestrator extension tests
│   │   ├── pidiff/                  # Pidiff extension tests
│   │   └── shared/                  # Shared tests (oneshot, coms, daemon, pricing-provenance, provider-stream-log, OpenAI-compatible discovery)
│   └── python/                      # Python tests (pytest)
├── package.json                     # Node.js dependencies (extensions)
├── tox.toml                         # Test runner config (Python + Node environments)
└── pyproject.toml                   # Python project config (myk_pi_tools)
```

Cross-extension lifecycle hooks (`agent_end`, `turn_end`, `session_shutdown`): see [Async & Runtime Internals](../docs/async-internals.md#cross-extension-lifecycle-hooks).

- **Shared bridge invariant (`extensions/shared/*-bridge.ts`):** mutable `globalThis[Symbol.for(...)]` bridges must key per-session state in a
  `Map<sessionId, ...>` with `session_shutdown` cleanup for multi-session `pi-sidecar` safety unless explicitly allowlisted in
  `tests/node/shared/bridge-session-key-contract.test.ts`.
