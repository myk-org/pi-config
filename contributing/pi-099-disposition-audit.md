# pi 0.99 disposition audit (issue #848, workstream 4)

**Conclusion: no production code change is needed. Our queuing, FIFO drain, and
same-sender bundling were already correct under pi 0.99's per-input disposition
contract, and they never had access to it in the first place.**

Verified against pi `0.99.1` (`~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`)
and cross-checked against the repo-local `0.87.0` copy in `node_modules/`.

---

## 1. What actually changed in 0.99

Verified in `dist/core/agent-session.d.ts` and `dist/core/agent-session.js`:

| | 0.87.0 (repo `node_modules`) | 0.99.1 (runtime) |
|---|---|---|
| `preflightResult` | `(success: boolean) => void` | `(disposition: PromptDisposition) => void` |
| RPC reply data | no `disposition` field | `{ disposition }` |
| `RpcClient.prompt()` | no return value | `Promise<PromptDisposition>` |
| `prompt()` throws mid-run without `streamingBehavior` | **already yes** | yes (unchanged) |

The runtime branches behind `preflightResult` — `handled` (extension command or input
handler consumed the input, **no run started**), `queued` (queued during a run),
`started` (run accepted) — existed already in 0.87. **0.99 only changed the type from a
boolean to a named enum and surfaced it on the RPC wire.** The behaviour our code depends
on did not move.

**The single highest-value question — "do we prompt while already streaming without
`streamingBehavior`?" — was already answerable, and already answered, before 0.99.**
That error is a pre-existing contract, not a 0.99 regression.

## 2. Call-site inventory

There are exactly **three** ways this repo pushes input at an agent, and only one of
them can observe a disposition.

### (a) `pi.sendUserMessage(...)` — 5 sites, all pass `deliverAs`

| file:line | call |
|---|---|
| `extensions/orchestrator/cron.ts:116` | `pi.sendUserMessage(cmd, { deliverAs: "followUp" })` |
| `extensions/orchestrator/cron.ts:184` | `pi.sendUserMessage(..., { deliverAs: "followUp" })` |
| `extensions/pidash/pidash.ts:300` | `pi.sendUserMessage(content, { deliverAs: "followUp" })` |
| `extensions/pidash/pidash.ts:302` | `pi.sendUserMessage(parsed.text, { deliverAs: "followUp" })` |
| `extensions/pidiff/pidiff.ts:282` | `pi.sendUserMessage(message, { deliverAs: "followUp" })` |

(`cron.ts:184` is the `/cron` slash-command handler body. Every one of the five passes
`deliverAs`, which pi maps 1:1 onto `streamingBehavior` — see
`AgentSession.sendUserMessage`.)

### (b) `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` — coms, async agents, pitasks, rules, subagent-tool

The entire coms inbound pipeline and every async-agent result delivery. 30 sites;
the turn-triggering ones are at `extensions/coms/coms-p2p.ts:759, 2659, 2701, 2740,
2808, 2904, 2921, 3019, 3053`, `extensions/orchestrator/async-agents.ts:454, 611,
801, 1480`, `extensions/orchestrator/subagent-tool.ts:654, 669, 742, 756`,
`extensions/orchestrator/rules.ts:356, 400`, `extensions/pitasks/index.ts:285, 317`.

### (c) `entry.session.prompt(message)` — exactly one site

`packages/pi-sidecar/src/sessions.ts:1562`, guarded by `if (entry.inFlight)` at
`sessions.ts:1456`.

### (d) No `RpcClient` anywhere

`grep -rn "RpcClient|rpc-client|rpc_client|rpcClient"` over the whole repo returns
**zero hits**. We never run pi in `--mode rpc`, so `data.disposition` is unobservable
to us by construction. (`extensions/shared/oneshot.ts:43,85,105` reference the *string*
`"rpc"` only to decide that rpc mode is **not** oneshot.)

## 3. Per-area verdicts

### coms inbound queue — **CORRECT, and provably immune to disposition**

`extensions/coms/coms-p2p.ts:719` `handlePrompt` enqueues; `:744` bails out with an ack
if `processingInbound`; `:757` sets `processingInbound = true`; `:759` injects via
`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.

The decisive fact: `pi.sendMessage` → `AgentSession.sendCustomMessage`, which
**never routes through `prompt()`**. It dispatches directly to `agent.steer()` /
`agent.followUp()` / `_runAgentPrompt()`. Therefore:

- it never runs extension commands or input handlers → can never be `handled`;
- it never evaluates `streamingBehavior` → can never throw the mid-run error;
- it has no disposition at all.

So the `agent_end` → drain → `agent_end` cycle at `coms-p2p.ts:2625, 3005, 3080` is
exactly as valid as it was before 0.99. FIFO order is `Map` insertion order
(`inboundQueue`, `:627`) plus an explicit `allPending[0]` pick at `:3010`.
Same-sender bundling at `:3040-3072` groups by `sender_session` and injects one
`[BUNDLED: N messages]` turn, fulfilling the rest with `error: "bundled"` at
`:2981-3001`. None of this consults or should consult pi's queue.

`extensions/coms/queue-recovery.ts` is the one place that reads a host queue shape
(`validRpcQueue` at `:86` reads `{ steering, followUp }`). That is pi's
`clearQueue()`/`getQueue()` reply, **unchanged in 0.99** (`dist/modes/rpc/rpc-client.d.ts:83-84`).
It is a peek-and-clear contract, not a per-input disposition. **No rename, no drift.**

### async agents — **CORRECT**

`async-agents.ts` tracks its own job queue (`status: "queued" | "running" | ...` at `:57`,
spawn at `:915` as `pi --mode json -p -nc`). Each async agent is a **fresh headless
process**, so it is never streaming when prompted. Results are delivered via
`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` (`:458, :615, :805, :1484`)
— the custom-message path, immune as above. The `:814` "Only mark delivered AFTER
sendMessage succeeds" ordering is preserved. **No change.**

### pidash — **CORRECT (and the one area worth watching)**

`pidash.ts:288` decides whether to tell the browser `prompt-queued` using its **own**
`isStreaming` flag, tracked `agent_start` → `agent_settled` at `:748-749`, then calls
`pi.sendUserMessage(..., { deliverAs: "followUp" })` at `:300/:302`.

That flag is advisory only. Because `deliverAs` is always supplied, **both** drift
directions are harmless:

- pidash thinks idle, pi is streaming → `followUp` queues it. UI under-reports. No error.
- pidash thinks streaming, pi is idle → pi starts the turn anyway. UI over-reports. No error.

`pidash.ts:923` forwards `event.streamingBehavior` to the browser **for display only**
(`useMessageHandler.ts:80`); it is never fed back as a delivery decision. Correct as is.

### pi-sidecar HTTP `/prompt` — **CORRECT, by guard rather than by parameter**

`sessions.ts:1562` calls `entry.session.prompt(message)` with **no options at all** — no
`streamingBehavior`. It is safe because of the in-flight guard at `sessions.ts:1456`:
`entry.inFlight` is set synchronously at `:1461` (before any `await`), so a concurrent
request is rejected with `Session ${id} is busy` while the first run is still active.
`AgentSession.prompt` resolves only after `_runAgentPrompt` completes, and `inFlight` is
cleared in the `finally` at `:1578-1580`.

Residual (pre-existing, not 0.99, and worth a separate issue rather than a speculative
fix here): sidecar sessions load project extensions, so a message starting with `/` that
matches a registered command — or one consumed by an input handler — returns
`{ text: "", usage: {...} }` with no run. `preflightResult` would let sidecar observe
that, but that is an **API shape change to the sidecar contract**, i.e. a feature request,
not a disposition-migration fix. Not done here.

### `agent_settled` consumers — **CORRECT, not a disposition proxy**

`status-line.ts:188`, `pidash.ts:749`, `pitasks/index.ts:366` all *register for* the
event; none waits on a prompt return value that might now be `handled`. The 0.99 hazard
("if disposition is `handled`, do not wait for `agent_settled`") cannot bite us because
none of these are waiting on a specific input's outcome.

### Read a field pi renamed/extended? — **No**

Nothing in the repo reads `.disposition`, `response.data.disposition`, or imports
`rpc-client`. Our own envelope fields (`queued_msg_ids`, `your_pending`,
`error: "bundled"`) are the coms wire protocol, unrelated to pi.

## 4. What changed

Production code: **nothing.** The honest answer is that the logic was already correct,
and manufacturing a "simplification" here would have meant deleting the coms
FIFO/bundling layer that pi does not and will not replace — pi's queue is per-session
input queueing, whereas coms is a cross-session, per-peer, request/reply queue with
recovery previews. They solve different problems.

Two things were added:

1. `tests/node/shared/prompt-disposition.test.ts` — five tests that fail if the audit's
   premises stop holding:
   - `AgentSession.prompt()` is still `Promise<void>`, mid-run input without
     `streamingBehavior` still throws, `sendCustomMessage` still bypasses `prompt()`;
   - no repo file reads `.disposition` or imports `rpc-client` (adopting either forces a
     doc update);
   - every `pi.sendUserMessage()` call site passes `deliverAs`;
   - pi-sidecar's bare `session.prompt()` still has exactly one call site, still passes no
     `streamingBehavior`, and the in-flight guard still precedes it;
   - coms never uses `sendUserMessage`, and every turn-triggering `pi.sendMessage`
     passes `deliverAs: "followUp"`.

   No network calls; the only external read is the installed pi package's own `.d.ts`/`.js`.

2. This document.

## 5. Follow-ups (not done — need a decision, not a diff)

- **Sidecar silent-empty-response on handled input.** See above. Needs an API decision.
- **`extensions/coms/queue-recovery.ts:131` / `:167`** (`previewRpcQueue` / `clearRpcQueue`)
  have no production caller — only `tests/node/coms/queue-recovery.test.ts`. Dead unless
  a peer extension is expected to wire `RpcQueueRecoveryProvider`. Worth deleting or
  wiring; deliberately untouched by this workstream.
- **Version skew.** The repo's `node_modules/@earendil-works/pi-coding-agent` is `0.87.0`
  while the pi binary that actually loads these extensions is `0.99.1`. `package.json:65`
  pins `"*"`. Typechecking against 0.87 means 0.99-only API (e.g. `QueuedInputDisposition`)
  is invisible to us at build time. This is why the disposition field could not be used
  without a resolution bump.
