import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  acquireDirLock,
  acquireMtimeFileLock,
  acquirePidLock,
  acquireTokenFileLock,
  ensurePrivateParentDir,
  isPidAlive,
  readLockOwner,
  syncSleep,
} from "../../../extensions/shared/file-lock.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("shared file-lock primitives (#1236)", () => {
  it("isPidAlive returns true for live process", () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it("isPidAlive returns false for nonexistent or invalid PIDs", () => {
    assert.equal(isPidAlive(999_999_999), false);
    assert.equal(isPidAlive(-1), false);
  });

  it("acquireDirLock acquires an unlocked directory", () => {
    const dir = makeTempDir("file-lock-dir-");
    try {
      const lockDir = path.join(dir, "test.lock");
      assert.equal(acquireDirLock(lockDir, 1, 1), true);
      assert.equal(fs.existsSync(lockDir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireDirLock returns false while lock directory exists", () => {
    const dir = makeTempDir("file-lock-dir-busy-");
    try {
      const lockDir = path.join(dir, "test.lock");
      assert.equal(acquireDirLock(lockDir, 1, 1), true);
      assert.equal(acquireDirLock(lockDir, 1, 1), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireDirLock reacquires after lock directory removal", () => {
    const dir = makeTempDir("file-lock-dir-reacq-");
    try {
      const lockDir = path.join(dir, "test.lock");
      assert.equal(acquireDirLock(lockDir, 1, 1), true);
      fs.rmdirSync(lockDir);
      assert.equal(acquireDirLock(lockDir, 1, 1), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquirePidLock reclaims dead PID lock", () => {
    const dir = makeTempDir("file-lock-pid-dead-");
    try {
      const lockFile = path.join(dir, "pid.wlock");
      fs.writeFileSync(lockFile, "999999999");
      assert.equal(acquirePidLock(lockFile), true);
      assert.equal(fs.readFileSync(lockFile, "utf-8"), String(process.pid));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquirePidLock permits same-PID reentrancy", () => {
    const dir = makeTempDir("file-lock-pid-reent-");
    try {
      const lockFile = path.join(dir, "pid.wlock");
      fs.writeFileSync(lockFile, String(process.pid));
      assert.equal(acquirePidLock(lockFile), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquirePidLock reclaims lock when process.kill throws EPERM", () => {
    const dir = makeTempDir("file-lock-pid-eperm-");
    const origKill = process.kill;
    try {
      const lockFile = path.join(dir, "pid.wlock");
      fs.writeFileSync(lockFile, "12345");
      (process as any).kill = () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      };
      assert.equal(acquirePidLock(lockFile, { maxRetries: 4 }), true);
      assert.equal(fs.readFileSync(lockFile, "utf-8"), String(process.pid));
    } finally {
      process.kill = origKill;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireTokenFileLock blocks contention until released", () => {
    const dir = makeTempDir("file-lock-token-");
    try {
      const lockFile = path.join(dir, "tok.lock");
      const release = acquireTokenFileLock(lockFile);
      assert.ok(release);
      assert.equal(acquireTokenFileLock(lockFile), null);
      release();
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireTokenFileLock reclaims dead owner lock", () => {
    const dir = makeTempDir("file-lock-token-dead-");
    try {
      const lockFile = path.join(dir, "tok.lock");
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, token: "dead" }));
      const release = acquireTokenFileLock(lockFile);
      assert.ok(release);
      release();
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireMtimeFileLock holds contention while fresh", () => {
    const dir = makeTempDir("file-lock-mtime-");
    try {
      const lockFile = path.join(dir, "sweep.lock");
      const release = acquireMtimeFileLock(lockFile, 60_000);
      assert.ok(release);
      assert.equal(acquireMtimeFileLock(lockFile, 60_000), null);
      release();
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireMtimeFileLock reclaims stale lock", () => {
    const dir = makeTempDir("file-lock-mtime-stale-");
    try {
      const lockFile = path.join(dir, "sweep.lock");
      fs.writeFileSync(lockFile, "12345");
      const past = new Date(Date.now() - 120_000);
      fs.utimesSync(lockFile, past, past);
      const release = acquireMtimeFileLock(lockFile, 60_000);
      assert.ok(release);
      release();
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readLockOwner parses JSON owner, legacy numeric PID, or null on missing/corrupt", () => {
    const dir = makeTempDir("file-lock-owner-");
    try {
      const jsonLock = path.join(dir, "json.lock");
      fs.writeFileSync(jsonLock, JSON.stringify({ pid: 42, token: "abc" }));
      assert.deepEqual(readLockOwner(jsonLock), { pid: 42, token: "abc" });

      const legacyLock = path.join(dir, "legacy.lock");
      fs.writeFileSync(legacyLock, "77");
      assert.deepEqual(readLockOwner(legacyLock), { pid: 77, token: "legacy-77" });

      const corruptLock = path.join(dir, "corrupt.lock");
      fs.writeFileSync(corruptLock, "{bad");
      assert.equal(readLockOwner(corruptLock), null);
      assert.equal(readLockOwner(path.join(dir, "missing.lock")), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensurePrivateParentDir creates missing parent directories with 0700 mode", () => {
    const dir = makeTempDir("file-lock-parent-");
    try {
      const target = path.join(dir, "nested", "sub", "state.jsonl");
      ensurePrivateParentDir(target);
      const st = fs.statSync(path.dirname(target));
      assert.equal(st.isDirectory(), true);
      assert.equal(st.mode & 0o777, 0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncSleep waits at least the requested interval", () => {
    const start = Date.now();
    syncSleep(10);
    assert.ok(Date.now() - start >= 5);
  });
});
