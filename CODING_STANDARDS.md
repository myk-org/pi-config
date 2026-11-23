# Coding Standards (Review-Only)

This document is consulted by code reviewers during review (not injected into every implementation turn).
It covers non-mechanical engineering judgement calls that linters and typecheckers cannot verify.

## 1. Async Side-Effect Rollback & Retry-Budget Accounting

When an async workflow mutates counters, retry budgets, or pending flags *before* an `await`ed side effect
(for example, to preserve re-entrancy or duplicate-delivery protection), every failure path must restore
consistent state.

- **Roll back pre-`await` reservations on rejection:** If `sendSystemNote`, an RPC call, or another
  `await`ed side effect rejects, restore the incremented retry counter or consumed budget so failed
  deliveries do not silently exhaust the configured limit before real attempts occur (see PR #1334 Qodo
  Finding #2, `#discussion_r4658314222`, `extensions/orchestrator/malformed-response-recovery.ts`).
- **Guard rollbacks with a monotonic generation token:** Increment a generation counter
  (`budgetGeneration`) on every reset (`session_start`, non-extension `input`, or clean turn completion)
  and capture `const attemptGen = budgetGeneration` before `await`. In `catch`, decrement only when
  `budgetGeneration === attemptGen && counter > 0`. Never let a late rejection corrupt a counter reset by
  a newer turn or session.
- **Check ownership before clearing pending flags:** Only clear `pendingMessage` /
  `markRecoveryPending(false, sessionKey)` in `catch` when `pendingMessage === lastAssistant`, so a stale
  rejection cannot clobber a newer pending operation.
- **Notify deferred listeners on abort:** If another extension deferred completion while waiting for a
  recovery follow-up, notify abort on both send rejection and `session_shutdown` so deferred callers never
  hang.
- **Require a rejection-followed-by-retry test:** Any bounded retry/budget loop around an `await`ed side
  effect must have a test where the side effect rejects and a subsequent failure still receives the full
  configured number of successful retries.

## 2. Cross-Extension State Isolation & Lifecycle Invariants

Extensions load independently and hook registration order is not guaranteed (for example, `coms` may
register `agent_end` before `orchestrator`).

- **Use narrow typed bridges, never load-order assumptions:** Share cross-extension coordination through
  dedicated modules under `extensions/shared/` backed by `Symbol.for("pi-config.<name>")` (e.g.,
  `extensions/shared/malformed-recovery-bridge.ts`), never ad-hoc untyped globals or implicit
  event-handler order.
- **Key shared state by session, not process global:** Store per-session coordination in a
  `Map<sessionKey, Slot>` keyed via `resolveRecoverySessionKey(ctx)` rather than a single process-wide
  boolean or callback. Return an unregister function, invoke it in `session_shutdown`, and prune empty
  map entries so long-lived runtimes do not leak or cross-talk.
- **Migrate pending state cleanly on session-key changes:** When a session key transitions from a
  fallback (`DEFAULT_SESSION_KEY`) or switches on `session_start`, clear or transfer pending flags on the
  previous key before rebinding to the new key.
- **Never throw out of shared lifecycle hooks:** `before_agent_start`, `agent_end`, `tool_result`, and
  `session_shutdown` run alongside sibling extensions. Catch recoverable errors and log via `createLogger`
  so one extension cannot abort or stall others.
- **Guard timers, reloads, and oneshot mode:** Guard async/timer callbacks with `isLiveExtensionCtx(ctx)`
  (`extensions/shared/live-ctx.ts`), clear every interval/watcher/subscription on `session_shutdown`, and
  skip interactive daemons/handshake work in oneshot or headless invocations
  (`extensions/shared/oneshot.ts`).

## 3. Multi-Session Safety (`pi-sidecar` & Concurrent Runtimes)

Multiple sessions and concurrent callers may share one process or working tree.

- **Keep request- and session-scoped secrets strictly isolated:** In `packages/pi-sidecar/` and provider
  extensions, per-session `api_key` values and key-scoped model listings (`POST /models/for-api-key`) must
  remain scoped to the owning request or session — never cache globally, persist to disk, return in
  responses, log, or forward to nested agents.
- **Clean up credentials and registries on every exit path:** Purge in-memory secrets, close streams, and
  remove active-run entries in `finally`, delete, expiry, and `session_shutdown` handlers so aborted or
  failing turns never leak state.
- **Namespace filesystem state and publish atomically:** Scope per-session temp/run artifacts by session
  ID or PID + OS `startToken` (e.g., `sync-<session>-<n>`, `reload.pending`). Write control/flag files to
  a unique same-directory temp file, close, and atomically rename — never truncate in place.
- **Respect trust boundaries and provenance:** Never infer unknown pricing as `0` — preserve
  `Symbol.for("pi-config.pricingUnknown")` (`extensions/shared/pricing-provenance.ts`) and
  `cost_usd: null` / `cost_partial: true`, and never coalesce `null` to `0`. Require explicit literal
  trust markers at boundaries (e.g., `resolvePromptOrigin` literal `true`, `supportsSessionApiKey`
  capability checks).

## 4. Error Handling, Fail-Mode Clarity, & Observability

- **No silent error swallowing on actionable paths:** Every `catch` / `except` in runtime code must log
  via `createLogger` with structured context (operation, IDs/inputs, error), unless silence is explicitly
  justified in a comment (e.g., best-effort UI notification on a closing context).
- **Distinguish corrupt state from transient I/O errors:** Clean up provably corrupt state files (empty or
  syntactically invalid JSON/lockfiles), but leave transiently unreadable files (such as `EACCES`)
  untouched for retry/backoff rather than deleting valid state.
- **Be explicit about fail-closed vs fail-open:**
  - **Fail closed** on security, trust, and contract gates: unknown rule keys,
    `dangerous_command_allowlist`, unsupported `api_key` providers, unsafe paths, and unauthorized queue
    clears.
  - **Fail open** on advisory or UX helpers: missing Trail map, unauthenticated/unavailable Qodo CLI,
    missing review-learning DB, and `coms` history append failures.
- **Keep sensitive payloads out of logs:** Never log `api_key` values, auth credentials, or user
  `completionNote` text.

## 5. Test Determinism & Isolation

- **Zero ambient environment dependence:** Wrap synchronous tool registration in `withSubagentChildEnv`
  (`tests/node/helpers/subagent-env.ts`), assert `assert.ok(tool)` immediately, never wrap async test
  bodies, and cover `PI_SUBAGENT_CHILD=1` in its own test.
- **Reset global bridges and temp state:** Clean up any `Symbol.for(...)` bridge entries, env overrides,
  and temporary directories in `finally` / `afterEach` so test order never affects outcomes.
