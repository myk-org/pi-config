/**
 * Unit tests for extensions/pidiff/lockfile.ts:
 * lockfile read/write/remove, legacy `.pi/tmp` owner checks, `findLiveLockfile`,
 * `killDaemonByPid`, `stopPidiffDaemon`, `registerServerPidFile`, `findFreePort`,
 * `isPortFree`, and `resolveSpawnPort`.
 *
 * Run with: npx tsx --test tests/node/pidiff/lockfile.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import { join } from "node:path";
import {
  findFreePort,
  findLiveLockfile,
  isLiveLegacyDaemonFile,
  isPortFree,
  killDaemonByPid,
  legacyLockfileOwnerAlive,
  readLockfile,
  registerServerPidFile,
  removeDeadLegacyPidFile,
  removeLockfile,
  resolveSpawnPort,
  stopPidiffDaemon,
  writeLockfile,
} from "../../../extensions/pidiff/lockfile.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("findLiveLockfile (#1020)", () => {
  let server: Server | undefined;

  const listenHealthy = async (): Promise<number> => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as { port: number }).port;
  };

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("finds the live daemon in the legacy dir when the new-dir record is stale", async () => {
    const livePort = await listenHealthy();
    const runDir = makeTempDir("pidiff-live-");
    const legacyDir = makeTempDir("pidiff-live-legacy-");
    try {
      const deadPort = await findFreePort();
      writeLockfile(runDir, deadPort, null, () => {});
      writeLockfile(legacyDir, livePort, null, () => {});
      assert.strictEqual(readLockfile(runDir, legacyDir)!.port, deadPort);
      assert.strictEqual(await findLiveLockfile([runDir, legacyDir]), livePort);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("returns null when no recorded port is healthy", async () => {
    const runDir = makeTempDir("pidiff-live-");
    try {
      writeLockfile(runDir, await findFreePort(), null, () => {});
      assert.strictEqual(await findLiveLockfile([runDir, ""]), null);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("skips ports in skipPorts without probing them (#1269)", async () => {
    const runDir = makeTempDir("pidiff-skip-run-");
    const legacyDir = makeTempDir("pidiff-skip-legacy-");
    try {
      writeLockfile(runDir, 45001, null, () => {});
      writeLockfile(legacyDir, 45001, null, () => {});
      const probed: number[] = [];
      const fakeProbe = async (port: number) => {
        probed.push(port);
        return false;
      };
      assert.strictEqual(await findLiveLockfile([runDir, legacyDir], new Set([45001]), fakeProbe), null);
      assert.deepStrictEqual(probed, []);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("probes a duplicate port across lock dirs only once (#1269)", async () => {
    const runDir = makeTempDir("pidiff-dedup-run-");
    const legacyDir = makeTempDir("pidiff-dedup-legacy-");
    try {
      writeLockfile(runDir, 45002, null, () => {});
      writeLockfile(legacyDir, 45002, null, () => {});
      const probed: number[] = [];
      const fakeProbe = async (port: number) => {
        probed.push(port);
        return false;
      };
      assert.strictEqual(await findLiveLockfile([runDir, legacyDir], undefined, fakeProbe), null);
      assert.deepStrictEqual(probed, [45002]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("lockfile read/write/remove", () => {
  it("round-trips port with pid through lockfile", () => {
    const dir = makeTempDir("pidiff-lf-");
    try {
      writeLockfile(dir, 12345, 99999, () => {});
      assert.deepStrictEqual(readLockfile(dir), { port: 12345, pid: 99999 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles null pid in lockfile", () => {
    const dir = makeTempDir("pidiff-lf-");
    try {
      writeLockfile(dir, 8080, null, () => {});
      assert.deepStrictEqual(readLockfile(dir), { port: 8080, pid: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent dir", () => {
    assert.strictEqual(readLockfile("/tmp/nonexistent-pidiff-lf-" + Date.now()), null);
  });

  it("ignores a non-regular port file instead of blocking", () => {
    const dir = makeTempDir("pidiff-lf-");
    try {
      mkdirSync(join(dir, "pidiff.port"));
      assert.strictEqual(readLockfile(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes port/pid lockfiles via removeLockfile", () => {
    const dir = makeTempDir("pidiff-lf-");
    try {
      writeLockfile(dir, 12345, 99999, () => {});
      assert.ok(existsSync(join(dir, "pidiff.port")));
      assert.ok(existsSync(join(dir, "pidiff.pid")));
      removeLockfile(dir, () => {});
      assert.ok(!existsSync(join(dir, "pidiff.port")));
      assert.ok(!existsSync(join(dir, "pidiff.pid")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles missing files gracefully in removeLockfile", () => {
    const dir = makeTempDir("pidiff-lf-");
    try {
      assert.doesNotThrow(() => removeLockfile(dir, () => {}));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy .pi/tmp lockfiles (#1020)", () => {
  const mk = () => makeTempDir("pidiff-legacy-");

  it("reads the legacy dir when the new dir has no lockfile", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 41234, 4321, () => {});
      assert.strictEqual(readLockfile(runDir), null);
      assert.deepStrictEqual(readLockfile(runDir, legacyDir), { port: 41234, pid: 4321 });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("never moves or deletes the legacy lockfile when reading", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 41234, 4321, () => {});
      assert.deepStrictEqual(readLockfile(runDir, legacyDir), { port: 41234, pid: 4321 });
      assert.strictEqual(readFileSync(join(legacyDir, "pidiff.port"), "utf-8"), "41234");
      assert.strictEqual(readFileSync(join(legacyDir, "pidiff.pid"), "utf-8"), "4321");
      assert.strictEqual(existsSync(join(runDir, "pidiff.port")), false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("prefers the new dir when both exist", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 1000, null, () => {});
      writeLockfile(runDir, 2000, null, () => {});
      assert.strictEqual(readLockfile(runDir, legacyDir)!.port, 2000);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("does not modify the legacy dir when writing to the new dir", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 1000, null, () => {});
      writeLockfile(runDir, 2000, null, () => {});
      assert.strictEqual(readFileSync(join(legacyDir, "pidiff.port"), "utf-8"), "1000");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("clears legacy copies via removeLockfile", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 41234, 4321, () => {});
      removeLockfile(runDir, () => {}, legacyDir);
      assert.ok(!existsSync(join(legacyDir, "pidiff.port")));
      assert.ok(!existsSync(join(legacyDir, "pidiff.pid")));
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is false when there is no pid file", () => {
    const dir = mk();
    try {
      assert.strictEqual(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is true for a live pid", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), String(process.pid));
      assert.strictEqual(legacyLockfileOwnerAlive(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is false for pid 0", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), "0");
      assert.strictEqual(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is false for an unparseable pid", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), "not-a-pid");
      assert.strictEqual(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive refuses an oversized pid file", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), "1".repeat(4096));
      assert.strictEqual(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive refuses a non-regular pid file", () => {
    const dir = mk();
    try {
      mkdirSync(join(dir, "pidiff.pid"));
      assert.strictEqual(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive treats EPERM as alive", () => {
    const dir = mk();
    const original = process.kill;
    try {
      writeFileSync(join(dir, "pidiff.pid"), "424242");
      (process as unknown as { kill: unknown }).kill = () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      };
      assert.strictEqual(legacyLockfileOwnerAlive(dir), true);
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive treats ESRCH as dead", () => {
    const dir = mk();
    const original = process.kill;
    try {
      writeFileSync(join(dir, "pidiff.pid"), "424243");
      (process as unknown as { kill: unknown }).kill = () => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      };
      assert.strictEqual(legacyLockfileOwnerAlive(dir), false);
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isLiveLegacyDaemonFile is true only for a legacy lockfile with a live owner", () => {
    const dir = mk();
    try {
      writeLockfile(dir, 41234, process.pid, () => {});
      assert.strictEqual(isLiveLegacyDaemonFile(dir, "pidiff.port"), true);
      assert.strictEqual(isLiveLegacyDaemonFile(dir, "pidiff.pid"), true);
      assert.strictEqual(isLiveLegacyDaemonFile(dir, "reload.flag"), false);
      writeFileSync(join(dir, "pidiff.pid"), "0");
      assert.strictEqual(isLiveLegacyDaemonFile(dir, "pidiff.port"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("killDaemonByPid & stopPidiffDaemon", () => {
  it("cleans the legacy pid file when the new one is absent", () => {
    const runDir = makeTempDir("pidiff-kill-");
    const legacyDir = makeTempDir("pidiff-kill-legacy-");
    const legacyPidFile = join(legacyDir, "pidiff.pid");
    try {
      writeFileSync(legacyPidFile, "999999999");
      const killed = killDaemonByPid(join(runDir, "pidiff.pid"), () => {}, legacyPidFile);
      assert.strictEqual(killed, false);
      assert.ok(!existsSync(legacyPidFile));
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("returns false for a non-existent pid file", () => {
    assert.strictEqual(killDaemonByPid("/tmp/nonexistent-pid-" + Date.now(), () => {}), false);
  });

  it("returns false for an invalid pid in file", () => {
    const dir = makeTempDir("pidiff-kill-");
    const pidFile = join(dir, "pidiff.pid");
    try {
      writeFileSync(pidFile, "not-a-number");
      assert.strictEqual(killDaemonByPid(pidFile, () => {}), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up pid file for a dead pid", () => {
    const dir = makeTempDir("pidiff-kill-");
    const pidFile = join(dir, "pidiff.pid");
    try {
      writeFileSync(pidFile, "999999999");
      assert.strictEqual(killDaemonByPid(pidFile, () => {}), false);
      assert.ok(!existsSync(pidFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stopPidiffDaemon clears lockfiles across current/legacy dirs", () => {
    const runDir = makeTempDir("pidiff-stop-");
    const legacyDir = makeTempDir("pidiff-stop-legacy-");
    try {
      writeLockfile(runDir, 41000, 999999998, () => {});
      writeLockfile(legacyDir, 41001, 999999999, () => {});
      stopPidiffDaemon(runDir, legacyDir, () => {});
      assert.ok(!existsSync(join(runDir, "pidiff.port")));
      assert.ok(!existsSync(join(runDir, "pidiff.pid")));
      assert.ok(!existsSync(join(legacyDir, "pidiff.port")));
      assert.ok(!existsSync(join(legacyDir, "pidiff.pid")));
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("registerServerPidFile & removeDeadLegacyPidFile", () => {
  it("writes .pi/run/pidiff.pid then removes it on cleanup", () => {
    const project = makeTempDir("pidiff-srv-");
    try {
      const cleanup = registerServerPidFile(project, () => {}, process.pid);
      const pidFile = join(project, ".pi", "run", "pidiff.pid");
      assert.strictEqual(readFileSync(pidFile, "utf-8"), String(process.pid));
      cleanup();
      assert.strictEqual(existsSync(pidFile), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("removes a dead legacy pid file on startup", () => {
    const project = makeTempDir("pidiff-srv-");
    const legacyDir = join(project, ".pi", "tmp");
    try {
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "pidiff.pid"), "999999999");
      const cleanup = registerServerPidFile(project, () => {}, process.pid);
      assert.strictEqual(existsSync(join(legacyDir, "pidiff.pid")), false);
      cleanup();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preserves a live legacy pid file owned by another process", () => {
    const legacyDir = makeTempDir("pidiff-srv-legacy-");
    try {
      writeFileSync(join(legacyDir, "pidiff.pid"), String(process.pid));
      const removed = removeDeadLegacyPidFile(legacyDir, process.pid + 1);
      assert.strictEqual(removed, false);
      assert.strictEqual(existsSync(join(legacyDir, "pidiff.pid")), true);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("preserves pid file on exit cleanup if overwritten by another live pid", () => {
    const project = makeTempDir("pidiff-srv-");
    try {
      const cleanup = registerServerPidFile(project, () => {}, 999999991);
      const pidFile = join(project, ".pi", "run", "pidiff.pid");
      writeFileSync(pidFile, String(process.pid));
      cleanup();
      assert.strictEqual(existsSync(pidFile), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("port probing (findFreePort, isPortFree, resolveSpawnPort)", () => {
  it("findFreePort returns a valid ephemeral TCP port", async () => {
    const port = await findFreePort();
    assert.ok(port > 0 && port < 65536);
  });

  it("resolveSpawnPort reuses a free preferred port", async () => {
    const free = await findFreePort();
    assert.strictEqual(await resolveSpawnPort(free), free);
  });

  it("resolveSpawnPort allocates a new port when the preferred port is occupied", async () => {
    const blocker = net.createServer();
    const busy = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        resolve((blocker.address() as net.AddressInfo).port);
      });
    });
    try {
      assert.strictEqual(await isPortFree(busy), false);
      const allocated = await resolveSpawnPort(busy);
      assert.notStrictEqual(allocated, busy);
      assert.ok(allocated > 0 && allocated < 65536);
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => resolve()); });
    }
  });
});
