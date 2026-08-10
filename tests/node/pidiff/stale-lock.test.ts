import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";

describe("pidiff stale lock detection", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      try { require("node:fs").rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = undefined;
    }
  });

  it("dead PID triggers recover action", async () => {
    const { evaluateSpawnLock } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now()}`
    );
    tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-"));
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, "99999999");

    const result = evaluateSpawnLock(lockPath, 60000);
    assert.equal(result.action, "recover");
    assert.match(result.reason, /dead/);
  });

  it("alive PID with young lock triggers wait action", async () => {
    const { evaluateSpawnLock } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 1}`
    );
    tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-"));
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, String(process.pid));

    const result = evaluateSpawnLock(lockPath, 60000);
    assert.equal(result.action, "wait");
    assert.match(result.reason, /alive/);
  });

  it("no valid PID with old lock triggers recover", async () => {
    const { evaluateSpawnLock } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 2}`
    );
    tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-"));
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, "not-a-pid");

    // Lock with invalid PID and stale timeout of 0 → should recover
    const result = evaluateSpawnLock(lockPath, 0);
    assert.equal(result.action, "recover");
    assert.match(result.reason, /no valid PID/);
  });

  it("missing lockfile triggers recover", async () => {
    const { evaluateSpawnLock } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 3}`
    );
    tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-"));
    const lockPath = join(tmpDir, "pidiff.spawning.nonexistent");

    const result = evaluateSpawnLock(lockPath, 60000);
    assert.equal(result.action, "recover");
    assert.match(result.reason, /cannot read/);
  });

  it("alive PID with very old lock triggers PID reuse recovery", async () => {
    const { evaluateSpawnLock } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 4}`
    );
    tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-"));
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, String(process.pid));

    // Use timeout of 0ms so any lock age > 0 triggers PID reuse
    const result = evaluateSpawnLock(lockPath, 0);
    assert.equal(result.action, "recover_pid_reuse");
    assert.match(result.reason, /alive but lock age/);
  });
});
