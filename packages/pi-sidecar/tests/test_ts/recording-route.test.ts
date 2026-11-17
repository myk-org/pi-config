/**
 * Runtime transcript recording toggle (#935): GET/POST /transcripts/recording
 * and POST /transcripts/recording/reset — override + env fallback, without a
 * sidecar restart.
 *
 * Drives the handler in-process (issue #1126): no socket, no port, no fetch.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { SessionStore } from "../../src/sessions.js";
import { createRequestHandler, type RequestHandlerDeps } from "../../src/request-handler.js";
import { invoke, type InvokeOptions } from "./helpers/invoke-handler.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

/**
 * Flake evidence for #1126, recorded at the deleted freePort() helper's site.
 *
 * Observed: `POST rejects a non-boolean enabled with 400` failed with
 * ECONNRESET after ~8.5 s — twice inside `prek run --all-files`, on a diff that
 * touched neither pi-sidecar nor extensions/shared. It passed standalone (7/7),
 * passed in the full sidecar suite, and passed on retry with no code change.
 *
 * Unconfirmed hypothesis: the old helper bound :0, read the port, closed the
 * socket, and the sidecar bound that same port later in before(), so another
 * parallel process could take it in between and the client could hit a closing
 * socket. The root cause is NOT proven, and passing afterwards does not prove
 * it — the retry is consistent with the hypothesis, not evidence for it.
 *
 * Why it cannot recur here: this suite allocates no port at all — it builds the
 * handler in-process and drives it through invoke(...) — so the failure-mode
 * class is gone regardless of which interleaving triggered the original flake.
 */
describe("/transcripts/recording routes (#935)", () => {
  let dir: string;
  let store: SessionStore;
  let handler: ReturnType<typeof createRequestHandler>;
  let activeRequests: number;
  let draining: boolean;
  /** Handler invocations the test itself made, and what the deps saw. */
  let requests: number;
  let began: number;
  let ended: number;
  const envRecording = process.env.RECORD_TRANSCRIPTS;
  const envTranscriptsDir = process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
  const offline = process.env.PI_OFFLINE;

  before(() => {
    // Point transcripts at a temp dir so a stray enabled state cannot write
    // into the developer's real transcript directory.
    dir = makeTempDir("sidecar-recording-route-");
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    delete process.env.RECORD_TRANSCRIPTS;
    process.env.PI_OFFLINE = "1";
    store = new SessionStore();
    activeRequests = 0;
    requests = 0;
    began = 0;
    ended = 0;
    draining = false;
    const deps: RequestHandlerDeps = {
      store,
      isDraining: () => draining,
      getTrustBindHost: () => "127.0.0.1",
      beginRequest: () => { activeRequests++; began++; },
      endRequest: () => { activeRequests--; ended++; },
    };
    handler = createRequestHandler(deps);
  });
  after(() => {
    if (envRecording === undefined) delete process.env.RECORD_TRANSCRIPTS;
    else process.env.RECORD_TRANSCRIPTS = envRecording;
    if (envTranscriptsDir === undefined) delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    else process.env.PI_SIDECAR_TRANSCRIPTS_DIR = envTranscriptsDir;
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Counted invocation: the drain accounting is only meaningful if the deps saw every request. */
  function request(options: InvokeOptions) {
    requests++;
    return invoke(handler, options);
  }

  it("GET returns the env default when no override is set", async () => {
    const response = await request({ method: "GET", url: "/transcripts/recording" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { enabled: false, source: "env" });
  });

  it("POST sets the override and reports it", async () => {
    const response = await request({
      method: "POST",
      url: "/transcripts/recording",
      headers: { "content-type": "application/json" },
      body: { enabled: true },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { enabled: true, source: "override" });
  });

  it("GET reflects an override set by a previous POST — no restart involved", async () => {
    const get = await request({ method: "GET", url: "/transcripts/recording" });
    assert.deepEqual(get.json, { enabled: true, source: "override" });
  });

  it("POST rejects a non-boolean enabled with 400", async () => {
    for (const body of ["{}", "{\"enabled\": \"yes\"}", "{\"enabled\": 1}", "[]", "null"]) {
      const response = await request({
        method: "POST",
        url: "/transcripts/recording",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 400, `body ${body} must 400`);
      assert.ok(response.json.error, "error message present");
    }
  });

  it("POST /reset drops the override and restores the env default", async () => {
    const set = await request({
      method: "POST",
      url: "/transcripts/recording",
      headers: { "content-type": "application/json" },
      body: { enabled: false },
    });
    assert.deepEqual(set.json, { enabled: false, source: "override" });

    const reset = await request({ method: "POST", url: "/transcripts/recording/reset" });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.json, { enabled: false, source: "env" });
  });

  it("POST /reset with no override set is idempotent", async () => {
    const again = await request({ method: "POST", url: "/transcripts/recording/reset" });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { enabled: false, source: "env" });
  });

  it("GET with a query string is not the fixed route (exact-match contract, like /health)", async () => {
    const response = await request({ method: "GET", url: "/transcripts/recording?verbose=1" });
    assert.equal(response.status, 404);
  });

  it("counts every request in flight exactly once (shutdown drain accounting)", async () => {
    // A request that throws (unknown session — a store lookup, no provider call)
    // must still balance: the pair lives in beginRequest/try/finally.
    const failed = await request({
      method: "POST",
      url: "/sessions/no-such-session/prompt",
      headers: { "content-type": "application/json" },
      body: { message: "ignored" },
    });
    assert.equal(failed.status, 404, failed.body);

    assert.ok(requests > 0, "the suite actually drove the handler");
    assert.equal(began, requests, "every request passed the draining gate and counted itself in flight");
    assert.equal(ended, requests, "every handler exit path — including the throw — counted itself out");
    assert.equal(activeRequests, 0, "nothing is left in flight");
  });

  it("rejects new requests once the deps flag turns to draining — the flag is read live, not captured", async () => {
    draining = true;
    try {
      const rejected = await request({ method: "GET", url: "/transcripts/recording" });
      assert.equal(rejected.status, 503);
      assert.deepEqual(rejected.json, { error: "Server is shutting down" });
      assert.equal(activeRequests, 0, "a rejected request never counts as in flight");
      // A rejected request is not "in flight", so beginRequest must not fire.
      assert.equal(began, requests - 1, "the draining gate returns before beginRequest");
      assert.equal(ended, requests - 1);
    } finally {
      draining = false;
    }
  });
});
