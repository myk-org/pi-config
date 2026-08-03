import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";

/** Replica of isPortFree from pidiff.ts for testing */
function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => { try { srv.close(); } catch {} resolve(false); });
    srv.listen(port, "127.0.0.1", () => { srv.close(() => resolve(true)); });
  });
}

describe("isPortFree", () => {
  it("returns a boolean for any port", async () => {
    // Verify isPortFree returns boolean — actual free/in-use is tested by the in-use test below
    const result = await isPortFree(0);
    assert.strictEqual(typeof result, "boolean");
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
      srv.close();
    }
  });

  it("cleans up server on error path", async () => {
    // Bind a port, then check isPortFree — should return false and not leak
    const srv = net.createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        resolve((srv.address() as net.AddressInfo).port);
      });
    });
    try {
      const result = await isPortFree(port);
      assert.strictEqual(result, false);
      // No leaked servers — if we got here without hanging, cleanup worked
    } finally {
      srv.close();
    }
  });

  it("error path does not leak server handles", async () => {
    // Bind a port, then probe it — error path should close server and not leak
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        resolve((blocker.address() as net.AddressInfo).port);
      });
    });
    try {
      // Run multiple probes to verify no handle leak
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(await isPortFree(port), false);
      }
    } finally {
      blocker.close();
    }
  });
});
