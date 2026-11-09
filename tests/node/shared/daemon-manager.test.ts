/**
 * Tests for daemon-manager lockfile and port helpers.
 * Run with: npx tsx --test tests/node/shared/daemon-manager.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeLockfile, readLockfile, findLiveLockfile, removeLockfile, findFreePort, killDaemonByPid, findJitiUnder, findJitiPath, spawnDaemon, legacyLockfileOwnerAlive, isLiveLegacyDaemonFile, parseHealth } from "../../../extensions/shared/daemon-manager.js";
import { createServer, type Server } from "node:http";
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
    const runDir = makeTempDir("dm-live-");
    const legacyDir = makeTempDir("dm-live-legacy-");
    try {
      const deadPort = await findFreePort();
      writeLockfile(runDir, deadPort, null, () => {}); // stale record shadows nothing yet
      writeLockfile(legacyDir, livePort, null, () => {});
      assert.strictEqual(readLockfile(runDir, legacyDir)!.port, deadPort, "plain read returns the stale record");
      assert.strictEqual(await findLiveLockfile([runDir, legacyDir]), livePort);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("returns null when no recorded port is healthy", async () => {
    const runDir = makeTempDir("dm-live-");
    try {
      writeLockfile(runDir, await findFreePort(), null, () => {});
      assert.strictEqual(await findLiveLockfile([runDir, ""]), null);
    } finally { rmSync(runDir, { recursive: true, force: true }); }
  });
});

describe("lockfile operations", () => {
  it("stores port and pid via writeLockfile, retrieves via readLockfile", () => {
    const dir = makeTempDir("dm-test-");
    try {
      const log = () => {};
      writeLockfile(dir, 12345, 99999, log);
      const result = readLockfile(dir);
      assert.ok(result);
      assert.strictEqual(result!.port, 12345);
      assert.strictEqual(result!.pid, 99999);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("handles null pid in lockfile", () => {
    const dir = makeTempDir("dm-test-");
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
  it("cleans up both lockfile entries", () => {
    const dir = makeTempDir("dm-test-");
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
    const dir = makeTempDir("dm-test-");
    try {
      const log = () => {};
      removeLockfile(dir, log); // should not throw
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe("legacy .pi/tmp lockfiles (#1020)", () => {
  const mk = () => makeTempDir("dm-legacy-");

  it("a daemon that started before the move is still found via the legacy dir", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 41234, 4321, () => {});
      assert.strictEqual(readLockfile(runDir), null, "new dir alone sees nothing");
      assert.deepEqual(readLockfile(runDir, legacyDir), { port: 41234, pid: 4321 });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("reading a legacy lockfile never moves or deletes it", () => {
    const runDir = mk();
    const legacyDir = mk();
    try {
      writeLockfile(legacyDir, 41234, 4321, () => {});
      assert.deepEqual(readLockfile(runDir, legacyDir), { port: 41234, pid: 4321 });
      // The legacy owner may be live: moving its record would let the sweep (or a crashed
      // read) take it away and a later connect() would spawn a duplicate on that port.
      assert.strictEqual(readFileSync(join(legacyDir, "pidiff.port"), "utf-8"), "41234");
      assert.strictEqual(readFileSync(join(legacyDir, "pidiff.pid"), "utf-8"), "4321");
      assert.equal(existsSync(join(runDir, "pidiff.port")), false, "no copy written into the run dir");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is false when there is no pid file", () => {
    const dir = mk();
    try {
      assert.equal(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is true for a live pid", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), String(process.pid));
      assert.equal(legacyLockfileOwnerAlive(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is false for pid 0", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), "0");
      assert.equal(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive is false for an unparseable pid", () => {
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), "not-a-pid");
      assert.equal(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive refuses an oversized pid file", () => {
    // The file is project-controlled; a pid is a few bytes, so a large file is not read.
    const dir = mk();
    try {
      writeFileSync(join(dir, "pidiff.pid"), "1".repeat(4096));
      assert.equal(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive refuses a non-regular pid file instead of blocking", () => {
    // The legacy dir is project-controlled: a FIFO here would block the read during the
    // session-start sweep, so only a regular file counts.
    const dir = mk();
    try {
      mkdirSync(join(dir, "pidiff.pid"));
      assert.equal(legacyLockfileOwnerAlive(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacyLockfileOwnerAlive treats EPERM as alive, not dead", () => {
    // Another user's live process answers EPERM, not success. Reading that as "dead" would
    // let the sweep delete a running daemon's control files.
    const dir = mk();
    const original = process.kill;
    try {
      writeFileSync(join(dir, "pidiff.pid"), "424242");
      (process as unknown as { kill: unknown }).kill = () => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      };
      assert.equal(legacyLockfileOwnerAlive(dir), true);
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
      assert.equal(legacyLockfileOwnerAlive(dir), false);
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readLockfile ignores a non-regular port file instead of blocking", () => {
    // The dirs are project-controlled: a FIFO here would block the event loop.
    const dir = mk();
    try {
      mkdirSync(join(dir, "pidiff.port"));
      assert.equal(readLockfile(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isLiveLegacyDaemonFile is true only for a legacy lockfile whose owner is alive", () => {
    const dir = mk();
    try {
      writeLockfile(dir, 41234, process.pid, () => {});
      assert.equal(isLiveLegacyDaemonFile(dir, "pidiff.port"), true);
      assert.equal(isLiveLegacyDaemonFile(dir, "pidiff.pid"), true);
      assert.equal(isLiveLegacyDaemonFile(dir, "reload.flag"), false, "not a lockfile");
      writeFileSync(join(dir, "pidiff.pid"), "0");
      assert.equal(isLiveLegacyDaemonFile(dir, "pidiff.port"), false, "dead owner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the new dir wins when both exist", () => {
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

  it("writing the lockfile never touches the legacy dir", () => {
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

  it("removeLockfile clears the legacy copies too", () => {
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
});

describe("killDaemonByPid", () => {
  it("reads the legacy pid file when the new one is absent", () => {
    const runDir = makeTempDir("dm-test-");
    const legacyDir = makeTempDir("dm-legacy-");
    const legacyPidFile = join(legacyDir, "pidiff.pid");
    try {
      writeFileSync(legacyPidFile, "999999999"); // dead pid
      const killed = killDaemonByPid(join(runDir, "pidiff.pid"), () => {}, legacyPidFile);
      assert.strictEqual(killed, false);
      assert.ok(!existsSync(legacyPidFile), "legacy pid file was read and cleaned up");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
  it("returns false for non-existent pid file", () => {
    const log = () => {};
    const result = killDaemonByPid("/tmp/nonexistent-pid-" + Date.now(), log);
    assert.strictEqual(result, false);
  });

  it("returns false for invalid pid in file", () => {
    const dir = makeTempDir("dm-test-");
    const pidFile = join(dir, "test.pid");
    try {
      writeFileSync(pidFile, "not-a-number");
      const log = () => {};
      const result = killDaemonByPid(pidFile, log);
      assert.strictEqual(result, false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("returns false for dead pid and cleans up file", () => {
    const dir = makeTempDir("dm-test-");
    const pidFile = join(dir, "test.pid");
    try {
      // Use a PID that's almost certainly not running
      writeFileSync(pidFile, "999999999");
      const log = () => {};
      const result = killDaemonByPid(pidFile, log);
      assert.strictEqual(result, false);
      assert.ok(!existsSync(pidFile));
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

describe("findJitiUnder", () => {
  it("walks up from a nested dir to jiti-cli.mjs", () => {
    const root = makeTempDir("jiti-walk-");
    try {
      const cli = join(root, "node_modules", "jiti", "lib", "jiti-cli.mjs");
      mkdirSync(join(root, "node_modules", "jiti", "lib"), { recursive: true });
      writeFileSync(cli, "// stub\n");
      const nested = join(root, "dist", "bundle");
      mkdirSync(nested, { recursive: true });
      assert.strictEqual(findJitiUnder(nested), cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when jiti is absent", () => {
    const root = makeTempDir("jiti-miss-");
    try {
      assert.strictEqual(findJitiUnder(root), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findJitiPath uses argv1 walk, not execPath-adjacent global", () => {
    const root = makeTempDir("jiti-argv-");
    try {
      const cli = join(root, "node_modules", "jiti", "lib", "jiti-cli.mjs");
      mkdirSync(join(root, "node_modules", "jiti", "lib"), { recursive: true });
      writeFileSync(cli, "// stub\n");
      const argv1 = join(root, "dist", "bundle", "cli.js");
      mkdirSync(join(root, "dist", "bundle"), { recursive: true });
      writeFileSync(argv1, "// fake pi\n");
      assert.strictEqual(findJitiPath({ argv1, moduleDir: join(root, "nowhere") }), cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawnDaemon", () => {
  it("refuses to spawn when jiti cannot be resolved", () => {
    const logs: string[] = [];
    spawnDaemon({
      serverScript: "pidash-server.ts",
      logFile: join(tmpdir(), "pidash-spawn-test.log"),
      log: (msg) => logs.push(msg),
      resolveJiti: () => undefined,
    });
    assert.ok(logs.some((m) => m.includes("jiti-cli.mjs not found")));
    assert.ok(!logs.some((m) => m.startsWith("spawning daemon:")));
  });
});

describe("parseHealth", () => {
  it("treats a degraded daemon as running", () => {
    // The regression: a bot-setup failure made callers spawn a second daemon that lost the port.
    const health = parseHealth(JSON.stringify({ status: "degraded", startupError: "discord setup failed", port: 19190 }));
    assert.equal(health.running, true);
    assert.equal(health.degraded, true);
    assert.match(String(health.startupError), /discord setup failed/);
  });

  it("accepts a healthy daemon", () => {
    assert.deepEqual(parseHealth(JSON.stringify({ status: "ok", port: 19190 })), { running: true, degraded: false, startupError: null });
  });

  it("rejects anything that is not a health response", () => {
    assert.equal(parseHealth("not json").running, false);
    assert.equal(parseHealth(JSON.stringify({ status: "stopped" })).running, false);
    assert.equal(parseHealth(JSON.stringify({})).running, false);
  });
});
