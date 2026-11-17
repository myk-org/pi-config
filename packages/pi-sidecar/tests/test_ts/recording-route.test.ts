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
import { invoke } from "./helpers/invoke-handler.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

describe("/transcripts/recording routes (#935)", () => {
  let dir: string;
  let store: SessionStore;
  let handler: ReturnType<typeof createRequestHandler>;
  let activeRequests: number;
  let draining: boolean;
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
    draining = false;
    const deps: RequestHandlerDeps = {
      store,
      isDraining: () => draining,
      getTrustBindHost: () => "127.0.0.1",
      beginRequest: () => { activeRequests++; },
      endRequest: () => { activeRequests--; },
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

  it("GET returns the env default when no override is set", async () => {
    const response = await invoke(handler, { method: "GET", url: "/transcripts/recording" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { enabled: false, source: "env" });
  });

  it("POST sets the override and reports it", async () => {
    const response = await invoke(handler, {
      method: "POST",
      url: "/transcripts/recording",
      headers: { "content-type": "application/json" },
      body: { enabled: true },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { enabled: true, source: "override" });
  });

  it("GET reflects an override set by a previous POST — no restart involved", async () => {
    const get = await invoke(handler, { method: "GET", url: "/transcripts/recording" });
    assert.deepEqual(get.json, { enabled: true, source: "override" });
  });

  it("POST rejects a non-boolean enabled with 400", async () => {
    for (const body of ["{}", "{\"enabled\": \"yes\"}", "{\"enabled\": 1}", "[]", "null"]) {
      const response = await invoke(handler, {
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
    const set = await invoke(handler, {
      method: "POST",
      url: "/transcripts/recording",
      headers: { "content-type": "application/json" },
      body: { enabled: false },
    });
    assert.deepEqual(set.json, { enabled: false, source: "override" });

    const reset = await invoke(handler, { method: "POST", url: "/transcripts/recording/reset" });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.json, { enabled: false, source: "env" });
  });

  it("POST /reset with no override set is idempotent", async () => {
    const again = await invoke(handler, { method: "POST", url: "/transcripts/recording/reset" });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { enabled: false, source: "env" });
  });

  it("GET with a query string is not the fixed route (exact-match contract, like /health)", async () => {
    const response = await invoke(handler, { method: "GET", url: "/transcripts/recording?verbose=1" });
    assert.equal(response.status, 404);
  });

  it("counts every request in flight exactly once (shutdown drain accounting)", () => {
    assert.equal(activeRequests, 0, "every handler exit path balances beginRequest/endRequest");
  });

  it("rejects new requests once the deps flag turns to draining — the flag is read live, not captured", async () => {
    draining = true;
    try {
      const rejected = await invoke(handler, { method: "GET", url: "/transcripts/recording" });
      assert.equal(rejected.status, 503);
      assert.deepEqual(rejected.json, { error: "Server is shutting down" });
      assert.equal(activeRequests, 0, "a rejected request never counts as in flight");
    } finally {
      draining = false;
    }
  });
});
