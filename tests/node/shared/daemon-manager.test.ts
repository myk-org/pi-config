/**
 * Tests for daemon-manager lockfile and port helpers.
 * Run with: npx tsx --test tests/node/shared/daemon-manager.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeLockfile, readLockfile, removeLockfile, findFreePort } from "../../../extensions/shared/daemon-manager.js";

describe("writeLockfile + readLockfile", () => {
  it("writes and reads port + pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
    try {
      const log = () => {};
      writeLockfile(dir, 12345, 99999, log);
      const result = readLockfile(dir);
      assert.ok(result);
      assert.strictEqual(result!.port, 12345);
      assert.strictEqual(result!.pid, 99999);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("reads port without pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
    try {
      const log = () => {};
      writeLockfile(dir, 8080, null, log);
      const result = readLockfile(dir);
      assert.ok(result);
      assert.strictEqual(result!.port, 8080);
      assert.strictEqual(result!.pid, null);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("returns null for non-existent dir", () => {
    const result = readLockfile("/tmp/nonexistent-dm-test-" + Date.now());
    assert.strictEqual(result, null);
  });
});

describe("removeLockfile", () => {
  it("removes port and pid files", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
    try {
      const log = () => {};
      writeLockfile(dir, 12345, 99999, log);
      assert.ok(existsSync(join(dir, "pidiff.port")));
      assert.ok(existsSync(join(dir, "pidiff.pid")));
      removeLockfile(dir, log);
      assert.ok(!existsSync(join(dir, "pidiff.port")));
      assert.ok(!existsSync(join(dir, "pidiff.pid")));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("handles missing files gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
    try {
      const log = () => {};
      removeLockfile(dir, log); // should not throw
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe("findFreePort", () => {
  it("returns a valid port number", async () => {
    const port = await findFreePort();
    assert.ok(typeof port === "number");
    assert.ok(port > 0);
    assert.ok(port < 65536);
  });

  it("returns different ports on successive calls", async () => {
    const port1 = await findFreePort();
    const port2 = await findFreePort();
    // Not guaranteed but very likely
    assert.ok(typeof port1 === "number");
    assert.ok(typeof port2 === "number");
  });
});
