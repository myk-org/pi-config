import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { isPortFree } from "../../../extensions/pidiff/lockfile.js";

describe("isPortFree", () => {
  it("returns true for port 0", async () => {
    assert.strictEqual(await isPortFree(0), true);
  });

  it("returns false for a port in use", async () => {
    const srv = net.createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as net.AddressInfo).port);
      });
    });
    try {
      assert.strictEqual(await isPortFree(port), false);
    } finally {
      await new Promise<void>((resolve) => { srv.close(() => resolve()); });
    }
  });

  it("handles repeated probes on a busy port without leaking handles", async () => {
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        resolve((blocker.address() as net.AddressInfo).port);
      });
    });
    try {
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(await isPortFree(port), false);
      }
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => resolve()); });
    }
  });
});
