/**
 * Per-session SSE turn feed (#1019) — `GET /sessions/:id/events`.
 *
 * Hub-level tests: every frame is asserted through a fake transport sink, so a
 * subscriber's fate is never confused with the prompt path that produced the
 * event. Session behaviour is driven by fixture sessions (no provider calls).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { SessionStore, createApiKeyRedactor } from "../../src/sessions.js";
import type { SessionStreamSink } from "../../src/sessions.js";
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

/** Fixture AgentSession: `script` runs inside prompt(), after subscribe registered. */
function fixtureSession(script: (emit: Emit) => Promise<void> | void, extra: {
  abort?: () => Promise<void>;
  dispose?: () => void;
} = {}) {
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
function textSession() {
  return fixtureSession((emit) => {
    emit(delta("Hello"));
    emit(delta(" world"));
    emit(agentEnd("Hello world"));
  });
}

describe("session event stream: delta delivery (#1019)", () => {
  it("delivers every text_delta in emit order, then exactly one turn_end", async () => {
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture(
      "s",
      fixtureSession((emit) => {
        emit(delta("one-"));
        emit(delta("two-"));
        emit(delta("three"));
        emit(agentEnd("one-two-three"));
      }),
      "/tmp",
    );
    store.openStream("s", sink);

    const result = await store.prompt("s", "hi");

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
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture(
      "s",
      fixtureSession((emit) => {
        emit(delta("partial"));
        emit({ type: "error", error: "provider exploded" });
        emit(agentEnd("partial"));
      }),
      "/tmp",
    );
    store.openStream("s", sink);

    const result = await store.prompt("s", "hi");

    const terminal = terminals(sink);
    assert.equal(terminal.length, 1, "a turn must never emit both turn_end and error");
    assert.equal(terminal[0].type, "error", "the collected error is the terminal event for this turn");
    assert.match(terminal[0].message, /provider exploded/);
    assert.match(result.error ?? "", /provider exploded/);
    assert.equal(events(sink).filter((event) => event.type === "turn_end").length, 0);
  });

  it("fires the terminal event with recording disabled (the default config)", async () => {
    const store = new SessionStore();
    assert.equal(store.isRecordingEnabled(), false, "this test must run on the default config");
    const sink = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", sink);

    await store.prompt("s", "hi");

    // Regression: an anchor emitted from inside the recordTurn gate never runs
    // here, so a recording-gated implementation produces no terminal event.
    assert.equal(store.isRecordingEnabled(), false);
    assert.equal(terminals(sink).length, 1, "the terminal event must not depend on transcript recording");
    assert.equal(terminals(sink)[0].type, "turn_end");
  });

  it("a zero-delta turn still emits turn_end carrying the fallback text", async () => {
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture(
      "s",
      fixtureSession((emit) => {
        // Tool-only / provider-without-deltas turn: text only exists on agent_end.
        emit(agentEnd("fallback text"));
      }),
      "/tmp",
    );
    store.openStream("s", sink);

    const result = await store.prompt("s", "hi");

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
    const store = new SessionStore();
    const sink = new FakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let promptCalls = 0;
    store.putSessionFixture(
      "s",
      fixtureSession(
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
      "/tmp",
    );
    store.openStream("s", sink);

    const pending = store.prompt("s", "hi");
    while (events(sink).filter((event) => event.type === "text_delta").length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await store.abort("s");
    const first = await pending;

    const firstTerminal = terminals(sink);
    assert.equal(firstTerminal.length, 1, "an aborted turn emits exactly one terminal event");
    assert.equal(firstTerminal[0].type, "turn_end", "abort wins over the collected error");
    assert.equal(firstTerminal[0].aborted, true);
    assert.equal(firstTerminal[0].text, "partial answer", "the aborted turn_end carries the partial text");
    assert.equal(first.text, "partial answer");

    const second = await store.prompt("s", "again");

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
    const store = new SessionStore();
    const sink = new FakeSink();
    let sdkAborts = 0;
    store.putSessionFixture(
      "s",
      fixtureSession(
        (emit) => {
          emit(delta("Hello"));
          emit(agentEnd("Hello"));
        },
        { abort: async () => { sdkAborts++; } },
      ),
      "/tmp",
    );
    store.openStream("s", sink);

    await store.abort("s");
    assert.equal(sdkAborts, 0, "an idle session has nothing to abort");

    const result = await store.prompt("s", "hi");

    assert.equal(result.text, "Hello");
    const terminal = terminals(sink);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].aborted, false, "a stale abort must not leak into the next turn");
  });

  it("a failed abort does not label the still-running turn aborted", async () => {
    const store = new SessionStore();
    const sink = new FakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.putSessionFixture(
      "s",
      fixtureSession(
        async (emit) => {
          emit(delta("Hello"));
          await gate; // the turn keeps running after the abort request fails
          emit(agentEnd("Hello"));
        },
        { abort: async () => { throw new Error("abort exploded"); } },
      ),
      "/tmp",
    );
    store.openStream("s", sink);

    const pending = store.prompt("s", "hi");
    while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(store.abort("s"), /abort exploded/);
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
      const store = new SessionStore();
      const sink = new FakeSink();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = [deferred(), deferred()];
      let call = 0;
      store.putSessionFixture(
        "s",
        fixtureSession(
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
        "/tmp",
      );
      store.openStream("s", sink);

      const pending = store.prompt("s", "hi");
      while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const aborts = [store.abort("s"), store.abort("s")];

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
    const store = new SessionStore();
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
    store.putSessionFixture(
      "s",
      fixtureSession(
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
      "/tmp",
    );
    store.openStream("s", sink);

    const firstTurn = store.prompt("s", "first");
    while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const staleAbort = store.abort("s").then(() => "ok", (err: Error) => err.message);
    gateA.resolve(); // turn A ends while its abort is still pending
    await firstTurn;

    const secondTurn = store.prompt("s", "second");
    while (events(sink).filter((event) => event.type === "text_delta").length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Turn B's cancellation is requested but still pending when turn A's abort
    // rejects — the window where a re-read of entry.abortState would decrement
    // turn B's pending count and clear its request.
    const liveAbort = store.abort("s");
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
    const store = new SessionStore();
    const sink = new FakeSink();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.putSessionFixture(
      "s",
      fixtureSession(async (emit) => {
        emit(delta("Hello"));
        await gate;
        emit(agentEnd("Hello"));
      }),
      "/tmp",
    );
    store.openStream("s", sink);

    const pending = store.prompt("s", "first");
    while (events(sink).filter((event) => event.type === "text_delta").length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(store.prompt("s", "second"), /busy|concurrent/i);
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
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture("quiet", textSession(), "/tmp");
    store.putSessionFixture("watched", textSession(), "/tmp");
    store.openStream("watched", sink);

    const quiet = await store.prompt("quiet", "hi");
    const watched = await store.prompt("watched", "hi");

    assert.deepEqual(Object.keys(quiet), ["text", "usage"], "the response object is unchanged by #1019");
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
    const store = new SessionStore();
    const thrower = new FakeSink();
    thrower.failWith = new Error("socket hang up");
    const survivor = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", thrower);
    store.openStream("s", survivor);

    const result = await store.prompt("s", "hi");

    assert.equal(result.text, "Hello world", "a dead sink must never surface into the prompt result");
    assert.equal(result.error, undefined);
    assert.equal(thrower.ended, 1, "the throwing subscriber is dropped");
    assert.equal(events(thrower).length, 0);
    assert.equal(survivor.ended, 0, "the healthy subscriber is untouched");
    assert.deepEqual(
      events(survivor).map((event) => event.type),
      ["session", "turn_start", "text_delta", "text_delta", "turn_end"],
    );

    await store.prompt("s", "again");

    assert.equal(thrower.ended, 1, "a dropped subscriber is not written to or ended twice");
    assert.equal(terminals(survivor).length, 2, "the surviving subscriber keeps receiving later turns");
  });

  it("a second subscriber gets its own session frame and does not disturb the first", async () => {
    const store = new SessionStore();
    const first = new FakeSink();
    const second = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", first);
    const before = first.raw;

    store.openStream("s", second);

    assert.equal(events(second).filter((event) => event.type === "session").length, 1, "the newcomer is greeted");
    assert.equal(first.raw, before, "an open feed gets no duplicate session frame and no idle reset");

    await store.prompt("s", "hi");
    for (const sink of [first, second]) {
      assert.equal(events(sink).filter((event) => event.type === "session").length, 1);
      assert.equal(terminals(sink).length, 1, "both subscribers see the turn end");
    }
  });

  it("a slow subscriber over the 1 MB budget is evicted alone", async () => {
    const store = new SessionStore();
    const slow = new FakeSink();
    slow.pendingBytes = MAX_PENDING_BYTES + 1;
    const fast = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", slow);
    store.openStream("s", fast);

    const result = await store.prompt("s", "hi");

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
    store.putSessionFixture("edge", textSession(), "/tmp");
    store.openStream("edge", edge);
    await store.prompt("edge", "hi");
    assert.equal(edge.ended, 0, "a subscriber at exactly the budget is kept");
    assert.equal(terminals(edge).length, 1);
  });

  it("detaching on close leaves the hub empty with no lingering timers", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const store = new SessionStore();
    const first = new FakeSink();
    const second = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");

    const detachFirst = store.openStream("s", first);
    const detachSecond = store.openStream("s", second);
    assert.equal(comments(first).length, 0);

    detachFirst();
    detachSecond();

    assert.equal(first.ended, 1);
    assert.equal(second.ended, 1);
    const hub = (store as any).sessions.get("s").streams;
    assert.equal(hub.size, 0, "subscriber count must return to zero");

    // A cleared keepalive/idle timer must not fire after detach.
    t.mock.timers.tick(IDLE_MS + KEEPALIVE_MS * 4);
    assert.equal(comments(first).length + comments(second).length, 0, "detached subscribers receive nothing");
    assert.equal(first.ended, 1, "a detached subscriber is not ended twice");
    assert.equal(second.ended, 1);
  });

  it("detach is idempotent — a teardown that fires twice closes the sink once", () => {
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    const detach = store.openStream("s", sink);

    detach();
    detach();
    // Request and response teardown can both land (a retried or raced close).
    assert.equal(sink.ended, 1, "the sink is ended exactly once");
    assert.equal((store as any).sessions.get("s").streams.size, 0);
    assert.doesNotThrow(() => detach());
  });
});

describe("session event stream: redaction and framing (#1019)", () => {
  it("a delta echoing the session api_key arrives redacted in the frame", async () => {
    const secret = "sk-live-1019-fixture-secret"; // pragma: allowlist secret — synthetic test sentinel
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture(
      "s",
      fixtureSession((emit) => {
        emit(delta(`key is ${secret}`));
        emit(agentEnd(`key is ${secret}`));
      }),
      "/tmp",
    );
    (store as any).sessions.get("s").redact = createApiKeyRedactor(secret);
    store.openStream("s", sink);

    const result = await store.prompt("s", "hi");

    const [deltaEvent] = events(sink).filter((event) => event.type === "text_delta");
    assert.equal(deltaEvent.delta, "key is [REDACTED]");
    assert.ok(!sink.raw.includes(secret), "the raw frame must not carry the key");
    assert.equal(terminals(sink)[0].text, "key is [REDACTED]");
    assert.ok(!result.text.includes(secret));
  });

  it("a delta containing an SSE frame cannot inject a second event", async () => {
    const store = new SessionStore();
    const sink = new FakeSink();
    const injected = '\n\ndata: {"x":1}';
    store.putSessionFixture(
      "s",
      fixtureSession((emit) => {
        emit(delta(injected));
        emit(agentEnd(injected));
      }),
      "/tmp",
    );
    store.openStream("s", sink);

    await store.prompt("s", "hi");

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
  function splitSession(parts: string[]) {
    return fixtureSession((emit) => {
      for (const part of parts) emit(delta(part));
      emit(agentEnd(parts.join("")));
    });
  }

  it("a key split across a delta boundary never appears in any frame, at any split point", async () => {
    const before = "the key is ";
    // Every split point, so a fix that merely widens the buffer fails on some.
    for (let cut = 1; cut < KEY.length; cut++) {
      const store = new SessionStore();
      const sink = new FakeSink();
      store.putSessionFixture("s", splitSession([before, KEY.slice(0, cut), KEY.slice(cut), " done"]), "/tmp");
      (store as any).sessions.get("s").redact = createApiKeyRedactor(KEY);
      store.openStream("s", sink);

      const result = await store.prompt("s", "hi");

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
        const store = new SessionStore();
        const sink = new FakeSink();
        store.putSessionFixture(
          "s",
          splitSession([`echo ${form.slice(0, cut)}`, `${form.slice(cut)} done`]),
          "/tmp",
        );
        (store as any).sessions.get("s").redact = createApiKeyRedactor(KEY);
        store.openStream("s", sink);

        const result = await store.prompt("s", "hi");

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
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", sink);

    await store.prompt("s", "hi");

    // A key-free redactor needs no window: deltas go out as they arrive.
    assert.deepEqual(
      events(sink).filter((event) => event.type === "text_delta").map((event) => event.delta),
      ["Hello", " world"],
    );
  });
});

describe("session event stream: keepalive and idle reaping (#1019)", () => {
  it("sends a keepalive comment while the feed is idle", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", sink);

    t.mock.timers.tick(KEEPALIVE_MS - 1);
    assert.equal(comments(sink).length, 0, "no keepalive before the interval elapses");
    t.mock.timers.tick(1);
    assert.deepEqual(comments(sink), [": keepalive"]);
    assert.match(sink.raw, /: keepalive\n\n$/, "keepalives are SSE comments, not events");
    assert.equal(events(sink).length, 1, "a keepalive adds no event");
  });

  it("reaps a subscribe-only client on the idle timeout despite its keepalives", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const store = new SessionStore();
    const sink = new FakeSink();
    store.putSessionFixture("s", textSession(), "/tmp");
    store.openStream("s", sink);

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
  it("DELETE, cleanupStale and disposeAll all end that session's streams", async () => {
    const store = new SessionStore();

    store.putSessionFixture("deleted", textSession(), "/tmp");
    const deleted = new FakeSink();
    store.openStream("deleted", deleted);
    assert.equal(store.delete("deleted"), true);
    assert.equal(deleted.ended, 1, "DELETE /sessions/:id ends the feed");

    store.putSessionFixture("stale", textSession(), "/tmp");
    const stale = new FakeSink();
    store.openStream("stale", stale);
    (store as any).sessions.get("stale").lastActivity = Date.now() - 60_000;
    assert.equal(store.cleanupStale(1_000), 1);
    assert.equal(stale.ended, 1, "cleanupStale ends the feed of the session it removes");

    store.putSessionFixture("disposed", textSession(), "/tmp");
    const disposed = new FakeSink();
    store.openStream("disposed", disposed);
    await store.disposeAll();
    assert.equal(disposed.ended, 1, "disposeAll ends the feed");
  });

  it("enforces the per-session stream ceiling and rejects unknown sessions", () => {
    const store = new SessionStore();
    store.putSessionFixture("s", textSession(), "/tmp");
    const sinks: FakeSink[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) {
      const sink = new FakeSink();
      sinks.push(sink);
      store.openStream("s", sink);
    }
    assert.equal((store as any).sessions.get("s").streams.size, MAX_STREAMS_PER_SESSION);

    assert.throws(
      () => store.assertStreamAllowed("s"),
      (err: any) => err.statusCode === 429 && /max 8/.test(err.message),
      "the 9th subscriber on one session is rejected with 429",
    );
    assert.throws(
      () => store.openStream("s", new FakeSink()),
      (err: any) => err.statusCode === 429,
      "openStream re-checks the ceiling",
    );
    assert.throws(
      () => store.assertStreamAllowed("missing"),
      (err: any) => err.statusCode === 404,
      "an unknown session is a 404",
    );
  });

  it("enforces the process-wide stream ceiling across sessions", () => {
    const store = new SessionStore();
    const ids: string[] = [];
    for (let session = 0; session < 5; session++) {
      const id = `s${session}`;
      ids.push(id);
      store.putSessionFixture(id, textSession(), "/tmp");
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
