import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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

describe("spawn lock across .pi/run and legacy .pi/tmp (#1020)", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs = [];
  });

  const mkDirs = (n: number): string[] => {
    dirs = Array.from({ length: n }, () => mkdtempSync(join(tmpdir(), "pidiff-spawn-")));
    return dirs;
  };

  it("takes the lock in every dir", async () => {
    const { acquireSpawnLocks, releaseSpawnLocks } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 10}`
    );
    const [legacy, run] = mkDirs(2);
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, null);
    assert.deepEqual(held, [join(legacy, "pidiff.spawning"), join(run, "pidiff.spawning")]);
    assert.equal(readFileSync(join(run, "pidiff.spawning"), "utf-8"), String(process.pid));
    releaseSpawnLocks(held);
    assert.ok(!existsSync(join(legacy, "pidiff.spawning")), "release clears the legacy lock");
    assert.ok(!existsSync(join(run, "pidiff.spawning")), "release clears the new lock");
  });

  it("reports the legacy lock as contended when a pre-#1020 session holds it", async () => {
    const { acquireSpawnLocks } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 11}`
    );
    const [legacy, run] = mkDirs(2);
    writeFileSync(join(legacy, "pidiff.spawning"), String(process.pid)); // old-code session
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, join(legacy, "pidiff.spawning"));
    assert.deepEqual(held, []);
    assert.ok(!existsSync(join(run, "pidiff.spawning")), "no new-dir lock is taken while waiting");
  });

  it("releases a lock it already took when a later dir is contended", async () => {
    const { acquireSpawnLocks } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 12}`
    );
    const [legacy, run] = mkDirs(2);
    writeFileSync(join(run, "pidiff.spawning"), String(process.pid)); // a concurrent new-code session
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, join(run, "pidiff.spawning"));
    assert.deepEqual(held, []);
    assert.ok(!existsSync(join(legacy, "pidiff.spawning")), "the legacy lock is not left behind");
  });
});
