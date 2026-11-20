import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  acquireDirLock,
  acquireMtimeFileLock,
  acquirePidLock,
  acquireTokenFileLock,
  isPidAlive,
} from "../../../extensions/shared/file-lock.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("shared file-lock primitives (#1236)", () => {
  it("isPidAlive distinguishes live vs nonexistent PIDs", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999_999), false);
    assert.equal(isPidAlive(-1), false);
  });

  it("acquireDirLock acquires and detects contention", () => {
    const dir = makeTempDir("file-lock-dir-");
    try {
      const lockDir = path.join(dir, "test.lock");
      assert.equal(acquireDirLock(lockDir, 1, 1), true);
      assert.equal(acquireDirLock(lockDir, 1, 1), false);
      fs.rmdirSync(lockDir);
      assert.equal(acquireDirLock(lockDir, 1, 1), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquirePidLock reclaims dead PID lock and handles reentrancy", () => {
    const dir = makeTempDir("file-lock-pid-");
    try {
      const lockFile = path.join(dir, "pid.wlock");
      fs.writeFileSync(lockFile, "999999999");
      assert.equal(acquirePidLock(lockFile), true);
      assert.equal(fs.readFileSync(lockFile, "utf-8"), String(process.pid));
      // Same-PID reentrant
      assert.equal(acquirePidLock(lockFile), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireTokenFileLock acquires, releases, and reclaims dead owner", () => {
    const dir = makeTempDir("file-lock-token-");
    try {
      const lockFile = path.join(dir, "tok.lock");
      const release = acquireTokenFileLock(lockFile);
      assert.ok(release);
      assert.equal(acquireTokenFileLock(lockFile), null);
      release();
      assert.equal(fs.existsSync(lockFile), false);

      // Dead owner reclamation
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, token: "dead" }));
      const release2 = acquireTokenFileLock(lockFile);
      assert.ok(release2);
      release2();
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireMtimeFileLock respects fresh lock and reclaims stale lock", () => {
    const dir = makeTempDir("file-lock-mtime-");
    try {
      const lockFile = path.join(dir, "sweep.lock");
      const release = acquireMtimeFileLock(lockFile, 60_000);
      assert.ok(release);
      assert.equal(acquireMtimeFileLock(lockFile, 60_000), null);
      release();
      assert.equal(fs.existsSync(lockFile), false);

      // Stale lock reclamation
      fs.writeFileSync(lockFile, "12345");
      const past = new Date(Date.now() - 120_000);
      fs.utimesSync(lockFile, past, past);
      const release2 = acquireMtimeFileLock(lockFile, 60_000);
      assert.ok(release2);
      release2();
      assert.equal(fs.existsSync(lockFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
