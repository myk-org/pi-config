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
│   │   ├── ask-user.ts              # ask_user tool (exposure: model-only)
│   │   ├── codemode-activation.ts   # Auto-activate Pi 1.6 codemode on session_start (respects --no-tools / --exclude-tools)
│   │   ├── async-agents.ts          # Async background agent infrastructure (fireAndForget, group-aware delivery, onComplete callbacks, async_status tool)
│   │   ├── overlay-dashboard.ts     # Shared fullscreen list→detail overlay (async/cron/tasks/coms/worktree/adopt-skill)
│   │   ├── overlay-dashboard-utils.ts # Pure selection reconcile helpers
│   │   ├── overlay-activity-log.ts  # Shared `[1] Roster / [2] Activity` live activity log component and async event aggregator (#1417)
│   │   ├── async-status-ui.ts       # /async overlay (`r` revive, `1`/`2` Roster & Activity Log, live output detail, plain-text fallback)
│   │   ├── async-status-parse.ts    # Pure output.log JSONL → display line parser
│   │   ├── cron-status-ui.ts        # /cron overlay (uses overlay-dashboard)
│   │   ├── cron-status-format.ts    # Pure cron schedule / next-run display helpers
│   │   ├── cron-store.ts            # Durable cron envelopes, atomic mutation, and leader locks
│   │   ├── settings-tui.ts          # /pi-config-settings thin TUI overlay adapter (uses project-settings + overlay-dashboard)
│   │   ├── settings-tui-helpers.ts  # Pure TUI presentation & model-picker helpers (categories, formatting, secret prefill, model-picker filtering)
│   │   ├── settings-tui-submenus.ts # Submenu components (input, number, picker, select, string-list, overrides)
│   │   ├── async-capability.ts      # Internal ops provider settings lookup (getInternalOpsProvider)
│   │   ├── async-runner.ts          # Standalone async runner (spawned detached)
│   │   ├── async-wait.ts            # Shared helper for waiting on async result files
│   │   ├── cron.ts                   # /cron scheduled tasks and session/project scope handling
│   │   ├── dreaming.ts              # Background memory consolidation (inspired by OpenClaw) + memory_dream tool
│   │   ├── skill-maintenance.ts     # /adopt-skill + skill_adopt tool, marked-skill write guard, in-turn nudge, provenance + one-line notice
│   │   ├── bash-policy.ts           # Deep bash enforcement policy — unified shell lexing/scanning, DANGEROUS_RULES, git/conflict/trailer/dangerous evaluation
│   │   ├── enforcement.ts           # Thin enforcement hook adapter over bash-policy.ts, restricted-folders.ts, tool-permissions.ts, enforcement-rules.ts, and pi-config-review-state.ts
│   │   ├── enforcement-rules.ts     # Enforcement rules engine — trigger matching + action execution for memory-based enforcement
│   │   ├── restricted-folders.ts    # Symlink-safe, boundary-safe restricted_folders gate, tiered session/SQLite approval grants, and /forget-approvals (#1416)
│   │   ├── tool-permissions.ts      # Declarative last-match-wins glob tool_permissions, Pi 1.6 annotations selectors, per-host fetch_content approvals, and HMAC SQLite grants (#1450)
│   │   ├── secret-obfuscation.ts    # Opt-in reversible secret obfuscation for context/tool_result and tool_call placeholder restoration (#1413)
│   │   ├── extended-autocomplete.ts  # Slash command argument completions (agents, branches, PRs, tags)
│   │   ├── github-autocomplete.ts   # GitHub issue # autocomplete provider
│   │   ├── git-helpers.ts           # Git, PR, and worktree query utilities
│   │   ├── icons.ts                 # Shared Nerd Font icon constants
│   │   ├── malformed-response-recovery.ts # Bounded auto-retry on MALFORMED_RESPONSE provider stop reasons (#1333)
│   │   ├── stream-loop-guard.ts     # Abort runaway streaming repetition/degeneration loops via message_update (#1374)
│   │   ├── markdown-transformer.ts  # Display-only markdown transforms (memory badges, coms headers, review findings, settings, task/async status)
│   │   ├── parse-model-override.ts  # Parse provider/model-id override strings for subagent model param
│   │   ├── pi-config-review-state.ts # Review state machine (review loop enforcement)
│   │   ├── resolve-agent-model.ts   # Resolve effective model/provider for an agent (priority chain)
│   │   ├── review-ui.ts             # Review loop TUI — status bar indicator + transcript status cards
│   │   ├── review-learning.ts      # Distill addressed review findings into memory lessons after `reviews address` (issue #918)
│   │   ├── pr-retro.ts             # Opt-in post-merge PR retrospective trigger (gated on `pr_retro_on_merge`, issue #1343)
│   │   ├── rule-placeholders.ts     # Rule assembly: frontmatter gates/scoping (alwaysApply/globs/tools/enabled), {{IF}}/{{IFNOT}} conditionals, {{REVIEW_LOOP_MAX_CYCLES}}
│   │   ├── rules.ts                 # Cache-stable rule + pinned memory injection (before_agent_start), scoped lazy rule delivery (tool_call/tool_result), pre/post-compaction hooks
│   │   ├── session-search.ts            # Keyword search over past conversation summaries (SQLite-backed via state-db.ts)
│   │   ├── session-spill.ts             # Session JSONL spill writer (<session-dir>/local/<N>.log) & content-addressed blob store (~/.pi/blobs/<sha256>) (#1420)
│   │   ├── pre-compaction-elision.ts    # Deterministic zero-LLM-cost mechanical elision of old bulky tool results via context hook (#1421)
│   │   ├── magic-keywords.ts            # Per-turn thinking magic keywords (`ultrathink` / `chillax`) with strict prose-only parser and single-turn restore (#1418)
│   │   ├── advisor.ts                   # Opt-in background read-only advisor/watchdog model (`advisor_enabled`, `advisor_model` provider/model-id, `advisor_interval_turns`) (#1419)
│   │   ├── lsp.ts                       # Opt-in zero-dep JSON-RPC 2.0 stdio LSP client, shared per-worktree broker client, circuit breaker, & lazy TUI install prompt (`lsp_enabled`, `lsp_servers`) (#1445)
│   │   ├── lsp-broker-daemon.mjs        # Shared 1-per-(worktreeRoot, serverId) `0600` UNIX-socket LSP broker daemon with debounce, circuit breaker, & idle shutdown (#1445)
│   │   ├── snapshots.ts                 # Git-backed per-turn shadow-tree snapshots with `/undo` and `/redo` commands (`turn_snapshots`) (#1449)
│   │   ├── qa-overlay.ts                # `/qa` human Q&A reader overlay (`qa_overlay_shortcut`), 1-key `pasteToEditor()` quoting (`r`, `1`–`9`), and 1-line buried-answer widget hint (#1453)
│   │   ├── state-db.ts                  # Shared node:sqlite WAL state store (.pi/data/state.db, Float32 BLOB embeddings, legacy JSONL migration)
│   │   ├── state-jsonl.ts               # JSONL append log + legacy JSONL helpers (JsonlAppendLog, truncateJsonlFile, parseLastValidLine)
│   │   ├── session-validation.ts    # Session start tool checks + upgrade changelog notification
│   │   ├── nvim.ts                  # Neovim integration (quickfix, /nvim-changed-files)
│   │   ├── status.ts                # /status command + session_status tool — unified session status snapshot (incl. worktree summary)
│   │   ├── status-bar.ts            # Ordered status bar slot registry (time, async, crons, dream, git, worktrees, trail, review)
│   │   ├── status-line.ts           # Git status ([wt] tag, 4a-worktrees badge), notifications, container indicator, last-activity timestamp
│   │   ├── worktree.ts              # /worktree zero-arg TUI overlay + worktree_status tool
│   │   ├── worktree-helpers.ts      # Pure worktree helpers (COMS peer matching, remove guards, table/status/prune formatting, clipboard)
│   │   ├── memory-scoring.ts          # Stability-based memory scoring engine
│   │   ├── memory-store.ts            # Deep memory store — owns all topic writes, cache invalidation, score/tombstone updates, and embedding upkeep/pruning
│   │   ├── memory-contradiction.ts    # Internal NLP contradiction detection helper (clause-scoped polarity + vector narrowing)
│   │   ├── memory-tools.ts            # AI-accessible memory tools (search, reinforce, add, remove, edit, reflect, consolidate)
│   │   ├── memory-embeddings.ts       # Vector embedding support for semantic memory search (fastembed)
│   │   ├── memory-tree.ts             # Read-only topic-file index and hotness scores
│   │   ├── memory-line.ts             # Pure topic-line parser, formatter, and canonicalization helpers
│   │   ├── preference-extractor.ts    # Auto-extract user preferences from conversation
│   │   ├── project-settings.ts        # Deep settings store — schema-driven validation/parsing (settings-keys.json), legacy .jsonc migration, single coordinated cache, source detection, and locked atomic persistence with backups
│   │   ├── situation-report.ts        # Token-budgeted memory context for system prompts and pre-compaction standing memory context
│   │   ├── subagent-child-spec.ts     # Shared sync/async subagent child CLI args, prompt, and env builder
│   │   ├── subagent-tool.ts         # Subagent tool + runSingleAgent (async-only enforcement for reviewers)
│   │   └── utils.ts                 # Shared utilities (getProjectTmpDir, tryGetSystemPromptOptions, etc.)
│   ├── coms/                        # Inter-agent communication extension (standalone)
│   │   ├── index.ts                 # Entry point — registers coms
│   │   ├── coms-wrapper.ts          # On-demand `/coms` controller — drives `ComsPeerRuntime` and `ComsRegistry` directly (lifecycle, reload, inventory, pidash)
│   │   ├── coms-registry.ts         # Unified peer registry, supervision inventory, socket probes (`probeStaleSocket`, `probeAlive`), and stale/orphan pruning
│   │   ├── coms-p2p.ts              # Instantiable P2P peer runtime (`createComsPeerRuntime`, sockets, queue drain, tools incl. `coms_local_queue`, inbound queue overlay)
│   │   ├── coms-shared.ts           # Shared utilities: flag parser, state persistence, active-tool sync, response formatting, inbound bundling
│   │   ├── coms-peers.ts            # Peer inventory filtering, stopped supervised peer listing, activity log aggregation, table/detail formatting, spawn/kill planning
│   │   ├── coms-peers-ui.ts         # `/coms` interactive overlay (`r` revive, `1`/`2` Roster & Activity Log, `f` scope, `q` queue, multi-select composer/kill, drilldown)
│   │   ├── coms-describe.ts         # Socket-based peer workload describe RPC client and validator
│   │   ├── coms-drilldown.ts        # Peer workload drilldown row builders
│   │   ├── coms-workload.ts         # Active-only peer workload counts and formatting
│   │   ├── coms-history.ts          # Size-rotated JSONL message history append/query helpers
│   │   ├── queue-recovery.ts        # Body-free queue recovery previews and atomic clear helpers
│   │   ├── mixed-turn.ts            # Pure mixed-turn detection helpers
│   │   ├── peer-text.ts             # Peer-supplied text sanitization and origin-marker stripping
│   │   └── themeMap.ts              # Theme utilities (forked from disler/pi-vs-claude-code)
│   ├── pidash/                      # Live web dashboard extension (standalone)
│   │   ├── index.ts                 # Entry point
│   │   ├── pidash.ts                # Dashboard logic (connects to pidash daemon, forwards provider response info)
│   │   ├── browser-ops.ts           # #968/#1427 browser operations — settings read/write (project-settings), pi mcp CLI, and worktrees list/detail/prune/guarded-remove (reusing orchestrator/worktree.ts)
│   │   ├── discord-bot.ts           # Thin Discord.js transport adapter wired to discord-session-routing + shared chat bridge
│   │   ├── discord-session-routing.ts # Deep Discord session-routing module (inbound/interaction routing, prompt targets, watch switching, reactions, state hydration, unified session RPC)
│   │   ├── discord-config.ts        # Discord bot env/config resolution and allowlist parsing
│   │   ├── discord-format.ts        # Discord message limits, mention suppression, and formatting defaults
│   │   ├── discord-commands.ts      # Slash-command payload canonicalization and diffing
│   │   ├── discord-prompt-controls.ts # Discord button/select prompt control builders
│   │   ├── discord-board.ts         # Forum session board planner
│   │   ├── discord-jobs-view.ts     # Async/cron job list rendering for Discord
│   │   └── pidash-ui/               # React + shadcn/ui web dashboard
│   │       ├── src/                 # React source (components, hooks, types)
│   │       └── dist/               # Built output (generated, gitignored)
│   ├── pidiff/                      # Diff viewer extension (standalone)
│   │   ├── index.ts                 # Entry point
│   │   ├── pidiff.ts                # Thin adapter over createDaemonClient + lockfile.ts (per-project diff server)
│   │   ├── lockfile.ts              # Dedicated pidiff PID, port-probe, `.pi/run` lockfile, server-PID, and spawn-lock module
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
│   │   ├── daemon-manager.ts        # Deep shared daemon client & lifecycle manager (spawn, health, WebSocket, heartbeat, reconnect, shutdown, /start|stop|restart|status, daemon_manage tool) — shared by pidash and pidiff
│   │   ├── ui-bridge.ts            # #968 bidirectional prompt bridging (select/confirm/input in TUI + browser, first answer wins)
│   │   ├── pidash-transcript-reducer.ts # Pure browser-safe transcript reducer shared by pidash daemon and pidash-ui (#1398)
│   │   ├── live-ctx.ts              # isLiveExtensionCtx / resolveSessionStartCtx / firstLiveExtensionCtx
│   │   ├── session-bridge.ts        # Unified per-session globalThis[Symbol.for(...)] Map bridge (taskStore, workload, malformedRecovery, comsActive, streamLoopAborted) with auto-pruning (#1364, #1374)
│   │   ├── file-lock.ts             # Shared cross-process file/dir locking + syncSleep
│   │   ├── pi-agent-dir.ts          # resolvePiAgentDir helper (used by restore-default-model, last-thinking-level, session-search, openai-compatible-discovery)
│   │   ├── secret-patterns.mjs      # Shared built-in credential regexes & env-var secret filters (consumed by secret-obfuscation.ts and scripts/diagnostic-report-collect.mjs; typed via secret-patterns.d.mts)
│   │   ├── tool-namespaces.ts       # Shared Pi 1.6 ToolNamespace definitions (memory, coms, tasks, trail, runtime) and read-only annotation constant
│   │   ├── compact-message-renderer.ts # Shared compact 1-line / Ctrl+O expandable TUI message renderer primitives (`extractSummaryLine`, `createCompactOneLineComponent`, `createExpandedCustomBox`)
│   │   ├── widget-visibility.ts     # Shared collapse/expand widget state (expanded/collapsed, header-always-visible), globalThis reload persistence, shortcut validation/registration, and ui:toggle-all-widgets bridge
│   │   └── ui/                      # Shared UI components and browser helpers (cn, createBrowserLogger, useSharedWebSocket) used by pidash-ui and pidiff-ui
│   └── providers/                  # Default model restore & thinking-level persistence extension
│       ├── index.ts                # Extension entry — delegates to registerSessionRestore (skips meta invocations)
│       ├── session-restore.ts      # Unified session_start / model_select / thinking_level_select / session_shutdown restore lifecycle (#1360)
│       ├── restore-default-model.ts # Cold-start restore of saved default (provider-agnostic) after auth-race fallback (#753)
│       └── last-thinking-level.ts  # Per-model thinking-level persistence, locking, clamping, and policy helpers
├── templates/                       # Immutable prompt templates (source files for /create-* commands)
│   └── coms-feature-manager-prompt.md  # Coms feature manager template
├── prompts/                         # Prompt templates (slash commands)
│   ├── create-coms-feature-manager.md
│   ├── coderabbit-rate-limit.md
│   ├── domain-model.md
│   ├── implement-and-review.md
│   ├── implement.md
│   ├── pr-review.md
│   ├── query-db.md
│   ├── refine-review.md
│   ├── release.md
│   ├── remember.md
│   ├── report.md
│   ├── retro.md
│   ├── review-handler.md
│   ├── review-local.md
│   └── scout-and-plan.md
├── skills/                          # Bundled skills (auto-discovered by Pi)
│   ├── bug-report/SKILL.md          # Diagnostic bug-report workflow paired with /report (issue #1446)
│   ├── conflict-resolver/SKILL.md
│   ├── skill-creator/SKILL.md
│   ├── systematic-debugging/SKILL.md
│   ├── test-driven-development/SKILL.md
│   └── update-agents-md/SKILL.md
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
│   ├── cli.py
│   ├── coderabbit/
│   ├── db/
│   │   ├── sqlite_helpers.py        # Shared SQLite path, RO/RW connectors, and idempotent migration engine
│   │   ├── storage.py               # Unified reviews.db storage module (ReviewDB, schema, migrations, title backfill)
│   │   ├── query.py                 # Backwards-compatible re-export shim for myk_pi_tools.db.storage
│   │   └── commands.py              # CLI commands for querying reviews.db
│   ├── github.py                    # Unified GitHub CLI (gh) transport adapter (dependencies, REST, paginated JSON, GraphQL, PR resolution)
│   ├── memory/
│   ├── pr/
│   │   └── pr_review_store.py       # PR review comment tracking (pr-reviews.db)
│   ├── release/
│   ├── reviews/
│   └── utils.py                     # Shared utilities (git root, atomic JSON, stderr, backwards-compat re-exports from github.py)
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
│   ├── diagnostic-report-collect.mjs # Deterministic $0 runtime snapshot & redacted session warn/error log collector (issue #1446)
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
