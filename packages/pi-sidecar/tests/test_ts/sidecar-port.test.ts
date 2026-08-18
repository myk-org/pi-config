import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { bindSidecarListenExit, startSidecar } from "../../src/index.js";
import type { SidecarStopResult } from "../../src/index.js";
import {
  ensureSidecarPortEnv,
  resolveSidecarListenPort,
} from "../../src/sidecar-port.js";

async function occupyListenPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = blocker.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => blocker.close(() => resolve())),
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("sidecar listen port env (#768 MCP)", () => {
  let inheritedSidecarPort: string | undefined;

  beforeEach(() => {
    inheritedSidecarPort = process.env.SIDECAR_PORT;
  });

  afterEach(() => {
    if (inheritedSidecarPort === undefined) delete process.env.SIDECAR_PORT;
    else process.env.SIDECAR_PORT = inheritedSidecarPort;
  });

  it("resolveSidecarListenPort prefers options.port over env", () => {
    assert.equal(resolveSidecarListenPort(9200, { SIDECAR_PORT: "9100" }), 9200);
  });

  it("resolveSidecarListenPort defaults to 9100 when env is unset", () => {
    assert.equal(resolveSidecarListenPort(undefined, {}), 9100);
  });

  it("resolveSidecarListenPort keeps explicit port 0 for ephemeral listen", () => {
    assert.equal(resolveSidecarListenPort(0, { SIDECAR_PORT: "9100" }), 0);
  });

  it("resolveSidecarListenPort falls back to 9100 for malformed SIDECAR_PORT", () => {
    assert.equal(resolveSidecarListenPort(undefined, { SIDECAR_PORT: "abc" }), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for zero SIDECAR_PORT", () => {
    assert.equal(resolveSidecarListenPort(undefined, { SIDECAR_PORT: "0" }), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for negative SIDECAR_PORT", () => {
    assert.equal(resolveSidecarListenPort(undefined, { SIDECAR_PORT: "-5" }), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for negative optionsPort", () => {
    assert.equal(resolveSidecarListenPort(-1, {}), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for non-finite optionsPort", () => {
    assert.equal(resolveSidecarListenPort(Number.NaN, {}), 9100);
    assert.equal(resolveSidecarListenPort(Number.POSITIVE_INFINITY, {}), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for optionsPort above 65535", () => {
    assert.equal(resolveSidecarListenPort(70000, {}), 9100);
  });

  it("ensureSidecarPortEnv writes SIDECAR_PORT for programmatic launches", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(resolveSidecarListenPort(9200, env), env);
    assert.equal(env.SIDECAR_PORT, "9200");
    release();
  });

  it("ensureSidecarPortEnv writes SIDECAR_PORT for the default port", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(resolveSidecarListenPort(undefined, env), env);
    assert.equal(env.SIDECAR_PORT, "9100");
    release();
  });

  it("ensureSidecarPortEnv stamps ephemeral 0 as a non-empty sidecar marker", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(0, env);
    assert.equal(env.SIDECAR_PORT, "0");
    release();
    assert.equal(env.SIDECAR_PORT, undefined);
  });

  it("ensureSidecarPortEnv restores inherited SIDECAR_PORT on release", () => {
    const env: NodeJS.ProcessEnv = { SIDECAR_PORT: "9100" };
    const release = ensureSidecarPortEnv(9200, env);
    assert.equal(env.SIDECAR_PORT, "9200");
    release();
    assert.equal(env.SIDECAR_PORT, "9100");
  });

  it("ensureSidecarPortEnv deletes SIDECAR_PORT when it was originally unset", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(9200, env);
    assert.equal(env.SIDECAR_PORT, "9200");
    release();
    assert.equal("SIDECAR_PORT" in env, false);
  });

  it("resolveSidecarListenPort ignores an active stamp so concurrent starts do not collide", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(9200, env);
    assert.equal(env.SIDECAR_PORT, "9200");
    assert.equal(resolveSidecarListenPort(undefined, env), 9100);
    release();
  });

  it("ensureSidecarPortEnv keeps a marker while concurrent sidecars remain", () => {
    const env: NodeJS.ProcessEnv = { SIDECAR_PORT: "9100" };
    const first = ensureSidecarPortEnv(9200, env);
    const second = ensureSidecarPortEnv(9300, env);
    assert.equal(env.SIDECAR_PORT, "9300");
    first();
    assert.equal(env.SIDECAR_PORT, "9300");
    second();
    assert.equal(env.SIDECAR_PORT, "9100");
  });

  it("ensureSidecarPortEnv release is idempotent", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(9200, env);
    release();
    release();
    assert.equal("SIDECAR_PORT" in env, false);
  });

  it("startSidecar close restores inherited SIDECAR_PORT", async () => {
    const prev = process.env.SIDECAR_PORT;
    process.env.SIDECAR_PORT = "9100";
    try {
      const handle = startSidecar({ port: 0, host: "127.0.0.1" });
      assert.equal(process.env.SIDECAR_PORT, "0");
      await handle.ready;
      await handle.close();
      assert.equal(process.env.SIDECAR_PORT, "9100");
    } finally {
      if (prev === undefined) delete process.env.SIDECAR_PORT;
      else process.env.SIDECAR_PORT = prev;
    }
  });

  it("startSidecar ready rejects when listen fails", async () => {
    const blocker = await occupyListenPort();
    assert.ok(blocker.port > 0);
    const prev = process.env.SIDECAR_PORT;
    delete process.env.SIDECAR_PORT;
    try {
      const handle = startSidecar({ port: blocker.port, host: "127.0.0.1" });
      await assert.rejects(
        () => handle.ready,
        (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE",
      );
      await handle.close();
    } finally {
      await blocker.close();
      if (prev === undefined) delete process.env.SIDECAR_PORT;
      else process.env.SIDECAR_PORT = prev;
    }
  });

  it("startSidecar releases SIDECAR_PORT when listen fails", async () => {
    const blocker = await occupyListenPort();
    assert.ok(blocker.port > 0);
    const prev = process.env.SIDECAR_PORT;
    delete process.env.SIDECAR_PORT;
    try {
      const handle = startSidecar({ port: blocker.port, host: "127.0.0.1" });
      handle.ready.catch(() => {});
      await waitUntil(() => !("SIDECAR_PORT" in process.env));
      await handle.close();
    } finally {
      await blocker.close();
      if (prev === undefined) delete process.env.SIDECAR_PORT;
      else process.env.SIDECAR_PORT = prev;
    }
  });

  it("bindSidecarListenExit exits 1 when ready rejects", async () => {
    let rejectReady!: (err: Error) => void;
    const handle = {
      close: async () => {},
      ready: new Promise<void>((_, reject) => {
        rejectReady = reject;
      }),
      stopped: new Promise<SidecarStopResult>(() => {}),
    };
    let exitCode: number | undefined;
    bindSidecarListenExit(handle, (code) => {
      exitCode = code;
    });
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    rejectReady(err);
    await Promise.resolve();
    assert.equal(exitCode, 1);
  });

  it("bindSidecarListenExit exits 1 when stopped is fatal", async () => {
    let resolveStopped!: (result: SidecarStopResult) => void;
    const handle = {
      close: async () => {},
      ready: Promise.resolve(),
      stopped: new Promise<SidecarStopResult>((resolve) => {
        resolveStopped = resolve;
      }),
    };
    let exitCode: number | undefined;
    bindSidecarListenExit(handle, (code) => {
      exitCode = code;
    });
    resolveStopped({ reason: "server_error", fatal: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(exitCode, 1);
  });

  it("bindSidecarListenExit exits once for overlapping fatal signals", async () => {
    let rejectReady!: (err: Error) => void;
    let resolveStopped!: (result: SidecarStopResult) => void;
    const handle = {
      close: async () => {},
      ready: new Promise<void>((_, reject) => {
        rejectReady = reject;
      }),
      stopped: new Promise<SidecarStopResult>((resolve) => {
        resolveStopped = resolve;
      }),
    };
    let exitCount = 0;
    bindSidecarListenExit(handle, () => {
      exitCount += 1;
    });
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    rejectReady(err);
    await Promise.resolve();
    resolveStopped({ reason: "listen_error", fatal: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(exitCount, 1);
  });

  it("startSidecar close before listen settles ready", async () => {
    const handle = startSidecar({ port: 0, host: "127.0.0.1" });
    const closing = handle.close();
    await handle.ready;
    await closing;
  });
});
