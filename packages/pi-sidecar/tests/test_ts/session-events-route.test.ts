/**
 * `GET /sessions/:id/events` (#1019) driven in-process — the pieces the
 * hub-level suite cannot see: rejections staying plain JSON before any
 * event-stream header, the Origin/Host guard being scoped to this endpoint,
 * and shutdown closing open feeds instead of waiting out the drain timeout.
 *
 * Socket-free (issue #1126): the handler runs against a fake request/response,
 * so nothing binds a port and no request leaves the process. Sessions are
 * fixtures, except in the `POST /sessions` suite, which creates one against an
 * unroutable loopback provider in a temp `models.json` — registration and
 * creation only, never a provider call.
 *
 * The shutdown SEQUENCE is not driven from here: `performShutdown` owns it and
 * `shutdown.test.ts` asserts it with fakes.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SessionStore } from "../../src/sessions.js";
import { isAllowedStreamRequest } from "../../src/index.js";
import { createRequestHandler } from "../../src/request-handler.js";
import { invoke, type InvokeResult, type RequestHandler } from "./helpers/invoke-handler.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

/** Per-session / global feed ceilings (#1019); asserted literally per spec. */
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS_GLOBAL = 32;
/** Fake loopback port for Origin/Host headers — nothing listens on it. */
const LOOPBACK = "127.0.0.1:9201";

type Emit = (event: any) => void;

/** Fixture AgentSession: no SDK, no provider — stream bookkeeping only. */
function fixtureSession() {
  return {
    subscribe: (_onEvent: Emit) => () => {},
    prompt: async () => {},
    dispose: () => {},
    abort: async () => {},
  };
}

/** A rejection must be plain JSON — an event-stream header would have committed SSE. */
function assertPlainJson(response: InvokeResult, status: number): void {
  const contentType = String(response.headers["content-type"] ?? "");
  assert.equal(response.status, status, response.body);
  assert.match(contentType, /application\/json/, `rejection must be JSON, got content-type "${contentType}"`);
  assert.ok(!contentType.includes("text/event-stream"), "no event-stream header may precede a rejection");
  assert.ok(response.json.error, "the rejection carries an error message");
}

describe("GET /sessions/:id/events (#1019) in-process", () => {
  let dir: string;
  let store: SessionStore;
  let handler: RequestHandler;
  const env = {
    offline: process.env.PI_OFFLINE,
    recording: process.env.RECORD_TRANSCRIPTS,
    transcriptsDir: process.env.PI_SIDECAR_TRANSCRIPTS_DIR,
  };

  /** Fixture session, so POST /prompt and DELETE have a real store entry. */
  function addSession(id: string): string {
    store.putSessionFixture(id, fixtureSession(), "/tmp");
    return id;
  }

  before(() => {
    dir = makeTempDir("sidecar-sse-1019-");
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    process.env.PI_OFFLINE = "1";
    delete process.env.RECORD_TRANSCRIPTS;
    store = new SessionStore();
    handler = createRequestHandler({
      store,
      isDraining: () => false,
      getTrustBindHost: () => "127.0.0.1",
      beginRequest: () => {},
      endRequest: () => {},
    });
  });
  after(() => {
    if (env.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = env.offline;
    if (env.recording === undefined) delete process.env.RECORD_TRANSCRIPTS;
    else process.env.RECORD_TRANSCRIPTS = env.recording;
    if (env.transcriptsDir === undefined) delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    else process.env.PI_SIDECAR_TRANSCRIPTS_DIR = env.transcriptsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unknown session with 404 JSON and no event-stream header", async () => {
    const response = await invoke(handler, { method: "GET", url: "/sessions/does-not-exist/events" });
    assertPlainJson(response, 404);
    // The store's own 404, not the catch-all "Not found" of an unregistered route.
    assert.match(response.json.error, /Session does-not-exist not found/);
  });

  it("rejects a foreign Origin or Host on the feed only, leaving /prompt unaffected", async () => {
    // Unknown session: the origin guard runs first, so a 403 proves it fired
    // and a 404 proves it did not.
    const foreignOrigin = await invoke(handler, {
      method: "GET",
      url: "/sessions/does-not-exist/events",
      headers: { origin: "https://evil.example" },
    });
    assertPlainJson(foreignOrigin, 403);

    const foreignHost = await invoke(handler, {
      method: "GET",
      url: "/sessions/does-not-exist/events",
      headers: { host: "evil.example" },
    });
    assertPlainJson(foreignHost, 403);

    const loopbackOrigin = await invoke(handler, {
      method: "GET",
      url: "/sessions/does-not-exist/events",
      headers: { origin: `http://${LOOPBACK}` },
    });
    assert.equal(loopbackOrigin.status, 404, "a same-origin request passes the guard and reaches session lookup");

    // /prompt keeps its old behaviour: the stream guard does not apply to it.
    const sessionId = addSession("prompt-not-guarded");
    const prompt = await invoke(handler, {
      method: "POST",
      url: `/sessions/${sessionId}/prompt`,
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: {},
    });
    assert.equal(prompt.status, 400, `prompt must not be origin-guarded: ${prompt.body}`);
    assert.match(prompt.body, /message is required/);
    await invoke(handler, { method: "DELETE", url: `/sessions/${sessionId}` });
    assert.equal(store.count(), 0);
  });

  it("returns 429 as JSON past the per-session cap and past the global ceiling", async () => {
    const sessions = ["cap-1", "cap-2", "cap-3", "cap-4", "cap-5"].map(addSession);
    const feeds: InvokeResult[] = [];
    try {
      // 4 sessions × 8 = the global ceiling of 32.
      for (const sessionId of sessions.slice(0, 4)) {
        for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) {
          const feed = await invoke(handler, { method: "GET", url: `/sessions/${sessionId}/events` });
          assert.equal(feed.status, 200, "feeds below the ceilings open normally");
          assert.match(String(feed.headers["content-type"] ?? ""), /text\/event-stream/);
          assert.equal(feed.res.ended, 0, "an open feed is not ended");
          feeds.push(feed);
        }
      }

      const overSession = await invoke(handler, { method: "GET", url: `/sessions/${sessions[0]}/events` });
      assertPlainJson(overSession, 429);
      assert.match(overSession.json.error, new RegExp(`max ${MAX_STREAMS_PER_SESSION}`));

      // A session under its own cap is still rejected by the global ceiling.
      const overGlobal = await invoke(handler, { method: "GET", url: `/sessions/${sessions[4]}/events` });
      assertPlainJson(overGlobal, 429);
      assert.match(overGlobal.json.error, new RegExp(`max ${MAX_STREAMS_GLOBAL}`));
    } finally {
      for (const feed of feeds) feed.res.disconnect();
      for (const sessionId of sessions) {
        await invoke(handler, { method: "DELETE", url: `/sessions/${sessionId}` }).catch(() => {});
      }
    }
  });

  it("a live feed outlives the request that opened it and ends with the session", async () => {
    const sessionId = addSession("live-feed");
    const feed = await invoke(handler, { method: "GET", url: `/sessions/${sessionId}/events` });
    try {
      assert.equal(feed.status, 200);
      assert.match(String(feed.headers["content-type"] ?? ""), /text\/event-stream/);
      assert.match(feed.res.body, /"type":"session"/, "the greeting arrives");

      // The GET request is long done as soon as its headers are read. A
      // teardown bound to the request's `close` would drop the feed here; the
      // handler binds it to the RESPONSE, which is still open.
      feed.req.emit("close");
      assert.equal(feed.res.ended, 0, "the response must stay open after its request completes");

      // Only the session going away ends it.
      await invoke(handler, { method: "DELETE", url: `/sessions/${sessionId}` });
      assert.equal(feed.res.ended, 1, "the feed is ended exactly once");
      assert.match(feed.res.body, /"type":"session"/, "the feed carried the greeting before it was closed");
    } finally {
      feed.res.disconnect();
      await invoke(handler, { method: "DELETE", url: `/sessions/${sessionId}` }).catch(() => {});
    }
  });

  it("closing every stream — what shutdown does first — ends each open feed", async () => {
    // Shutdown closes the feeds BEFORE it waits for connections to drain, so an
    // open stream cannot hold the drain to its timeout. That behaviour is
    // store-level: assert it without a socket.
    const sessionId = addSession("shutdown-feed");
    const feeds = [
      await invoke(handler, { method: "GET", url: `/sessions/${sessionId}/events` }),
      await invoke(handler, { method: "GET", url: `/sessions/${sessionId}/events` }),
    ];
    store.closeAllStreams();
    for (const feed of feeds) {
      assert.equal(feed.res.ended, 1, "an open feed is ended by closeAllStreams, not left to the drain");
      feed.res.disconnect();
    }
    await invoke(handler, { method: "DELETE", url: `/sessions/${sessionId}` });
  });
});

describe("POST /sessions in-process (creation covered over HTTP before #1126)", () => {
  const PROVIDER = "sse-1019-provider";
  const MODEL = "sse-1019-model";
  let dir: string;
  /** Where a recording-enabled run would write — must stay empty (off here). */
  let transcripts: string;
  let store: SessionStore;
  let handler: RequestHandler;
  const offline = process.env.PI_OFFLINE;
  const recording = process.env.RECORD_TRANSCRIPTS;
  const transcriptsDir = process.env.PI_SIDECAR_TRANSCRIPTS_DIR;

  before(() => {
    // One offline provider whose baseUrl is unroutable: creation needs a
    // registered model, never a network call.
    dir = makeTempDir("sidecar-sse-1019-create-");
    // Creation writes a transcript header when recording is on: point that at a
    // temp dir and pin recording off, so a developer's env cannot leave files
    // behind in the real archive.
    transcripts = makeTempDir("sidecar-sse-1019-transcripts-");
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = transcripts;
    delete process.env.RECORD_TRANSCRIPTS;
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "sse-1019-test-key", // pragma: allowlist secret — synthetic test credential
            models: [{ id: MODEL, name: "SSE 1019 Model" }],
          },
        },
      }),
    );
    process.env.PI_OFFLINE = "1";
    store = new SessionStore({ agentDir: dir });
    handler = createRequestHandler({
      store,
      isDraining: () => false,
      getTrustBindHost: () => "127.0.0.1",
      beginRequest: () => {},
      endRequest: () => {},
    });
  });
  after(async () => {
    await store.disposeAll();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
    if (recording === undefined) delete process.env.RECORD_TRANSCRIPTS;
    else process.env.RECORD_TRANSCRIPTS = recording;
    if (transcriptsDir === undefined) delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    else process.env.PI_SIDECAR_TRANSCRIPTS_DIR = transcriptsDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(transcripts, { recursive: true, force: true });
  });

  it("creates a session and answers 201 with its session_id", async () => {
    const response = await invoke(handler, {
      method: "POST",
      url: "/sessions",
      headers: { "content-type": "application/json" },
      body: { provider: PROVIDER, model: MODEL, system_prompt: "sse feed test" },
    });
    assert.equal(response.status, 201, `session create failed: ${response.body}`);
    const sessionId = response.json.session_id;
    assert.equal(typeof sessionId, "string");
    assert.ok(sessionId.length > 0, "the created id is usable");
    assert.equal(store.count(), 1, "the session is live in the store");
    assert.deepEqual(
      readdirSync(transcripts),
      [],
      "recording off must write no transcript header (nothing left in the archive)",
    );

    const deleted = await invoke(handler, { method: "DELETE", url: `/sessions/${sessionId}` });
    assert.deepEqual(deleted.json, { deleted: true, existed: true }, "the id addresses a real session");
    assert.equal(store.count(), 0);
    assert.deepEqual(readdirSync(transcripts), [], "deleting the session leaves no transcript behind");
  });
});

describe("isAllowedStreamRequest (#1019)", () => {
  it("accepts a loopback name or an IP literal Host under a wildcard bind", () => {
    for (const bound of ["0.0.0.0", "::", "[::]"]) {
      assert.equal(isAllowedStreamRequest(undefined, "192.168.1.10:9201", bound), true, `LAN IP under ${bound}`);
      assert.equal(isAllowedStreamRequest(undefined, "localhost:9201", bound), true, `loopback Host under ${bound}`);
      assert.equal(isAllowedStreamRequest(undefined, "127.0.0.1:9201", bound), true);
      assert.equal(isAllowedStreamRequest(undefined, "[::1]:9201", bound), true);
      assert.equal(isAllowedStreamRequest("http://127.0.0.1:9201", "127.0.0.1:9201", bound), true);
    }
  });

  it("rejects a hostname Host under a wildcard bind — the rebinding hole", () => {
    for (const bound of ["0.0.0.0", "::", "[::]"])
      for (const origin of [undefined, "http://evil.com:9201"])
        assert.equal(isAllowedStreamRequest(origin, "evil.com:9201", bound), false, `Host evil.com under ${bound}, origin=${origin}`);
  });

  it("still rejects a foreign Origin under a wildcard bind — the rebinding guard", () => {
    assert.equal(isAllowedStreamRequest("https://evil.example", "127.0.0.1:8123", "0.0.0.0"), false);
    assert.equal(isAllowedStreamRequest("null", "127.0.0.1:8123", "0.0.0.0"), false);
    assert.equal(isAllowedStreamRequest("https://evil.example", "192.168.1.10:8123", "0.0.0.0"), false);
    assert.equal(isAllowedStreamRequest(undefined, "", "0.0.0.0"), false, "an unparsable Host still fails closed");
  });

  it("keeps the strict Host rule on a loopback bind", () => {
    assert.equal(isAllowedStreamRequest(undefined, "127.0.0.1:8123", "127.0.0.1"), true);
    assert.equal(isAllowedStreamRequest(undefined, "evil.example", "127.0.0.1"), false);
    assert.equal(isAllowedStreamRequest(undefined, "192.168.1.10:8123", "127.0.0.1"), false);
    assert.equal(isAllowedStreamRequest(undefined, "[::1]:8123", "::1"), true);
  });

  it("keeps the strict Host rule on a specific non-loopback bind", () => {
    assert.equal(isAllowedStreamRequest(undefined, "192.168.1.10:9201", "192.168.1.10"), true);
    assert.equal(isAllowedStreamRequest(undefined, "192.168.1.11:9201", "192.168.1.10"), false);
    assert.equal(isAllowedStreamRequest(undefined, "service.internal:9201", "service.internal"), true);
  });
});
