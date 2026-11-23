/**
 * Per-session SSE turn feed (#1019) — `GET /sessions/:id/events`.
 *
 * Hub-level tests: every frame is asserted through a fake transport sink, so a
 * subscriber's fate is never confused with the prompt path that produced the
 * event. Session behaviour is driven through the injected InMemoryProviderRuntime
 * adapter (no Pi SDK or provider calls).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import {
  SessionEventStreams,
  SessionStore,
  StreamDeltaHoldback,
  createApiKeyRedactor,
  type SessionStreamSink,
  type StoredSession,
} from "../../src/sessions.js";
import { InMemoryProviderRuntime } from "./helpers/in-memory-runtime.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

// Recording OFF is the default config and the point of one of the tests below;
// pin it (and the transcript dir) so a developer's env cannot change the result.
let savedRecording: string | undefined;
let savedTranscriptsDir: string | undefined;
let tempDir: string;

before(() => {
  savedRecording = process.env.RECORD_TRANSCRIPTS;
  savedTranscriptsDir = process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
  delete process.env.RECORD_TRANSCRIPTS;
  tempDir = makeTempDir("sidecar-sse-stream-1019-");
  process.env.PI_SIDECAR_TRANSCRIPTS_DIR = tempDir;
});

after(() => {
  if (savedRecording === undefined) delete process.env.RECORD_TRANSCRIPTS;
  else process.env.RECORD_TRANSCRIPTS = savedRecording;
  if (savedTranscriptsDir === undefined) delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
  else process.env.PI_SIDECAR_TRANSCRIPTS_DIR = savedTranscriptsDir;
  rmSync(tempDir, { recursive: true, force: true });
});

/** 1 MB bounded-queue budget from the spec — asserted literally, not imported. */
const MAX_PENDING_BYTES = 1_048_576;
/** Per-session feed ceiling from the spec. */
const MAX_STREAMS_PER_SESSION = 8;
const KEEPALIVE_MS = 15_000;
const IDLE_MS = 10 * 60 * 1000;

/** Transport sink that records raw SSE bytes and can fail the way a dead socket does. */
class FakeSink implements SessionStreamSink {
  raw = "";
  ended = 0;
  pendingBytes = 0;
  failWith?: Error;

  write(frame: string): void {
    if (this.failWith) throw this.failWith;
    this.raw += frame;
  }

  bufferedBytes(): number {
    return this.pendingBytes;
  }

  end(): void {
    this.ended++;
  }
}

interface StreamFrame {
  kind: "event" | "comment";
  block: string;
  data?: any;
}

/**
 * Client-side SSE parse: blocks are separated by a blank line, and an event's
 * payload is the joined `data:` lines of its block — exactly what EventSource
 * does. A frame that leaks a raw newline into its payload shows up here as a
 * second `data:` line (or as invalid JSON), never as silent success.
 */
function frames(sink: FakeSink): StreamFrame[] {
  const parsed: StreamFrame[] = [];
  for (const block of sink.raw.split("\n\n")) {
    if (block.trim() === "") continue;
    const lines = block.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) {
      parsed.push({ kind: "comment", block });
      continue;
    }
    assert.equal(dataLines.length, 1, `each frame carries exactly one data line, got block:\n${block}`);
    parsed.push({
      kind: "event",
      block,
      data: JSON.parse(dataLines[0].slice("data:".length).trimStart()),
    });
  }
  return parsed;
}

function events(sink: FakeSink): any[] {
  return frames(sink).filter((frame) => frame.kind === "event").map((frame) => frame.data);
}

function comments(sink: FakeSink): string[] {
  return frames(sink).filter((frame) => frame.kind === "comment").map((frame) => frame.block);
}

/** The turn's terminal events — a turn must produce exactly one of these. */
function terminals(sink: FakeSink): any[] {
  return events(sink).filter((event) => event.type === "turn_end" || event.type === "error");
}

const delta = (text: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: text },
});

const agentEnd = (text: string, stopReason = "stop") => ({
  type: "agent_end",
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
      stopReason,
    },
  ],
});

type Emit = (event: any) => void;

/** Scripted StoredSession: `script` runs inside prompt(), after subscribe registered. */
function scriptedSession(script: (emit: Emit) => Promise<void> | void, extra: {
  abort?: () => Promise<void>;
  dispose?: () => void;
} = {}): StoredSession {
  let handler: Emit | undefined;
  const emit: Emit = (event) => handler?.(event);
  return {
    subscribe: (onEvent: Emit) => {
      handler = onEvent;
      return () => {
        handler = undefined;
      };
    },
    prompt: async () => {
      await script(emit);
    },
    dispose: extra.dispose ?? (() => {}),
    abort: extra.abort ?? (async () => {}),
  };
}

/** A plain two-delta turn producing "Hello world". */
function textSession(): StoredSession {
  return scriptedSession((emit) => {
    emit(delta("Hello"));
    emit(delta(" world"));
    emit(agentEnd("Hello world"));
  });
}

function createInMemoryStore(sessionFactory: () => StoredSession = textSession): SessionStore {
  return new SessionStore({
    runtime: new InMemoryProviderRuntime({
      ready: true,
      allowAnyModel: true,
      sessionFactory,
    }),
  });
}

async function createSession(
  session: StoredSession,
  opts: { apiKey?: string; cwd?: string } = {},
): Promise<{ store: SessionStore; id: string }> {
  const store = createInMemoryStore(() => session);
  const id = await store.create({
    provider: "test",
    model: "test",
    systemPrompt: "sse stream test",
    cwd: opts.cwd ?? "/tmp",
    apiKey: opts.apiKey,
  });
  return { store, id };
}

describe("session event stream: delta delivery (#1019)", () => {
  it("delivers every text_delta in emit order, then exactly one turn_end", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("one-"));
        emit(delta("two-"));
        emit(delta("three"));
        emit(agentEnd("one-two-three"));
      }),
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    assert.deepEqual(
      events(sink).map((event) => event.type),
      ["session", "turn_start", "text_delta", "text_delta", "text_delta", "turn_end"],
      "one opening frame, one turn_start, the deltas in emit order, one turn_end",
    );
    const deltas = events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta);
    assert.deepEqual(deltas, ["one-", "two-", "three"], "delta text must arrive in emit order");
    const [turnStart] = events(sink).filter((event) => event.type === "turn_start");
    const [turnEnd] = terminals(sink);
    assert.equal(turnEnd.type, "turn_end");
    assert.equal(turnEnd.turnId, turnStart.turnId, "the terminal event belongs to the same turn");
    assert.equal(turnEnd.aborted, false);
    assert.equal(turnEnd.text, "one-two-three", "turn_end carries the final text, not the concatenated deltas");
    assert.equal(result.text, "one-two-three");
    const ids = new Set(events(sink).filter((event) => event.type !== "session").map((event) => event.turnId));
    assert.equal(ids.size, 1, "every turn frame shares one turn id");
  });

  it("a turn that collected errors still ends with exactly one terminal event", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("partial"));
        emit({ type: "error", error: "provider exploded" });
        emit(agentEnd("partial"));
      }),
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    const terminal = terminals(sink);
    assert.equal(terminal.length, 1, "a turn must never emit both turn_end and error");
    assert.equal(terminal[0].type, "error", "the collected error is the terminal event for this turn");
    assert.match(terminal[0].message, /provider exploded/);
    assert.match(result.error ?? "", /provider exploded/);
    assert.equal(events(sink).filter((event) => event.type === "turn_end").length, 0);
  });

  it("fires the terminal event with recording disabled (the default config)", async () => {
    const { store, id } = await createSession(textSession());
    assert.equal(store.isRecordingEnabled(), false, "this test must run on the default config");
    const sink = new FakeSink();
    store.openStream(id, sink);

    await store.prompt(id, "hi");

    // Regression: an anchor emitted from inside the recordTurn gate never runs
    // here, so a recording-gated implementation produces no terminal event.
    assert.equal(store.isRecordingEnabled(), false);
    assert.equal(terminals(sink).length, 1, "the terminal event must not depend on transcript recording");
    assert.equal(terminals(sink)[0].type, "turn_end");
  });

  it("a zero-delta turn still emits turn_end carrying the fallback text", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        // Tool-only / provider-without-deltas turn: text only exists on agent_end.
        emit(agentEnd("fallback text"));
      }),
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    assert.equal(events(sink).filter((event) => event.type === "text_delta").length, 0);
    const terminal = terminals(sink);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, "turn_end");
    assert.equal(terminal[0].text, "fallback text");
    assert.equal(result.text, "fallback text");
  });
});

describe("session event stream: abort (#1019)", () => {
  it("abort mid-stream ends the turn once as turn_end{aborted:true} and the feed stays usable", async () => {
    const sink = new FakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let promptCalls = 0;
    const { store, id } = await createSession(
      scriptedSession(
        async (emit) => {
          promptCalls++;
          if (promptCalls > 1) {
            emit(delta("second turn"));
            emit(agentEnd("second turn"));
            return;
          }
          emit(delta("partial "));
          emit(delta("answer"));
          // Abort wins over a collected error: still one terminal event.
          emit({ type: "error", error: "aborted by client" });
          await gate;
        },
        { abort: async () => release() },
      ),
    );
    store.openStream(id, sink);

    const pending = store.prompt(id, "hi");
    while (events(sink).filter((event) => event.type === "text_delta").length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await store.abort(id);
    const first = await pending;

    const firstTerminal = terminals(sink);
    assert.equal(firstTerminal.length, 1, "an aborted turn emits exactly one terminal event");
    assert.equal(firstTerminal[0].type, "turn_end", "abort wins over the collected error");
    assert.equal(firstTerminal[0].aborted, true);
    assert.equal(firstTerminal[0].text, "partial answer", "the aborted turn_end carries the partial text");
    assert.equal(first.text, "partial answer");

    const second = await store.prompt(id, "again");

    assert.equal(second.text, "second turn");
    const starts = events(sink).filter((event) => event.type === "turn_start");
    assert.equal(starts.length, 2, "the aborted feed is reusable for a second turn");
    const secondTerminal = terminals(sink).filter((event) => event.turnId === starts[1].turnId);
    assert.equal(secondTerminal.length, 1, "the aborted turn must not be re-terminated by the next turn");
    assert.equal(secondTerminal[0].type, "turn_end");
    assert.equal(secondTerminal[0].aborted, false);
    assert.equal(secondTerminal[0].text, "second turn");
    assert.equal(terminals(sink).length, 2);
  });

  it("abort with no turn in flight is a no-op and does not mark the next turn aborted", async () => {
    const sink = new FakeSink();
    let sdkAborts = 0;
    const { store, id } = await createSession(
      scriptedSession(
        (emit) => {
          emit(delta("Hello"));
          emit(agentEnd("Hello"));
        },
        { abort: async () => { sdkAborts++; } },
      ),
    );
    store.openStream(id, sink);

    await store.abort(id);
    assert.equal(sdkAborts, 0, "an idle session has nothing to abort");

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "Hello");
    const terminal = terminals(sink);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].aborted, false, "a stale abort must not leak into the next turn");
  });

  it("a failed abort does not label the still-running turn aborted", async () => {
    const sink = new FakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, id } = await createSession(
      scriptedSession(
        async (emit) => {
          emit(delta("Hello"));
          await gate; // the turn keeps running after the abort request fails
          emit(agentEnd("Hello"));
        },
        { abort: async () => { throw new Error("abort exploded"); } },
      ),
    );
    store.openStream(id, sink);

    const pending = store.prompt(id, "hi");
    while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(store.abort(id), /abort exploded/);
    release();
    await pending;

    const terminal = terminals(sink);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].aborted, false, "a rejected abort must not report the turn as cancelled");
  });

  it("a successful abort wins over a concurrent rejection, whichever settles first", async () => {
    /** One controllable settle per abort call, so the test picks the order. */
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    // failIndex 0: the first abort rejects and the second cancels (the ordering
    // that used to clear the flag). failIndex 1: the same race, other way round.
    for (const failIndex of [0, 1]) {
      const sink = new FakeSink();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = [deferred(), deferred()];
      let call = 0;
      const { store, id } = await createSession(
        scriptedSession(
          async (emit) => {
            emit(delta("partial"));
            await gate; // the turn keeps running until the test ends it
            emit(agentEnd("partial"));
          },
          {
            abort: async () => {
              const index = call++;
              await calls[index].promise;
              if (index === failIndex) throw new Error("abort exploded");
            },
          },
        ),
      );
      store.openStream(id, sink);

      const pending = store.prompt(id, "hi");
      while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const aborts = [store.abort(id), store.abort(id)];

      const outcomes: string[] = [];
      for (const index of [0, 1]) {
        calls[index].resolve();
        await aborts[index].then(() => outcomes.push("ok"), () => outcomes.push("rejected"));
      }

      assert.equal(outcomes[failIndex], "rejected", `failIndex ${failIndex}: the failing abort rejects its caller`);
      assert.equal(outcomes[1 - failIndex], "ok", `failIndex ${failIndex}: the other abort succeeds`);

      release();
      await pending;

      const terminal = terminals(sink);
      assert.equal(terminal.length, 1, `failIndex ${failIndex}: still exactly one terminal event`);
      assert.equal(terminal[0].type, "turn_end");
      assert.equal(terminal[0].aborted, true, `failIndex ${failIndex}: a rejection must not hide the abort that landed`);
    }
  });

  it("an abort rejecting after the next turn started cannot clear that turn's cancellation", async () => {
    const sink = new FakeSink();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const gateA = deferred();
    const gateB = deferred();
    // Aborts settle only when the test says so: turn A's rejects (late), turn
    // B's succeeds once A's rejection has already landed.
    const lateAbortA = (() => {
      let reject!: (err: Error) => void;
      const promise = new Promise<void>((_res, rej) => {
        reject = rej;
      });
      return { promise, reject };
    })();
    const abortB = deferred();
    let promptCalls = 0;
    let abortCalls = 0;
    const { store, id } = await createSession(
      scriptedSession(
        async (emit) => {
          if (promptCalls++ === 0) {
            emit(delta("first"));
            await gateA.promise;
            emit(agentEnd("first"));
            return;
          }
          emit(delta("second"));
          await gateB.promise;
          emit(agentEnd("second"));
        },
        {
          abort: async () => {
            if (abortCalls++ === 0) await lateAbortA.promise; // turn A: rejects late
            else await abortB.promise; // turn B: cancels
          },
        },
      ),
    );
    store.openStream(id, sink);

    const firstTurn = store.prompt(id, "first");
    while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const staleAbort = store.abort(id).then(() => "ok", (err: Error) => err.message);
    gateA.resolve(); // turn A ends while its abort is still pending
    await firstTurn;

    const secondTurn = store.prompt(id, "second");
    while (events(sink).filter((event) => event.type === "text_delta").length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Turn B's cancellation is requested but still pending when turn A's abort
    // rejects — the window where a re-read of entry.abortState would decrement
    // turn B's pending count and clear its request.
    const liveAbort = store.abort(id);
    lateAbortA.reject(new Error("abort exploded late"));
    assert.match(await staleAbort, /abort exploded late/, "the late rejection still reaches its caller");
    abortB.resolve();
    await liveAbort;
    gateB.resolve();
    const second = await secondTurn;

    assert.equal(second.text, "second");
    const starts = events(sink).filter((event) => event.type === "turn_start");
    assert.equal(starts.length, 2, "turn B really started after the stale abort was still pending");
    assert.equal(
      terminals(sink).filter((event) => event.turnId === starts[0].turnId).length,
      1,
      "turn A keeps its single terminal event",
    );
    const secondTerminal = terminals(sink).filter((event) => event.turnId === starts[1].turnId);
    assert.equal(secondTerminal.length, 1, "turn B keeps its single terminal event");
    assert.equal(secondTerminal[0].type, "turn_end");
    assert.equal(
      secondTerminal[0].aborted,
      true,
      "a stale abort rejecting across the turn boundary must not clear turn B's cancellation",
    );
  });

  it("a second concurrent prompt is still rejected and the attached feed stays coherent", async () => {
    const sink = new FakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, id } = await createSession(
      scriptedSession(async (emit) => {
        emit(delta("Hello"));
        await gate;
        emit(agentEnd("Hello"));
      }),
    );
    store.openStream(id, sink);

    const pending = store.prompt(id, "first");
    while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(store.prompt(id, "second"), /busy|concurrent/i);
    release();
    const result = await pending;

    assert.equal(result.text, "Hello");
    assert.equal(events(sink).filter((event) => event.type === "turn_start").length, 1, "the rejected prompt opens no turn");
    assert.equal(terminals(sink).length, 1);
    assert.equal(terminals(sink)[0].type, "turn_end");
  });
});

describe("session event stream: subscriber containment (#1019)", () => {
  it("a prompt with no subscriber returns the same response shape as one with a subscriber", async () => {
    const store = createInMemoryStore();
    const sink = new FakeSink();
    const quietId = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    const watchedId = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    store.openStream(watchedId, sink);

    const quiet = await store.prompt(quietId, "hi");
    const watched = await store.prompt(watchedId, "hi");

    assert.deepEqual(
      Object.keys(quiet),
      ["text", "usage", "stop_reason"],
      "the response object is unchanged by #1019 (stop_reason is #1111)",
    );
    assert.deepEqual(Object.keys(watched), Object.keys(quiet));
    assert.equal(watched.text, quiet.text);
    assert.equal(watched.error, quiet.error);
    assert.deepEqual(Object.keys(watched.usage), Object.keys(quiet.usage));
    for (const key of Object.keys(quiet.usage)) {
      if (key === "duration_ms") continue; // wall clock, not comparable
      assert.deepEqual(watched.usage[key], quiet.usage[key], `usage.${key}`);
    }
    assert.equal(terminals(sink).length, 1, "the subscriber saw its turn end");
  });

  it("a throwing subscriber cannot fail a prompt and is dropped while others keep receiving", async () => {
    const { store, id } = await createSession(textSession());
    const thrower = new FakeSink();
    thrower.failWith = new Error("socket hang up");
    const survivor = new FakeSink();
    store.openStream(id, thrower);
    store.openStream(id, survivor);

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "Hello world", "a dead sink must never surface into the prompt result");
    assert.equal(result.error, undefined);
    assert.equal(thrower.ended, 1, "the throwing subscriber is dropped");
    assert.equal(events(thrower).length, 0);
    assert.equal(survivor.ended, 0, "the healthy subscriber is untouched");
    assert.deepEqual(
      events(survivor).map((event) => event.type),
      ["session", "turn_start", "text_delta", "text_delta", "turn_end"],
    );

    await store.prompt(id, "again");

    assert.equal(thrower.ended, 1, "a dropped subscriber is not written to or ended twice");
    assert.equal(terminals(survivor).length, 2, "the surviving subscriber keeps receiving later turns");
  });

  it("a second subscriber gets its own session frame and does not disturb the first", async () => {
    const { store, id } = await createSession(textSession());
    const first = new FakeSink();
    const second = new FakeSink();
    store.openStream(id, first);
    const before = first.raw;

    store.openStream(id, second);

    assert.equal(events(second).filter((event) => event.type === "session").length, 1, "the newcomer is greeted");
    assert.equal(first.raw, before, "an open feed gets no duplicate session frame and no idle reset");

    await store.prompt(id, "hi");
    for (const sink of [first, second]) {
      assert.equal(events(sink).filter((event) => event.type === "session").length, 1);
      assert.equal(terminals(sink).length, 1, "both subscribers see the turn end");
    }
  });

  it("a slow subscriber over the 1 MB budget is evicted alone", async () => {
    const store = createInMemoryStore();
    const id = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    const slow = new FakeSink();
    slow.pendingBytes = MAX_PENDING_BYTES + 1;
    const fast = new FakeSink();
    store.openStream(id, slow);
    store.openStream(id, fast);

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "Hello world", "eviction must not disturb the turn");
    assert.equal(slow.ended, 1, "the subscriber past the byte budget is evicted");
    assert.equal(fast.ended, 0, "the healthy subscriber is not collateral");
    assert.deepEqual(
      events(fast).map((event) => event.type),
      ["session", "turn_start", "text_delta", "text_delta", "turn_end"],
    );
    assert.equal(events(slow).filter((event) => event.type === "turn_end").length, 0, "the evicted sink stops receiving");

    // Exactly at the budget is still within it (<=, not <).
    const edge = new FakeSink();
    edge.pendingBytes = MAX_PENDING_BYTES;
    const edgeId = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    store.openStream(edgeId, edge);
    await store.prompt(edgeId, "hi");
    assert.equal(edge.ended, 0, "a subscriber at exactly the budget is kept");
    assert.equal(terminals(edge).length, 1);
  });

  it("detaching on close leaves the hub empty with no lingering timers", async (t) => {
    const { store, id } = await createSession(textSession());
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const first = new FakeSink();
    const second = new FakeSink();

    const detachFirst = store.openStream(id, first);
    const detachSecond = store.openStream(id, second);
    assert.equal(comments(first).length, 0);

    detachFirst();
    detachSecond();

    assert.equal(first.ended, 1);
    assert.equal(second.ended, 1);
    assert.equal(store.streamCount(id), 0, "subscriber count must return to zero");

    // A cleared keepalive/idle timer must not fire after detach.
    t.mock.timers.tick(IDLE_MS + KEEPALIVE_MS * 4);
    assert.equal(comments(first).length + comments(second).length, 0, "detached subscribers receive nothing");
    assert.equal(first.ended, 1, "a detached subscriber is not ended twice");
    assert.equal(second.ended, 1);
  });

  it("detach is idempotent — a teardown that fires twice closes the sink once", async () => {
    const { store, id } = await createSession(textSession());
    const sink = new FakeSink();
    const detach = store.openStream(id, sink);

    detach();
    detach();
    // Request and response teardown can both land (a retried or raced close).
    assert.equal(sink.ended, 1, "the sink is ended exactly once");
    assert.equal(store.streamCount(id), 0);
    assert.doesNotThrow(() => detach());
  });
});

describe("session event stream: redaction and framing (#1019)", () => {
  it("a delta echoing the session api_key arrives redacted in the frame", async () => {
    const secret = "sk-live-1019-fixture-secret"; // pragma: allowlist secret — synthetic test sentinel
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta(`key is ${secret}`));
        emit(agentEnd(`key is ${secret}`));
      }),
      { apiKey: secret },
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    const [deltaEvent] = events(sink).filter((event) => event.type === "text_delta");
    assert.equal(deltaEvent.delta, "key is [REDACTED]");
    assert.ok(!sink.raw.includes(secret), "the raw frame must not carry the key");
    assert.equal(terminals(sink)[0].text, "key is [REDACTED]");
    assert.ok(!result.text.includes(secret));
  });

  it("a delta containing an SSE frame cannot inject a second event", async () => {
    const injected = '\n\ndata: {"x":1}';
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta(injected));
        emit(agentEnd(injected));
      }),
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    await store.prompt(id, "hi");

    // Client-side: the injected text is one delta event, not an extra frame.
    const parsed = events(sink);
    assert.deepEqual(parsed.map((event) => event.type), ["session", "turn_start", "text_delta", "turn_end"]);
    const [deltaEvent] = parsed.filter((event) => event.type === "text_delta");
    assert.equal(deltaEvent.delta, injected, "the payload survives verbatim");
    assert.equal(parsed.filter((event) => event.x === 1).length, 0, "no forged event reached the client");
    // Server-side: no blank-line separator inside a frame payload.
    assert.equal(sink.raw.split("\n\n").filter((block) => block.trim() !== "").length, 4);
  });
});

describe("session event stream: split-key redaction (#1019 holdback)", () => {
  /** Synthetic 25-char sentinel: a delta boundary can hide at most 24 of its chars. */
  const KEY = "sk-split-holdback-0123456789"; // pragma: allowlist secret — synthetic test sentinel

  /** One turn that streams `parts` in order, each part its own delta. */
  function splitSession(parts: string[]): StoredSession {
    return scriptedSession((emit) => {
      for (const part of parts) emit(delta(part));
      emit(agentEnd(parts.join("")));
    });
  }

  it("a key split across a delta boundary never appears in any frame, at any split point", async () => {
    const before = "the key is ";
    // Every split point, so a fix that merely widens the buffer fails on some.
    for (let cut = 1; cut < KEY.length; cut++) {
      const { store, id } = await createSession(
        splitSession([before, KEY.slice(0, cut), KEY.slice(cut), " done"]),
        { apiKey: KEY },
      );
      const sink = new FakeSink();
      store.openStream(id, sink);

      const result = await store.prompt(id, "hi");

      const deltas = events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta);
      const streamed = deltas.join("");
      assert.ok(!streamed.includes(KEY), `cut ${cut}: the key leaked across the concatenated frames: ${streamed}`);
      assert.ok(!sink.raw.includes(KEY), `cut ${cut}: the key leaked into the raw SSE bytes`);
      // Holdback is not a drop: the withheld tail is flushed before turn_end.
      const terminal = terminals(sink)[0];
      assert.equal(streamed, terminal.text, `cut ${cut}: the flushed deltas must add up to the final text`);
      assert.equal(streamed, `${before}[REDACTED] done`, `cut ${cut}: everything but the key still arrives in order`);
      assert.equal(result.text, `${before}[REDACTED] done`, `cut ${cut}: POST /prompt is unaffected`);
      assert.equal(terminal.text, `${before}[REDACTED] done`);
      assert.equal(terminals(sink).length, 1, `cut ${cut}: still exactly one terminal event`);
    }
  });

  it("an escaped echo of the key is held back too, at every split point", async () => {
    // The redactor decodes percent and JSON escapes, so both escaped spellings
    // of the key are LONGER than the key itself — a holdback of key.length - 1
    // misses a boundary inside them.
    const percent = [...Buffer.from(KEY, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
    const jsonEscapedPercent = percent.replaceAll("%", "\\u0025");
    // A leak in the raw bytes is JSON-escaped by the frame itself, so look for
    // the escaped spelling of each form there.
    const asFramePayload = (needle: string) => JSON.stringify(needle).slice(1, -1);
    for (const form of [percent, jsonEscapedPercent]) {
      for (let cut = 1; cut < form.length; cut++) {
        const { store, id } = await createSession(
          splitSession([`echo ${form.slice(0, cut)}`, `${form.slice(cut)} done`]),
          { apiKey: KEY },
        );
        const sink = new FakeSink();
        store.openStream(id, sink);

        const result = await store.prompt(id, "hi");

        const streamed = events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
        for (const needle of [KEY, percent, jsonEscapedPercent]) {
          assert.ok(!streamed.includes(needle), `cut ${cut}: ${needle} leaked across the concatenated frames: ${streamed}`);
          assert.ok(!sink.raw.includes(asFramePayload(needle)), `cut ${cut}: ${needle} leaked into the raw SSE bytes`);
        }
        const terminal = terminals(sink)[0];
        assert.equal(streamed, "echo [REDACTED] done", `cut ${cut}: everything but the escaped key still arrives in order`);
        assert.equal(terminal.text, "echo [REDACTED] done", `cut ${cut}: turn_end carries the redacted text`);
        assert.equal(result.text, "echo [REDACTED] done", `cut ${cut}: POST /prompt is unaffected`);
        assert.equal(terminals(sink).length, 1, `cut ${cut}: still exactly one terminal event`);
      }
    }
  });

  it("holds text back only for a session that carries a key", async () => {
    const { store, id } = await createSession(textSession());
    const sink = new FakeSink();
    store.openStream(id, sink);

    await store.prompt(id, "hi");

    // A key-free redactor needs no window: deltas go out as they arrive.
    assert.deepEqual(
      events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta),
      ["Hello", " world"],
    );
  });
});

describe("session event stream: keepalive and idle reaping (#1019)", () => {
  it("sends a keepalive comment while the feed is idle", async (t) => {
    const { store, id } = await createSession(textSession());
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const sink = new FakeSink();
    store.openStream(id, sink);

    t.mock.timers.tick(KEEPALIVE_MS - 1);
    assert.equal(comments(sink).length, 0, "no keepalive before the interval elapses");
    t.mock.timers.tick(1);
    assert.deepEqual(comments(sink), [": keepalive"]);
    assert.match(sink.raw, /: keepalive\n\n$/, "keepalives are SSE comments, not events");
    assert.equal(events(sink).length, 1, "a keepalive adds no event");
  });

  it("reaps a subscribe-only client on the idle timeout despite its keepalives", async (t) => {
    const { store, id } = await createSession(textSession());
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const sink = new FakeSink();
    store.openStream(id, sink);

    t.mock.timers.tick(IDLE_MS - KEEPALIVE_MS);
    assert.ok(comments(sink).length >= 30, "keepalives keep flowing while the client is silent");
    assert.equal(sink.ended, 0, "a keepalive must not refresh the idle timer");

    t.mock.timers.tick(2 * KEEPALIVE_MS);
    assert.equal(sink.ended, 1, "the idle subscribe-only client is reaped past the idle window");
    const seen = comments(sink).length;
    t.mock.timers.tick(KEEPALIVE_MS * 2);
    assert.equal(comments(sink).length, seen, "a reaped subscriber stops receiving keepalives");
  });
});

describe("session event stream: session lifecycle (#1019)", () => {
  it("DELETE ends the deleted session's streams", async () => {
    const store = createInMemoryStore();
    const deletedId = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    const deleted = new FakeSink();
    store.openStream(deletedId, deleted);
    assert.equal(store.delete(deletedId), true);
    assert.equal(deleted.ended, 1, "DELETE /sessions/:id ends the feed");
  });

  it("cleanupStale ends a stale session's streams", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const store = createInMemoryStore();
    const staleId = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    const stale = new FakeSink();
    store.openStream(staleId, stale);
    t.mock.timers.tick(60_000);
    assert.equal(store.cleanupStale(1_000), 1);
    assert.equal(stale.ended, 1, "cleanupStale ends the feed of the session it removes");
  });

  it("disposeAll ends every active session's streams", async () => {
    const store = createInMemoryStore();
    const disposedId = await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" });
    const disposed = new FakeSink();
    store.openStream(disposedId, disposed);
    await store.disposeAll();
    assert.equal(disposed.ended, 1, "disposeAll ends the feed");
  });

  it("enforces the per-session stream ceiling", async () => {
    const { store, id } = await createSession(textSession());
    const sinks: FakeSink[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) {
      const sink = new FakeSink();
      sinks.push(sink);
      store.openStream(id, sink);
    }
    assert.equal(store.streamCount(id), MAX_STREAMS_PER_SESSION);

    assert.throws(
      () => store.assertStreamAllowed(id),
      (err: any) => err.statusCode === 429 && /max 8/.test(err.message),
      "the 9th subscriber on one session is rejected with 429",
    );
    assert.throws(
      () => store.openStream(id, new FakeSink()),
      (err: any) => err.statusCode === 429,
      "openStream re-checks the ceiling",
    );
  });

  it("rejects unknown sessions with 404", () => {
    const store = createInMemoryStore();
    assert.throws(
      () => store.assertStreamAllowed("missing"),
      (err: any) => err.statusCode === 404,
      "an unknown session is a 404",
    );
  });

  it("enforces the process-wide stream ceiling across sessions", async () => {
    const store = createInMemoryStore();
    const ids: string[] = [];
    for (let session = 0; session < 5; session++) {
      ids.push(await store.create({ provider: "test", model: "test", systemPrompt: "test", cwd: "/tmp" }));
    }
    // 4 sessions × 8 = 32 — the global ceiling.
    for (const id of ids.slice(0, 4)) {
      for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) store.openStream(id, new FakeSink());
    }
    assert.throws(
      () => store.assertStreamAllowed(ids[4]),
      (err: any) => err.statusCode === 429 && /max 32/.test(err.message),
      "a session under its own cap is still rejected past the global ceiling",
    );
  });
});

describe("prompt response: stop_reason (#1111)", () => {
  it("a clean turn reports stop_reason end_turn and no error", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("complete answer"));
        emit(agentEnd("complete answer", "end_turn"));
      }),
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    assert.equal(result.stop_reason, "end_turn", "the response body alone identifies a normal stop");
    assert.equal(result.error, undefined);
    // Existing event behaviour is untouched: the turn still ends with turn_end.
    assert.equal(terminals(sink).length, 1);
    assert.equal(terminals(sink)[0].type, "turn_end");
  });

  it("a partial reply that stopped on error is distinguishable from a clean end_turn", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("partial"));
        emit({ type: "error", error: "provider exploded" });
        emit(agentEnd("partial", "error"));
      }),
    );
    const sink = new FakeSink();
    store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "partial");
    assert.ok(result.error, "the collected error is still surfaced");
    assert.equal(result.stop_reason, "error", "the response body names the error stop, not just the failure");
    // Existing event behaviour is untouched: an errored turn ends with error, not turn_end.
    assert.equal(terminals(sink).length, 1);
    assert.equal(terminals(sink)[0].type, "error");
  });

  it("a rejected turn with partial text reports stop_reason error", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("partial"));
        throw new Error("provider exploded mid-turn");
      }),
    );

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "partial");
    assert.ok(result.error, "the rejection is still surfaced as a structured result");
    // The catch records the turn as `error`; the body must not contradict it.
    assert.equal(result.stop_reason, "error", "a rejected turn reports the value its transcript records");
  });

  it("a rejected turn with partial text and collected errors reports stop_reason error", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("partial"));
        emit({ type: "error", error: "provider exploded" });
        throw new Error("connection lost");
      }),
    );

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "partial");
    assert.ok(result.error, "the collected and rejection errors are surfaced");
    assert.equal(result.stop_reason, "error");
  });

  it("a turn with no final assistant message and no error reports null", async () => {
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("partial"));
      }),
    );

    const result = await store.prompt(id, "hi");

    assert.equal(result.error, undefined);
    assert.equal(result.stop_reason, null, "nothing to guess when no assistant message ended the turn");
  });
});

describe("session event stream: non-streaming redaction bypass & late subscriber (#1161)", () => {
  it("skips per-delta redaction when no SSE subscribers are attached while still redacting final response", async () => {
    const secret = "sk-non-stream-key-1161"; // pragma: allowlist secret — synthetic test sentinel
    const realRedact = createApiKeyRedactor(secret);
    let redactCalls = 0;
    const countingRedact = (value: string) => {
      redactCalls++;
      return realRedact(value);
    };
    const deltas = ["prefix ", ...Array.from({ length: 50 }, (_, i) => `c${i} `), "sk-non-", "stream-", "key-1161", " suffix"];

    // Verify holdback performs zero per-delta redaction calls when no subscribers are attached.
    const hub = new SessionEventStreams();
    const holdback = new StreamDeltaHoldback(countingRedact, hub, 1);
    let acc = "";
    for (const chunk of deltas) {
      const prevLen = acc.length;
      acc += chunk;
      holdback.pushDelta(chunk, acc, prevLen);
    }
    holdback.flush();
    assert.equal(redactCalls, 0, "expected zero per-delta redaction calls when streams.size === 0");

    // End-to-end through SessionStore.prompt(): final response is still redacted.
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        for (const chunk of deltas) emit(delta(chunk));
        emit(agentEnd(deltas.join("")));
      }),
      { apiKey: secret },
    );

    const result = await store.prompt(id, "hi");

    const expectedPrefix = `prefix ${Array.from({ length: 50 }, (_, i) => `c${i} `).join("")}`;
    assert.equal(result.text, `${expectedPrefix}[REDACTED] suffix`);
  });

  it("handles a subscriber attaching mid-turn without leaking pre-attach deltas or keys", async () => {
    const secret = "sk-late-attach-1161"; // pragma: allowlist secret — synthetic test sentinel
    const sink = new FakeSink();
    let store!: SessionStore;
    let id = "";
    ({ store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("before "));
        emit(delta(secret));
        store.openStream(id, sink);
        emit(delta(" after "));
        emit(delta(secret.slice(0, 8)));
        emit(delta(secret.slice(8)));
        emit(delta(" end"));
        emit(agentEnd(`before ${secret} after ${secret} end`));
      }),
      { apiKey: secret },
    ));

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "before [REDACTED] after [REDACTED] end");
    const streamedDeltas = events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
    assert.equal(streamedDeltas, " after [REDACTED] end");
    assert.ok(!sink.raw.includes(secret));
    assert.equal(terminals(sink)[0].text, "before [REDACTED] after [REDACTED] end");
  });

  it("stops per-delta redaction after the only subscriber detaches mid-turn", async () => {
    const secret = "sk-detach-mid-turn-1161"; // pragma: allowlist secret — synthetic test sentinel
    const realRedact = createApiKeyRedactor(secret);
    let redactCalls = 0;
    const countingRedact = (value: string) => {
      redactCalls++;
      return realRedact(value);
    };

    // Verify holdback stops invoking redact once the sole subscriber detaches.
    const hub = new SessionEventStreams();
    const hubSink = new FakeSink();
    const detachHub = hub.add(hubSink);
    const holdback = new StreamDeltaHoldback(countingRedact, hub, 1);
    let acc = "hello ";
    holdback.pushDelta("hello ", acc, 0);
    detachHub();
    for (let i = 0; i < 20; i++) {
      const chunk = `chunk-${i} `;
      const prevLen = acc.length;
      acc += chunk;
      holdback.pushDelta(chunk, acc, prevLen);
    }
    holdback.flush();
    assert.equal(redactCalls, 1, "expected redact to stop immediately after sole subscriber detaches");

    // End-to-end through SessionStore.prompt(): final response still redacts secret after detach.
    const sink = new FakeSink();
    let detach: (() => void) | undefined;
    const { store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("hello "));
        detach?.();
        for (let i = 0; i < 20; i++) {
          emit(delta(`chunk-${i} `));
        }
        emit(delta(secret));
        emit(agentEnd(`hello ${Array.from({ length: 20 }, (_, i) => `chunk-${i} `).join("")}${secret}`));
      }),
      { apiKey: secret },
    );
    detach = store.openStream(id, sink);

    const result = await store.prompt(id, "hi");

    assert.ok(result.text.endsWith("[REDACTED]"));
    assert.ok(!result.text.includes(secret));
  });

  it("redacts a key split across a late subscriber attach boundary without leaking key tail or pre-attach text", async () => {
    const secret = "sk-split-across-attach-1161"; // pragma: allowlist secret — synthetic test sentinel
    const sink = new FakeSink();
    let store!: SessionStore;
    let id = "";
    ({ store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("pre-attach text "));
        emit(delta(secret.slice(0, 10)));
        store.openStream(id, sink);
        emit(delta(secret.slice(10, 18)));
        emit(delta(secret.slice(18)));
        emit(delta(" post-attach"));
        emit(agentEnd(`pre-attach text ${secret} post-attach`));
      }),
      { apiKey: secret },
    ));

    const result = await store.prompt(id, "hi");

    assert.equal(result.text, "pre-attach text [REDACTED] post-attach");
    const streamedDeltas = events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
    assert.ok(!streamedDeltas.includes(secret.slice(10)), `key suffix leaked across attach boundary: ${streamedDeltas}`);
    assert.ok(!streamedDeltas.includes("pre-attach"), `pre-attach text leaked to late subscriber: ${streamedDeltas}`);
    assert.equal(streamedDeltas, "[REDACTED] post-attach");
    assert.ok(!sink.raw.includes(secret));
  });

  it("drops stale holdback before a new subscriber attaches during a quiet gap", async () => {
    const secret = "sk-reattach-gap-1161"; // pragma: allowlist secret — synthetic test sentinel
    const firstSink = new FakeSink();
    const secondSink = new FakeSink();
    let detachFirst: (() => void) | undefined;
    let store!: SessionStore;
    let id = "";
    ({ store, id } = await createSession(
      scriptedSession((emit) => {
        emit(delta("first-sub-only"));
        detachFirst?.();
        store.openStream(id, secondSink);
        emit(delta(" second-sub-only"));
        emit(agentEnd("first-sub-only second-sub-only"));
      }),
      { apiKey: secret },
    ));
    detachFirst = store.openStream(id, firstSink);

    await store.prompt(id, "hi");

    const secondDeltas = events(secondSink).filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
    assert.ok(!secondDeltas.includes("first-sub-only"), `stale holdback leaked to re-attached subscriber: ${secondDeltas}`);
    assert.equal(secondDeltas, " second-sub-only");
  });
});
