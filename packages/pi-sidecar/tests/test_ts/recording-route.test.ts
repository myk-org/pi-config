/**
 * Runtime transcript recording toggle (#935): GET/POST /transcripts/recording
 * and POST /transcripts/recording/reset — override + env fallback, without a
 * sidecar restart.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSidecar } from "../../src/index.js";

/** Find a free loopback port by briefly occupying it (providers-discovery pattern). */
async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("/transcripts/recording routes (#935)", () => {
  let port: number;
  let sidecar: ReturnType<typeof startSidecar>;
  let dir: string;
  const envRecording = process.env.RECORD_TRANSCRIPTS;
  const envTranscriptsDir = process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
  const offline = process.env.PI_OFFLINE;

  before(async () => {
    // Point transcripts at a temp dir so a stray enabled state cannot write
    // into the developer's real transcript directory.
    dir = mkdtempSync(join(tmpdir(), "sidecar-recording-route-"));
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    delete process.env.RECORD_TRANSCRIPTS;
    process.env.PI_OFFLINE = "1";
    port = await freePort();
    sidecar = startSidecar({ port, host: "127.0.0.1" });
    await sidecar.ready;
  });
  after(async () => {
    await sidecar?.close();
    if (envRecording === undefined) delete process.env.RECORD_TRANSCRIPTS;
    else process.env.RECORD_TRANSCRIPTS = envRecording;
    if (envTranscriptsDir === undefined) delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    else process.env.PI_SIDECAR_TRANSCRIPTS_DIR = envTranscriptsDir;
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET returns the env default when no override is set", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/transcripts/recording`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, source: "env" });
  });

  it("POST sets the override and reports it", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/transcripts/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: true, source: "override" });

    // The state is visible to a subsequent GET — no restart involved.
    const get = await fetch(`http://127.0.0.1:${port}/transcripts/recording`);
    assert.deepEqual(await get.json(), { enabled: true, source: "override" });
  });

  it("POST rejects a non-boolean enabled with 400", async () => {
    for (const body of ["{}", "{\"enabled\": \"yes\"}", "{\"enabled\": 1}", "[]", "null"]) {
      const response = await fetch(`http://127.0.0.1:${port}/transcripts/recording`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 400, `body ${body} must 400`);
      const parsed = await response.json() as { error: string };
      assert.ok(parsed.error, "error message present");
    }
  });

  it("POST /reset drops the override and restores the env default", async () => {
    const set = await fetch(`http://127.0.0.1:${port}/transcripts/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.deepEqual(await set.json(), { enabled: false, source: "override" });

    const reset = await fetch(`http://127.0.0.1:${port}/transcripts/recording/reset`, { method: "POST" });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { enabled: false, source: "env" });

    // Resetting with no override set is still 200 (idempotent).
    const again = await fetch(`http://127.0.0.1:${port}/transcripts/recording/reset`, { method: "POST" });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { enabled: false, source: "env" });
  });

  it("GET with a query string is not the fixed route (exact-match contract, like /health)", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/transcripts/recording?verbose=1`);
    assert.equal(response.status, 404);
  });
});
