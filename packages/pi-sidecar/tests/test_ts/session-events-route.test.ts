/**
 * `GET /sessions/:id/events` (#1019) over real HTTP — the pieces the hub-level
 * suite cannot see: rejections staying plain JSON before any event-stream
 * header, the Origin/Host guard being scoped to this endpoint, and shutdown
 * closing open feeds instead of waiting out the drain timeout.
 *
 * Sessions are created against an offline models.json provider (unroutable
 * loopback baseUrl) — no provider call is ever made.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startSidecar, isAllowedStreamRequest } from "../../src/index.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

const PROVIDER = "sse-1019-provider";
const MODEL = "sse-1019-model";
/** Per-session / global feed ceilings (#1019); asserted literally per spec. */
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS_GLOBAL = 32;
/** Shutdown drain timeout the feed must not have to wait out. */
const DRAIN_TIMEOUT_MS = 30_000;

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

/** Agent dir with one offline provider so POST /sessions succeeds without a network call. */
function writeOfflineAgentDir(): string {
  const dir = makeTempDir("sidecar-sse-1019-");
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
  return dir;
}

async function createSession(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: PROVIDER, model: MODEL, system_prompt: "sse feed test" }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, `session create failed: ${body}`);
  return JSON.parse(body).session_id as string;
}

interface OpenFeed {
  response: Response;
  abort: () => void;
}

/** Open a feed and keep it open (body unread) until abort() is called. */
async function openFeed(port: number, sessionId: string, headers: Record<string, string> = {}): Promise<OpenFeed> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/events`, {
    signal: controller.signal,
    headers,
  });
  return { response, abort: () => controller.abort() };
}

/** Raw HTTP GET so the Host header can be forged (fetch forbids it). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers["content-type"] ?? ""),
        body,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A rejection must be plain JSON — an event-stream header would have committed SSE. */
function assertPlainJson(response: Response, status: number, body: string): void {
  const contentType = response.headers.get("content-type") ?? "";
  assert.equal(response.status, status, body);
  assert.match(contentType, /application\/json/, `rejection must be JSON, got content-type "${contentType}"`);
  assert.ok(!contentType.includes("text/event-stream"), "no event-stream header may precede a rejection");
  assert.ok(JSON.parse(body).error, "the rejection carries an error message");
}

describe("GET /sessions/:id/events (#1019) over HTTP", () => {
  let agentDir: string;
  let port: number;
  let sidecar: ReturnType<typeof startSidecar>;
  const env = {
    offline: process.env.PI_OFFLINE,
    recording: process.env.RECORD_TRANSCRIPTS,
  };

  before(async () => {
    agentDir = writeOfflineAgentDir();
    process.env.PI_OFFLINE = "1";
    delete process.env.RECORD_TRANSCRIPTS;
    port = await freePort();
    sidecar = startSidecar({ port, host: "127.0.0.1", agentDir });
    await sidecar.ready;
  });
  after(async () => {
    await sidecar?.close();
    if (env.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = env.offline;
    if (env.recording === undefined) delete process.env.RECORD_TRANSCRIPTS;
    else process.env.RECORD_TRANSCRIPTS = env.recording;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("rejects an unknown session with 404 JSON and no event-stream header", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/does-not-exist/events`);
    const body = await response.text();
    assertPlainJson(response, 404, body);
    // The store's own 404, not the catch-all "Not found" of an unregistered route.
    assert.match(JSON.parse(body).error, /Session does-not-exist not found/);
  });

  it("rejects a foreign Origin or Host on the feed only, leaving /prompt unaffected", async () => {
    // Unknown session: the origin guard runs first, so a 403 proves it fired
    // and a 404 proves it did not.
    const foreignOrigin = await fetch(`http://127.0.0.1:${port}/sessions/does-not-exist/events`, {
      headers: { origin: "https://evil.example" },
    });
    assertPlainJson(foreignOrigin, 403, await foreignOrigin.text());

    const foreignHost = await rawGet(port, "/sessions/does-not-exist/events", { host: "evil.example" });
    assert.equal(foreignHost.status, 403, foreignHost.body);
    assert.match(foreignHost.contentType, /application\/json/);
    assert.ok(!foreignHost.contentType.includes("text/event-stream"));

    const loopbackOrigin = await fetch(`http://127.0.0.1:${port}/sessions/does-not-exist/events`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(loopbackOrigin.status, 404, "a same-origin request passes the guard and reaches session lookup");
    await loopbackOrigin.text();

    // /prompt keeps its old behaviour: the stream guard does not apply to it.
    const sessionId = await createSession(port);
    const prompt = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({}),
    });
    const promptBody = await prompt.text();
    assert.equal(prompt.status, 400, `prompt must not be origin-guarded: ${promptBody}`);
    assert.match(promptBody, /message is required/);
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}`, { method: "DELETE" });
  });

  it("returns 429 as JSON past the per-session cap and past the global ceiling", async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 5; i++) sessions.push(await createSession(port));
    const feeds: OpenFeed[] = [];
    try {
      // 4 sessions × 8 = the global ceiling of 32.
      for (const sessionId of sessions.slice(0, 4)) {
        for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) {
          const feed = await openFeed(port, sessionId);
          assert.equal(feed.response.status, 200, "feeds below the ceilings open normally");
          assert.match(feed.response.headers.get("content-type") ?? "", /text\/event-stream/);
          feeds.push(feed);
        }
      }

      const overSession = await fetch(`http://127.0.0.1:${port}/sessions/${sessions[0]}/events`);
      const overSessionBody = await overSession.text();
      assertPlainJson(overSession, 429, overSessionBody);
      assert.match(JSON.parse(overSessionBody).error, new RegExp(`max ${MAX_STREAMS_PER_SESSION}`));

      // A session under its own cap is still rejected by the global ceiling.
      const overGlobal = await fetch(`http://127.0.0.1:${port}/sessions/${sessions[4]}/events`);
      const overGlobalBody = await overGlobal.text();
      assertPlainJson(overGlobal, 429, overGlobalBody);
      assert.match(JSON.parse(overGlobalBody).error, new RegExp(`max ${MAX_STREAMS_GLOBAL}`));
    } finally {
      for (const feed of feeds) feed.abort();
      for (const sessionId of sessions) {
        await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    }
  });

  it("a live feed outlives the request that opened it and ends with the session", async () => {
    const sessionId = await createSession(port);
    // Raw GET: `req` and `res` are separate objects here, which is the point —
    // a teardown bound to the request's `close` drops the feed as soon as the
    // GET is read, while the response is still open.
    const feed = await new Promise<{ res: IncomingMessage; close: () => void }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: `/sessions/${sessionId}/events`, method: "GET" }, (res) => {
        res.setEncoding("utf8");
        resolve({ res, close: () => req.destroy() });
      });
      req.on("error", reject);
      req.end();
    });
    try {
      let ended = false;
      let body = "";
      feed.res.on("data", (chunk: string) => { body += chunk; });
      feed.res.on("end", () => { ended = true; });
      while (!body.includes("\n\n")) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(body, /"type":"session"/, "the greeting arrives");

      // The GET request is long done; a feed torn down on req `close` is gone by now.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(ended, false, "the response must stay open after its request completes");

      // Only the session going away ends it.
      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}`, { method: "DELETE" });
      while (!ended) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(body, /"type":"session"/, "the feed carried the greeting before it was closed");
    } finally {
      feed.close();
      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
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

describe("shutdown with an open feed (#1019)", () => {
  it("completes promptly instead of waiting out the drain timeout", async () => {
    const offline = process.env.PI_OFFLINE;
    const agentDir = writeOfflineAgentDir();
    process.env.PI_OFFLINE = "1";
    const port = await freePort();
    const sidecar = startSidecar({ port, host: "127.0.0.1", agentDir });
    let controller: AbortController | undefined;
    try {
      await sidecar.ready;
      const sessionId = await createSession(port);
      controller = new AbortController();
      const feed = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/events`, { signal: controller.signal });
      assert.equal(feed.status, 200);
      assert.match(feed.headers.get("content-type") ?? "", /text\/event-stream/);

      const started = Date.now();
      await sidecar.close();
      const elapsed = Date.now() - started;

      assert.ok(
        elapsed < DRAIN_TIMEOUT_MS / 3,
        `shutdown must close the open feed instead of waiting out the ${DRAIN_TIMEOUT_MS}ms drain (took ${elapsed}ms)`,
      );
    } finally {
      controller?.abort();
      // Always shut down: a failed assertion above must not leave the server
      // (and this test process) waiting on an open socket.
      await sidecar.close().catch(() => {});
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
