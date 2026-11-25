# Changelog

## [6.1.0] - 2026-11-26

- Adopted Pi 1.6.1 `blockedKind` (OSC 7501 Program Status Kind) in `ui-bridge.ts` and
  `enforcement.ts` (`confirm()` defaults to `"permission"`, dangerous-bash approval selects pass
  `{ blockedKind: "permission" }`, forwarded on both custom and fallback dialogs) (#1411).
- Passed `--type text/plain` to `wl-copy` in `worktree-helpers.ts` for Wayland/Klipper clipboard
  compatibility (#1411).
- Registered `after_provider_response` in `provider-stream-log.ts` to log HTTP 4xx/5xx provider
  responses at `warn` with allowlisted truncated retry headers (`retry-after`, `x-request-id`,
  `request-id`, `cf-ray`) while keeping chunk-level stream logging gated on debug (#1411).
- Surfaced `details.fullOutputError` warnings inline on both direct and async-agent PiDash tool
  cards (`pidash-transcript-reducer.ts`) and documented `compat.supportsStrictMode` for custom and
  gateway-prefixed Gemini 3+/4 models in `docs/pi-sidecar.md` (#1411).

## [6.0.0] - 2026-11-25

- **BREAKING CHANGE:** Simplified `/tasks`, `/cron`, `/coms`, `/worktree`, `/pi-config-settings`,
  and `/adopt-skill` to zero-arg TUI overlays with `Space` multi-select; renamed `/async-status`
  to `/async`; removed `/coms-queue`, `/dream`, and `/dream-auto`; and added `dream_auto_enable`
  setting (#1396).
- **BREAKING CHANGE:** Removed `/external-ai`, `/external-ai-models-refresh`, `myk_pi_tools/ai_cli`,
  and external AI CLI installs (#1389).
- Consolidated 5 project JSONL state stores (`memory-scoring`, `memory-embeddings` as Float32 BLOBs,
  `memory-provenance`, `session-search`, and worktree-scoped `pi-config-review-state`) into a
  `node:sqlite` WAL database (`.pi/data/state.db`) with lossless migration (#1401) and added v1 → v2
  `migrated_stores` schema upgrade for `source_mtime_ms`/`source_size` (#1407).
- Replaced `pidash` raw WS delta `eventBuffer` replay with a single canonical `session_snapshot`
  frame and shared transcript reducer on browser watch/reconnect (#1400).
- Blocked `ask_user` in non-TUI supervised COMS peers (`PI_COMS_SUPERVISED_PEER=1`, `mode !== "tui"`
  guard, `interactive_tui` rules predicate, `coms_send` routing) and fixed `coms-p2p.ts` /
  `live-ctx.ts` stale-ctx reload crash and untracked 60s cleanup timers (#1404).
- Added 7 LLM parity tools (`async_status`, `session_status`, `worktree_status`, `daemon_manage`,
  `skill_adopt`, `memory_dream`, `coms_local_queue`) (#1390) and `cron_manage` `edit`/`pause`/`resume`
  actions (#1382).
- Added live bound async agent badge (`[⏳ ...]`) on tasks widget rows (#1388) and trigger-keyword
  descriptions across shipped skills and skill-creation rules (#1387).
- Fixed TUI overlay multi-select Kitty CSI-u / non-Latin key handling, inline feedback banner,
  `N selected` badge, Esc-clears-selection, detail-view selection persistence, shared optional-note
  dialog on bulk `d`, and single/bulk `u` (reopen/undone) in `/tasks` (#1393).
- Clarified in `rules/60-task-tracking.md` and task tool descriptions that agents must delete
  still-pending obsolete `[you]` tasks once verified done externally (#1408).

## [5.1.0] - 2026-11-23

- Added opt-in post-merge PR retrospective (`/retro` prompt, collector script, and `pr_retro`
  setting) (#1350).
- Added streaming assistant repetition/degeneration loop abort guard (`stream-loop-guard.ts`) on
  `message_update` with per-session COMS abort-reply protection (#1375).
- Fixed `coms-welcome` banner to never force `triggerTurn` on reconnect/reload (#1352), enforced
  per-session keying for cross-extension `globalThis` bridges (#1346), and scanned recent
  uncompacted sessions in `session_search` (#1347).
- Included compact open-task summary in `TaskUpdate` and `TaskBulkUpdate` tool responses (#1345).
- Completed 9 architecture-deepening module consolidations across `pi-orchestrator-config`:
  settings store (`project-settings.ts`, #1365), startup model/thinking restore (`session-restore.ts`,
  #1366), unified cross-extension `session-bridge.ts` (#1369), unified `memory-store.ts` (#1370),
  shared `daemon-manager.ts` + `pidiff/lockfile.ts` (#1371), `pidiff-ui` `DiffSessionController`
  (#1372), `pidash` `discord-session-routing.ts` (#1377), `orchestrator` `bash-policy.ts` (#1378),
  and COMS `ComsPeerRuntime` + `ComsRegistry` (#1379).
- Documented cross-extension lifecycle hook ordering (#1344) and trimmed `AGENTS.md` to navigation
  pointers with review-only `CODING_STANDARDS.md` (#1349).

## [5.0.0] - 2026-11-22

- **BREAKING CHANGE:** Removed `acpx-provider` and `cli-provider` extensions, shared runtime provider
  driver infrastructure, CLI specialist symlinking, settings keys, and related dead async dispatch code
  (#1328).
- Added bounded `MALFORMED_RESPONSE` auto-recovery (`MAX_CONSECUTIVE_MALFORMED_RETRIES = 2`) with
  per-session COMS deferral coordination and retry-budget restoration (#1334).
- Added amber `⏸` paused and mixed cron status indicators across the TUI status bar, `/status`, and
  PiDash `InfoBar`, and removed `N/M reads` clutter from the Trail footer (#1330).
- Preserved active `ask_user` / `extension_ui_request` prompts in PiDash across session switches,
  browser reloads, and Pi-to-daemon reconnects, with authoritative `ui-dismiss` state sync (#1332).
- Added cached worktree visibility to the status bar (`[wt]` / `4a-worktrees`), `/status`, and
  `/worktree` interactive overlay + `list`/`prune` subcommands with clickable PR links (#1323).
- Added collapse/expand widget toggles (`Alt+T`, `Alt+C`, `Alt+W`) with persistent headers and
  configurable shortcuts across `tasks` and `coms` widgets (#1327).
- Improved `ask_user` and `ui-bridge` TUI UX with a shared bounded question viewport, `tab`/`alt+p`
  chat peek toggle, on-demand option filter, multi-line `Editor`, strict `Esc` cancel, and Pi `1.6.0`
  `Container` caching (#1320).
- Fixed COMS inbound FIFO drain under `followUp` starvation by delivering each inbound response
  directly at `turn_end` (#1322).
- Raised minimum Pi version floor to `1.6.0`, bumped `undici` to `>=8.12.4`, and aligned
  `readonly string[]` render types (#1321).
- Applied codebase-wide performance optimizations across orchestrator, memory, review-learning,
  subagents, COMS, pitasks, providers, pidash/pidiff, and shared hot paths (#1216, #1217, #1220,
  #1222, #1223, #1302, #1303, #1305, #1306, #1309, #1310, #1311).

## [4.34.3] - 2026-11-19

- Simplified skill adoption and maintenance to use Pi's built-in `pi.getCommands()` registry
  (`source === "skill"`, excluding shipped package skills via `origin === "package"`, `node_modules/`, or
  package-alias targets), removed all `write`/`edit`/`bash` skill blocking guards, and preserved
  auto-adoption on new `.pi/skills/<name>/SKILL.md` writes, mid-turn failure nudges, provenance, and
  turn-end notices (#1156).

## [4.34.2] - 2026-11-18

- Adopted (`skill-maintenance: auto`) owned project skills now have no bash or write limitations: helper
  scripts (such as `release-publish/publish-release.sh`), `$()` command wrappers, `chmod`, and shell
  writes run freely when every skill mention resolves inside adopted owned skills, while unmarked project
  skills, `.agents/skills/`, user-global skills, package skills, symlink escapes, bare root mentions,
  `cd` escapes, variable/glob targets, `ln`, and mixed commands remain strictly guarded (#1153).

## [4.34.1] - 2026-11-18

- Brand-new project skills under `.pi/skills/<name>/SKILL.md` are now auto-adopted by default on `write`
  (`skill-maintenance: auto` and the maintenance instruction are stamped automatically via `stampSkill`),
  while existing unmarked skills, unreadable existing files (`lstatSync` non-`ENOENT`), symlinks,
  `.agents/skills/`, user-global, and package skills remain blocked (#1148).
- Fixed literal `" + trailerName + "` / `" + fileMessage + "` JavaScript concatenation in
  `handleCommitTrailer` refusal hints and POSIX single-quoted the suggested redirect file path (#1146).
- `commitMessageSpecs` and `cwdAt` now follow `git` global options (`-C`, `-c`, `--no-pager`), `env -C` /
  `--chdir`, and clustered `-aF` / `-am` flags, inspect every commit segment using its last `-F`, block
  opaque `-F` operands (expansions, redirects, line continuations) and same-command overwrites on both
  resolved and relative paths, and strip unquoted `#` shell comments before fallback checks (#1139).
- Shell syntax checks (`bash -n`, `sh -n`, `dash -n`, `zsh -n`, `--noexec`) are now allowed on any skill
  script when invoked via a bare or realpath-verified shell binary with no value-taking option, `+` flags,
  or `-c` (#1141).
- Standalone single-segment data heredocs (`cat`/`printf`/`echo`/`tee` outside subshells, with no outer
  substitutions, no `<<<` here-strings, and targets outside skills) now have their bodies blanked before
  skill-path analysis so prose mentioning a skill path is not blocked (#1142).

## [4.34.0] - 2026-11-17

- An option prompt can be answered in words. In Discord an `ask_user` with options showed a select menu and
  nothing else, even though the answer path already accepted a typed custom answer — the free-text modal was
  reached only when a question had no options at all. An option prompt now returns two action rows, the menu
  and a `✎ Type answer` button that opens the same modal, because Discord forbids mixing a select with buttons
  in one row (#1134).
- A typed modal answer is literal. The answer path that parses chat replies (`1` = first option, `cancel` =
  cancel) no longer applies to a modal submission, so what the user types is the answer — `1` is the string
  `1` and `cancel` is text. Messages typed into the channel keep the parsing, which is what makes them
  convenient (#1134).
- Free text is offered only where it can be accepted. An approval's bridged validation ignores an answer that
  is not one of the offered options, so giving every select prompt a modal made a custom answer report
  "Answer sent." while the approval kept waiting. Prompts now carry `freeText`, set only by `ask_user`, and
  the modal row exists only for those. A prompt with more options than Discord's 25-item menu shows the first
  25 entries — a menu value is an index into the original list, so the mapping stays correct — rather than
  falling back to a modal that cannot be honoured (#1134).
- The discuss-first row is gone. `ask_user` no longer offers a `Discuss with AI first` option, and the
  `allowDiscuss` parameter, the `__discuss__` sentinel and the guidance that told the model to expect it are
  removed; a caller that still passes that label gets it back as an ordinary option (#1134).
- The prompt-row logic moved to a pure `buildPromptControls` with the discord.js builders injected, so the
  rows are asserted without a Discord client. The component logic previously had no tests at all, which is how
  the TUI/Discord asymmetry survived (#1134).

## [4.33.0] - 2026-11-17

- Sync subagents are visible. A sync run is a real child process, but the footer, `/async-status` and pidash
  only ever knew about async jobs, so "how many agents are running" was answerable only by scrolling. A
  process-local registry now records each sync run from `runSingleAgent` and clears it in a `finally`, the
  footer reports both modes (`⏳ agents: 2 (2 sync)`, unchanged `⏳ async: N` when nothing is sync), the
  overlay lists sync rows marked `sync` and stops them by run id, and each run writes a session-scoped
  `sync-runs/<id>/status.json` in the layout the overlay already reads. A stop from the overlay returns a
  failed result instead of throwing, so a parallel batch keeps its completed siblings (#1121).
- A stopped round stays honest. A parent abort now wins over an earlier overlay stop instead of being
  swallowed as an ordinary failure, a user-stopped runaway no longer feeds the sync overrun penalty that
  would reject the next call, and success requires the child's stop reason — a zero-exit child reporting
  `error` is not described as complete. `status.json` is written with `flag: "wx"` after unlinking, so a
  hostile checkout cannot pre-place a symlink and have run metadata overwrite another file, and a
  symlinked run directory is refused (#1121).
- The skill shell guard stops refusing commands it can prove. A `cd` blocked the whole command merely by
  appearing, even when its target was this project and every relative path resolved to the same absolute
  file; a `cd` is now pinned only when it is the single first segment with a literal absolute target and
  no variable expansion can move the path, and `timeout` is unwrapped so a bounded helper run is
  classified by its real verb. `$PWD` references, quoted or escaped `cd`, a symlinked target and a
  relative `..` reference are all still refused, because in each the shell's target differs from the
  classified one (#1122).
- A home-relative path is no longer "unresolvable". The navigation gate resolved search operands with
  `path.resolve`, which leaves `~` literal, so `~/.ssh/config` became `<checkout>/~/.ssh/config`, the
  realpath threw, and the gate blocked an ordinary command — while the same command against `/etc/hosts`
  was allowed. Tildes are now expanded only when the shell would expand them: exactly `~` and `~/…`, never
  inside quotes, never when the command assigns `HOME`, and never for `~user` (#1128).

## [4.32.0] - 2026-11-16

- A task carries an `assignee`: `user` or `llm`. A user-assigned task cannot be started or completed
  by an agent — including by reassigning and changing status in one call — and the owner closes it in
  `/tasks`, where the completion note is recorded and delivered without automatic retries (#1090).
- Every `/tasks` write action is multi-select, and the overlay can add or edit a task and pause an
  active cron. A stored pause is honoured before dispatch, not after, and a transient store read error
  no longer discards a durable schedule (#1087).
- `/tasks start` and `/tasks done` exist as subcommands, so the two hot actions no longer need the
  overlay (#1082).
- Coms peers are navigable: a drilldown shows a peer's sessions and open work, a selection survives a
  round trip, and an ambiguity is refused instead of guessed (#1084).
- The user can message a peer: `/coms tell <peer> <message>` and the `m` composer stamp
  `origin: "user"` through a bridge that tool calls cannot reach, so no `coms_send` can claim human
  authorship (#1077).
- Skill maintenance replaces the skill review agent: a marked project skill (`skill-maintenance:
  auto`) that fails steers the turn once, every allowed write is recorded in
  `.pi/data/skill-review.jsonl`, and the shell may run skill scripts but never write skill files
  (#1073, #1074, #1103).
- A dangerous command can be allowed for this session, and the approval prompt explains why each
  pattern fired (#1073).
- Async results are delivered per agent as each finishes, kept across reloads, and a late result no
  longer writes review state or double-counts a retry; a recovered chain stops instead of resuming on
  stale routing (#1110).
- Owner tasks are refused for agents across the two-step peer bypass, peer outcomes are stripped, and
  filtered task views stay usable (#1107).
- Task telemetry is bridged across extension instances instead of living in one module copy (#1102).
- Trailers are injected into piped commits, including `tee` stages and compound spans, with skipped
  operands logged instead of silently dropped (#1101).
- The task widget follows the store it was meant to: symlink hops and missing ancestors are resolved,
  a corrupt file is preserved rather than overwritten, and the poll is capped (#1097).
- Reload handshakes are trustworthy: a reused PID is detected by start token, a child session cannot
  delete a deploy handshake, a non-watcher process never touches the files, and a corrupt pending file
  is quarantined with retry backoff instead of blocking the queue (#1091, #1092).
- Settings come from one file: only `pi-config-settings.json` is read, a legacy `.jsonc` is migrated,
  a vanished legacy file counts as migrated, and a repo-shipped symlinked settings dir is refused
  (#1086, #1088).
- Resolved third-party review findings stop re-raising: suppression age is resolved with `git log` as
  an argv list and a literal pathspec, and an older published CLI fails open (#1085).
- An async job records the task store path it will write, resolved from the project directory, so a
  worktree job lands in the store its parent reads (#1080, #1026).
- Discord answers the question that was asked: a channel's own target outranks the watch, a thread
  stays on its own session, a DM cancel is session-agnostic, every refused inbound message is logged
  at warn, and routine refusals are throttled at info (#1075).
- pidiff's `cn` import is relative, so the tests project cannot type-check it against pidash's helper
  (#1094).
- The release workflow runs the working-tree `myk-pi-tools`, while every other prompt invokes
  `uvx myk-pi-tools@latest` and drops the install precheck — a published build cannot plan its own
  successor (#1029).
- The test tree is type-checked: a `tsconfig.tests.json` project joins `npm run typecheck`, the
  overlay harness is typed instead of `any`, and four shared fakes replace hand-rolled mocks (#1094).

## [4.31.1] - 2026-11-10

- A killed peer now shuts down before its supervisor exits: `stop()` ends stdin deliberately, sends
  SIGTERM, waits for the child to exit and escalates to SIGKILL only after a bounded timeout
  (`PI_COMS_STOP_TIMEOUT_MS`, default 5s). The record carries `stoppedAt` and `exitedAt`, so a peer can
  no longer leave a ghost registry entry or a stale socket behind.
- A peer that ignores SIGTERM is killed and recorded as `forced: true`, instead of looking like a clean
  stop.
- An invalid `PI_COMS_STOP_TIMEOUT_MS` (empty, NaN, zero, negative) no longer fires the escalation
  immediately and cuts the peer's cleanup short — it means the 5s default.
- A replacement peer's record survives: the exiting supervisor rewrites the record only when it still
  belongs to it, so a peer restarted under the same name and project is not erased.

## [4.31.0] - 2026-11-10

- Peer listings are scoped to the caller's project: a peer in another project cannot be addressed from
  here, so `coms_peers` and `/coms list` show only this one. `project:"*"` / `--all` widen to the
  machine, kill-all follows the same scope, and a scope that cannot be determined refuses instead of
  signalling every project.
- `coms_peer_spawn` exists: an agent can create a peer itself — a supervised `pi --coms` process with
  its own session, addressable by name, registering in about 20-30s. Creation used to require a human
  to run a script path documented in a rules file.
- The peer supervisor ships in the npm tarball and is resolved relative to the extension, so spawning
  works from an installed copy instead of only from a checkout.
- A peer under a configured `coms_dir` is killable: the configured directory reaches the supervisor, so
  its ownership record lands where the wrapper reads.
- "Every project" has one definition, consulted by the kill plan, its ambiguity guard, the list and the
  kill: a wildcard kill with an ambiguous name refuses instead of stopping two peers.
- Refusals are traceable and safe: spawn and kill decisions log their scope and reason, project names
  that cannot exist as a directory (dots-only, `CON`, `NUL`, `:`) are refused up front, and an async
  launch error can no longer crash the session.

## [4.30.0] - 2026-11-09

- Coms can be started by an agent (`coms_start`), not only by a slash command, and peers run as
  supervised `pi --coms` processes with their own sessions: spawn, list every peer on the machine,
  and stop one or all. Only supervised peers are killable — never your own session or another human's.
- The peer detail view says who created a peer and through which entry point (`coms_start`,
  `/coms start`, `pi --coms`), preferring the supervisor's record; peers predating the field read
  `unknown` rather than being guessed.
- A Discord question reaches you even when its session is not the one you watch: it gets its own
  thread and the answer never moves your watch. Thread, then DM, then channel.
- The Trail gate judges a search with no path argument by its base directory, which it previously
  skipped: `cd /other/repo && rg pattern` is exempt again while `rg pattern /other/repo` stays gated.
  Flag values, quoted patterns, `&&` conditions, pipelines and `git -C` are parsed by the shared
  splitter instead of a private one.
- Coms no longer answers "already active" without a socket: a stale claim is verified, the old server
  shut down, and a fresh peer started. Activation, peer provenance and kill scope are all decided in
  tested pure functions.

## [4.29.1] - 2026-11-08

- A surviving `setTimeout` can no longer exit pi: the spawn-exit timer emitted `subagents:*` on the
  extension instance replaced by `/reload`, whose `emit` throws `assertActive` inside a timer
  callback. `emitIfLive` swallows exactly that throw (warn, with the job id) and every emit in
  async-agents goes through it.
- A child that fails around a reload is recorded instead of vanishing from the task list: recording
  no longer depends on a live ctx, only delivery does, and the decision lives in a tested pure
  function.
- A skipped emit is reported as lost at warn with its job id, a live listener's exception is logged
  as an error rather than blamed on staleness, and a missing emitter reports "not delivered".

## [4.29.0] - 2026-11-07

- Every review round records WHAT it reviews: a `ReviewSubject` (`pr` with repo and head, `issue`,
  `local` commit, `plan` file, or `other`) is required by `addReviewerPending`, so a round can no
  longer count for nothing. The counter resets per subject, `/review-status` prints the subject, and
  the status line reads `Review cycle 3 — PR #1056 @ 0fd58c45 — 2 findings`.
- The cycle cap belongs to one loop: an exhausted `review_loop_max_cycles` no longer licenses
  commits for a different commit, and only a `pr`/`local` subject whose head matches `HEAD` can
  exhaust it at all.
- PR identity survives escaping, transient failures and branch switches: the PR comes from the
  shared cached lookup in `git-helpers` (no private `gh` wrapper, no synchronous network wait in
  dispatch), parsed from JSON instead of a jq filter, cached per branch, and the subject carries the
  local head so unpushed commits start a new loop.
- A reviewer joining a pending round for another plan or commit replaces the stored subject instead
  of inheriting it.

## [4.28.1] - 2026-11-07

- The Trail gate forces again. The runtime prefixes shell commands with `rtk`, so no search was
  classified and searches of mapped code ran unguarded; `rtk` is handled by the shared command-word
  parser instead of a private wrapper list.
- The gate honours where a search really runs: `cd`, repeated `git -C`, symlinked directory hops,
  and a failed or backgrounded `cd` all keep it closed. A redirect no longer counts as an operand,
  and a quoted `'<'` stays a pattern.
- Gitignored scratch and other trees are no longer gated: a search of `.pi/tmp`, build output, a
  sibling checkout, or a directory the map holds nothing beneath is exempt, decided by the map
  rather than `.gitignore`. The checkout root, mapped directories, indexed files and ancestors
  (`..`, `/`) still gate.

## [4.28.0] - 2026-11-07

- Settings backups are scoped to a TUI visit: `/pi-config-settings` takes one restore point per
  session instead of one per changed value, so the state you opened the overlay with survives a
  burst of edits. Writes outside the TUI (allowlist approval, browser save) still back up per
  action, and a snapshot left by a crashed visit is promoted rather than overwritten.
- The backup lock is a single `O_EXCL` file: a dead owner's lock is taken over atomically, an
  orphaned lock clears inside the same save, and a save that genuinely cannot take the lock still
  refuses instead of shifting the chain and losing another process's restore point.
- `bash -n file` no longer asks for approval — a pure syntax check runs nothing. Expansions,
  backticks, process substitution, `+` options, `--`, `-c`, quotes and backslashes still ask.
- `rm -rf` on a literal path inside the project `.pi/tmp` or `~/.pi/tmp` skips approval, with the
  exemption logged as a statement hash. The operand must name the scratch both as written and as
  resolved; `..`, backslashes, globs, quoting, subshells and `sudo` all still ask.
- A missing `HOME` no longer makes the dangerous-command gate throw instead of deciding.

## [4.27.0] - 2026-11-07

- Settings writes keep a configurable history: the previous file is copied to `.bak.1` before every
  write, older copies rotate up to `settings_backup_count` (default 5, range 0-20,
  `PI_SETTINGS_BACKUP_COUNT`), and lowering the count prunes the extra copies. A write whose backup
  cannot be made is refused rather than proceeding without a fallback.
- A settings file that does not parse is never replaced: the save is refused
  (`SettingsFileCorruptError`) and the file is left byte-identical, so a hand-repairable file cannot
  be emptied by generated content.
- Test processes can no longer write real settings: under `node:test`, writes outside the temp tree
  are refused, checked against the **real** path so a symlinked `.pi` cannot reach a real project.
- An unscoped `tool_name bash` memory rule is refused at write time and ignored at load time, so a
  memory entry can neither block every command nor append a banner to every result. "always
  ask_user before X" is promoted as an ordering verifier instead of a blanket warning.
- Log fallbacks stay inside the project: `.pi/tmp/pi-logs` is tried before the home copy, and a
  vanished working directory no longer throws while the fallback list is built.
- The qodo-review prompt writes its context under `.pi/tmp`, not `/tmp`.

## [4.26.1] - 2026-11-06

- The tmp sweep carries no hardcoded control-file name list: it asks
  `daemon-manager.isLiveLegacyDaemonFile()`, which owns the two legacy names, so a future daemon
  writing to `.pi/run` can never require the sweep to be edited. A legacy `pidiff.port`/`pidiff.pid`
  is kept only while its recorded PID is alive (`EPERM` counts as alive — another user's running
  process), and a dead daemon's leftovers plus every `reload.*` marker are swept like any other
  entry. Deleting a live daemon's lockfiles would make the next connect() spawn a duplicate on its
  port.
- A control file can no longer block or exhaust a session: `readLockfile` accepts only regular
  files, so a project FIFO at `pidiff.port`/`pidiff.pid` is ignored, and the pid read is capped at
  64 bytes so an oversized file is rejected without being read.

## [4.26.0] - 2026-11-06

- Async `chain` mode: steps run in sequence and each step's result is substituted into `{previous}`,
  with per-step `taskId`/`cwd`, the step position in the status line and result header, a durable
  `chain.json` for reload reporting, and stop-on-failure. `onComplete` receives `{ text, isError }` and
  fires exactly once, so a retried reconciliation pass cannot spawn the next step twice.
- A tool call pi rejects for invalid arguments now forces a retry. Such a call skips `tool_call` and
  `tool_result`, so nothing told the model its action never ran and a turn could end silently. The guard
  matches pi's own rejection preamble, keeps only the parameter diagnostics (argument values can hold
  credentials and the system note is a provenance-marked channel), and names the likely mistake.
- The UI bridge degrade path honours an approval again: without `ctx.ui.custom`, `confirm` returned a
  boolean while the wrapper compared `"__confirmed__"`, so every prompt in that runtime cancelled.

## [4.25.0] - 2026-11-06

- `.pi/tmp` is cleaned at session start: above `project_tmp_max_size` (default `2G`), entries older than
  `project_tmp_retention_days` (default 7 days) are deleted oldest-first until the tree fits, and `0`
  disables it entirely. The sweep lock lives in `.pi/run` rather than in the directory being swept, a run
  that cannot take the lock deletes nothing, an entry replaced mid-scan is skipped, and oneshot sessions
  skip the whole thing. A bad size value deletes nothing rather than falling back to a deleting default.
- Daemon control files moved to `.pi/run` — `pidiff.pid`, `pidiff.port`, and the `reload.flag` /
  `reload.done` / `reload.pending` handshake. Readers fall back to `.pi/tmp` and `reload.done` is mirrored
  back, so a daemon started before the upgrade is still found instead of a second one spawning on its
  port. **The migration release needs exactly one manual `/reload`**: a session whose watcher was loaded
  before the move cannot observe the new flag path. The old temp-dir reload files stay protected until no
  pre-upgrade daemon remains.
- The pending-task reminder keys on how long a task has actually been pending rather than on the first
  60-second tick, so it no longer fires about a minute after creation. It measures the oldest active task,
  treats an undated task as old so a fresh sibling cannot mask it, and covers `agentBusy` in tests.
- `reviews fetch` approves on a clean findings catalog at the PR head instead of requiring a `completed`
  Qodo session, so a legitimately skipped auto-run can approve. A run that is still in progress never does.
  `reason` reports `no_findings`, `open_findings`, `not_at_head`, or `all_resolved` instead of always
  claiming `all_resolved`, and the review-loop exit names which reviewer actually approved — a CodeRabbit
  approval is no longer reported as Qodo's.

## [4.24.2] - 2026-11-04

- Async work is tracked even when an agent starts it: the task trigger now covers work set in
  motion by an async result, and `taskId: "-1"` is restricted to a single read-only check in
  every place that taught the old habit.
- Task-id validation actually runs. `pitasks` exports the store as a live binding that the
  subagent tool used to snapshot before it was assigned, so an unknown id was accepted; the
  store is now published on a symbol bridge and read at access time. Verified live: unknown
  ids rejected, a real id and the read-only sentinel accepted.
- Machine-generated notices declare their provenance: follow-ups are prefixed
  "[system message — not written by the user]", so a guard rail cannot be read as user input.
- Board updates are success-gated — a failed agent keeps its task open — and reconciling the
  board before new dispatch is mandatory. Status reports derive from `TaskList`.

## [4.24.1] - 2026-11-03

- Dreaming no longer stores re-derivable changelog: `[done]` takes non-derivable outcomes only (conclusions, measurements, root causes) and reorganizing prunes PR/version/ticket
  history, so `completions` shrinks instead of rotating changelog for changelog. A live run took this project's topic from 18 entries to 2, keeping the cost baseline and the
  self-reload finding.
- Learned memory now survives maintenance: anything a dream deletes that is pinned, enforced, or review-distilled is restored when it finishes, and a topic file it deleted is
  rebuilt. A deliberate removal is respected because removals are recorded as tombstones rather than inferred from score state — the inference inverted whenever the scheduled
  rebuild ran mid-dream.
- `completions` is capped at 6,000 characters through per-topic caps, applied by both write paths. The cap is never satisfied by deleting memory: an over-cap topic is reported and
  left intact.

## [4.24.0] - 2026-11-03

- `/pr-review` asks how to decide after the findings table — `Post all`, `Skip all`, or
  `Decide one by one` — instead of one bulk answer for everything.
- Deciding one by one gives each finding its own dialog (post, skip, skip with reason, more
  context, stop), captures the skip reason at decision time, keeps author questions on their
  Approve / Edit / Skip path, and stores a reason even for a bare skip.
- Every `ask_user` prompt offers "💬 Discuss with AI first", which returns a sentinel meaning
  "talk about this decision first" rather than an answer; a caller that passes that row itself
  gets one row, and `allowDiscuss: false` removes it.
- Docs: the `ask_user` reference covers `allowDiscuss` and the sentinel; the workflow page
  documents the mode choice and the real turn cost.

## [4.23.0] - 2026-11-02

- Minimum pi version raised to 1.5.0 — the extension floor, the sidecar floor, and every manifest move together.
- Interactive dialogs (ask_user and the pidash bridge) now report "blocked on user input" while they wait, so terminals that track program status show pi as waiting instead of busy.
- This changelog ships with the package and pi reads it after `pi update --extensions`, so an update now tells you what changed.
- The `subagent` tool keeps its `agentScope` values as a real enum after pi 1.5.0 changed how `StringEnum` types itself, so the parameter stays validated and documented.
- Release workflow keeps this changelog current on every bump, and a changelog-only change now marks the package as affected.
- Docs: MCP OAuth client registration (`auto` / `dcr` / `cimd`), `PI_SELF_UPDATE_COMMAND` for wrapper installs, and the billed-vs-estimated cost contract.

## [4.22.4] - 2026-11-02

- Minimum pi version raised to 1.5.0 (extension and sidecar floors, manifests).
- Sidecar reports cost billed by the provider instead of only estimated cost.
- Status reporting for interactive dialogs blocked waiting on user input.
