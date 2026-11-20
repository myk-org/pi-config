/**
 * Shared cross-process file & directory locking primitives + synchronous sleep.
 *
 * Consolidates O_EXCL lock acquisition, stale lock reclaim, and Atomics.wait
 * backoff across orchestrator modules (state-jsonl, trail, tmp-cleanup,
 * enforcement-helpers).
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

export type LockOwner = { pid: number; token: string };

/** Synchronous sleep for lock backoff (Atomics.wait works on Node's main thread). */
export function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when `pid` refers to an existing OS process (including EPERM). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** Read `{ pid, token }` JSON (or legacy numeric PID) from a lock file. */
export function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const legacyPid = Number(raw);
    if (Number.isSafeInteger(legacyPid)) return { pid: legacyPid, token: `legacy-${legacyPid}` };
    const owner = JSON.parse(raw);
    return Number.isSafeInteger(owner?.pid) && typeof owner?.token === "string" ? owner : null;
  } catch {
    return null;
  }
}

/**
 * Acquire a directory-based lock (`mkdirSync(lockDir)`) with bounded sleep backoff.
 * Returns `true` when acquired, `false` if contention exceeded `attempts`.
 */
export function acquireDirLock(lockDir: string, attempts = 10, sleepMs = 50): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      if (attempt + 1 < attempts) syncSleep(sleepMs);
    }
  }
  return false;
}

/**
 * Acquire a PID-only exclusive file lock (`flag: "wx"`), reclaiming dead PIDs
 * and supporting same-PID reentrancy.
 */
export function acquirePidLock(
  lockFile: string,
  opts?: { maxRetries?: number; ensureParent?: (filePath: string) => void },
): boolean {
  const maxRetries = opts?.maxRetries ?? 50;
  for (let i = 0; i < maxRetries; i++) {
    try {
      opts?.ensureParent?.(lockFile);
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
        if (pid === process.pid) return true; // Reentrant
        if (pid) {
          if (isPidAlive(pid)) continue;
          try { unlinkSync(lockFile); } catch { /* race */ }
          continue;
        }
      } catch {
        try { unlinkSync(lockFile); } catch { /* race */ }
        continue;
      }
    }
  }
  return false;
}

/**
 * Acquire a token-verified O_EXCL file lock (`{ pid, token }`) with dead-owner
 * reclamation via atomic rename. Returns a release callback, or null on contention.
 */
export function acquireTokenFileLock(
  lockPath: string,
  opts: {
    attempts?: number;
    sleepMs?: number;
    linkTemp?: boolean;
    uniqueClaim?: boolean;
    afterClaim?: () => void;
    onError?: (code: string | undefined) => void;
  } = {},
): (() => void) | null {
  const attempts = opts.attempts ?? 2;
  const sleepMs = opts.sleepMs ?? 0;
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  const claim = opts.uniqueClaim ? `${lockPath}.claim-${owner.token}` : `${lockPath}.claim`;
  const ownerTmp = `${lockPath}.${owner.token}.tmp`;

  const release = () => {
    try {
      if (readLockOwner(lockPath)?.token === owner.token) unlinkSync(lockPath);
    } catch { /* ignore */ }
  };

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!opts.uniqueClaim) {
      const claimant = readLockOwner(claim);
      if (claimant) {
        if (isPidAlive(claimant.pid)) return null;
        try { unlinkSync(claim); } catch { return null; }
      }
    }

    try {
      if (opts.linkTemp) {
        writeFileSync(ownerTmp, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
        linkSync(ownerTmp, lockPath);
        try { unlinkSync(ownerTmp); } catch { /* ignore */ }
      } else {
        const fd = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(owner));
        } finally {
          closeSync(fd);
        }
        if (readLockOwner(claim)) {
          release();
          return null;
        }
      }
      return release;
    } catch (error: any) {
      if (opts.linkTemp) {
        try { unlinkSync(ownerTmp); } catch { /* ignore */ }
      }
      if (error?.code !== "EEXIST") {
        opts.onError?.(error?.code);
        return null;
      }
      if (opts.uniqueClaim) {
        const existing = readLockOwner(lockPath);
        if (existing && !isPidAlive(existing.pid)) {
          try {
            renameSync(lockPath, claim);
            if (readLockOwner(claim)?.token === existing.token && !isPidAlive(existing.pid)) {
              unlinkSync(claim);
            } else {
              try { renameSync(claim, lockPath); } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
        if (sleepMs > 0) syncSleep(sleepMs);
      } else {
        try {
          renameSync(lockPath, claim);
          const claimedOwner = readLockOwner(claim);
          if (claimedOwner && isPidAlive(claimedOwner.pid)) {
            try { renameSync(claim, lockPath); } catch { /* ignore */ }
            return null;
          }
          opts.afterClaim?.();
          unlinkSync(claim);
        } catch {
          return null;
        }
      }
    }
  }
  if (opts.uniqueClaim) opts.onError?.("LOCK_BUSY");
  return null;
}

/**
 * Acquire an O_EXCL file lock with mtime-based stale lock reclamation and inode
 * verification on rename. Returns a release callback, or null when contended.
 */
export function acquireMtimeFileLock(
  lockPath: string,
  staleMs: number,
  opts?: {
    onLockFailed?: (error: any) => void;
    onReclaimRaced?: () => void;
  },
): (() => void) | null {
  const pid = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, pid);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          // Unlink only our own lock: a stale reclaim may have handed it to another session.
          if (readFileSync(lockPath, "utf8") !== pid) return;
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        opts?.onLockFailed?.(error);
        return null;
      }
      if (error?.code !== "EEXIST") {
        opts?.onLockFailed?.(error);
        return null;
      }
      let held: Stats;
      try {
        held = statSync(lockPath);
      } catch {
        continue; // holder released — retry the create
      }
      if (Date.now() - held.mtimeMs <= staleMs) return null;
      const reclaimPath = `${lockPath}.${process.pid}.reclaim`;
      try {
        renameSync(lockPath, reclaimPath);
      } catch {
        continue;
      }
      let moved: Stats | undefined;
      try {
        moved = statSync(reclaimPath);
      } catch {
        moved = undefined;
      }
      if (!moved || moved.dev !== held.dev || moved.ino !== held.ino) {
        try {
          linkSync(reclaimPath, lockPath);
        } catch {
          /* a third session holds the pathname; its lock wins */
        }
        try {
          unlinkSync(reclaimPath);
        } catch {
          /* already gone */
        }
        opts?.onReclaimRaced?.();
        return null;
      }
      try {
        unlinkSync(reclaimPath);
      } catch {
        /* already gone */
      }
    }
  }
  return null;
}

/** Ensure the parent directory exists with private permissions. */
export function ensurePrivateParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}
