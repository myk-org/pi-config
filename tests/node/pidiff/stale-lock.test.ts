import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
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
    // Set mtime to 2s ago to exceed the 1s floor
    const twoSecsAgo = new Date(Date.now() - 2000);
    utimesSync(lockPath, twoSecsAgo, twoSecsAgo);

    const result = evaluateSpawnLock(lockPath, 500); // 500ms < 1s floor → uses 1s, lock is 2s old → recover
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
    // Set mtime to 2s ago to exceed the 1s floor
    const twoSecsAgo = new Date(Date.now() - 2000);
    utimesSync(lockPath, twoSecsAgo, twoSecsAgo);

    const result = evaluateSpawnLock(lockPath, 500); // floor 1s, lock 2s old → recover_pid_reuse
    assert.equal(result.action, "recover_pid_reuse");
    assert.match(result.reason, /alive but lock age/);
  });
});
