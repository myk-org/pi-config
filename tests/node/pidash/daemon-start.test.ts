/**
 * The daemon's startup hook decides WHEN side-effecting consumers start (the Discord bot).
 *
 * The bug this covers: `setupDiscordBot` used to run at module scope, so a second daemon that lost
 * the port still connected a second bot with the same token — two bots answering one user. The hook
 * must run only after the port is ours, and a failed hook must not leave the daemon reporting
 * "healthy" while its questions have no consumer.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { once } from "node:events";

import { createDaemonServer } from "../../../scripts/daemon-shared.ts";

const blockers: Server[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const server of blockers.splice(0)) server.close();
  for (const restore of restores.splice(0)) restore();
});

function serverOptions(port: number) {
  return {
    port,
    uiDir: "/nonexistent-ui",
    uiName: "test-daemon",
    log: () => {},
    onPiMessage: () => {},
    onPiClose: () => {},
  };
}

async function busyPort(): Promise<number> {
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  blockers.push(blocker);
  return (blocker.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** `start()` exits the process on a port conflict; record the code instead of dying.
 *  It must NOT throw: the call comes from a server "error" listener, where a throw would surface as
 *  an uncaughtException and take the test runner with it. */
function captureExit(): { code: () => number | null } {
  const original = process.exit;
  let code: number | null = null;
  process.exit = ((value?: number) => {
    code = value ?? 0;
  }) as typeof process.exit;
  restores.push(() => { process.exit = original; });
  return { code: () => code };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("daemon startup hook", () => {
  it("does not run when the port is already taken", async () => {
    // The original bug: the losing daemon started its Discord bot anyway.
    const port = await busyPort();
    const exit = captureExit();
    const seen: string[] = [];
    const daemon = createDaemonServer(serverOptions(port));

    daemon.start(() => seen.push("ran"));
    await waitFor(() => exit.code() !== null);

    assert.deepEqual(seen, [], "a daemon that lost the port must not start its consumer");
    assert.equal(exit.code(), 0, "the loser exits cleanly");
  });

  it("runs exactly once after the port is ours", async () => {
    const port = await freePort();
    const seen: string[] = [];
    const daemon = createDaemonServer(serverOptions(port));

    daemon.start(() => seen.push("ran"));
    await waitFor(() => seen.length > 0);

    assert.deepEqual(seen, ["ran"], "the hook runs once, after listening");
    daemon.server.close();
  });

  it("reports degraded instead of ok when the hook throws", async () => {
    // A bot that fails to start leaves questions with no consumer: /api/health must say so.
    const port = await freePort();
    const daemon = createDaemonServer(serverOptions(port));
    daemon.start(() => { throw new Error("discord setup failed"); });
    await waitFor(() => daemon.server.listening);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json() as { status: string; startupError?: string };
    daemon.server.close();

    assert.equal(body.status, "degraded");
    assert.match(String(body.startupError), /discord setup failed/);
  });
});
