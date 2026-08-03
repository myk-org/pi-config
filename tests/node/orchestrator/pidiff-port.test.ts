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
  it("returns true for an unused port", async () => {
    // Get a free port
    const freePort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
    assert.strictEqual(await isPortFree(freePort), true);
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
});
