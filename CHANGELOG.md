# Changelog

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
