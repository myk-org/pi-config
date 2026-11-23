import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { describe, it, afterEach } from "node:test";
import {
  acquireSpawnLocks,
  evaluateSpawnLock,
  findFreePort,
  findRunningPidiffPort,
  releaseSpawnLocks,
  writeLockfile,
} from "../../../extensions/pidiff/lockfile.js";
import { getProjectLegacyRunDir, getProjectRunDir } from "../../../extensions/orchestrator/utils.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("pidiff stale lock detection", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = undefined;
    }
  });

  it("dead PID triggers recover action", () => {
    tmpDir = makeTempDir("pidiff-lock-");
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, "99999999");

    const result = evaluateSpawnLock(lockPath, 60000);
    assert.equal(result.action, "recover");
    assert.match(result.reason, /dead/);
  });

  it("alive PID with young lock triggers wait action", () => {
    tmpDir = makeTempDir("pidiff-lock-");
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, String(process.pid));

    const result = evaluateSpawnLock(lockPath, 60000);
    assert.equal(result.action, "wait");
    assert.match(result.reason, /alive/);
  });

  it("no valid PID with old lock triggers recover", () => {
    tmpDir = makeTempDir("pidiff-lock-");
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, "not-a-pid");
    const twoSecsAgo = new Date(Date.now() - 2000);
    utimesSync(lockPath, twoSecsAgo, twoSecsAgo);

    const result = evaluateSpawnLock(lockPath, 500);
    assert.equal(result.action, "recover");
    assert.match(result.reason, /no valid PID/);
  });

  it("missing lockfile triggers recover", () => {
    tmpDir = makeTempDir("pidiff-lock-");
    const lockPath = join(tmpDir, "pidiff.spawning.nonexistent");

    const result = evaluateSpawnLock(lockPath, 60000);
    assert.equal(result.action, "recover");
    assert.match(result.reason, /cannot read/);
  });

  it("alive PID with very old lock triggers PID reuse recovery", () => {
    tmpDir = makeTempDir("pidiff-lock-");
    const lockPath = join(tmpDir, "pidiff.spawning");
    writeFileSync(lockPath, String(process.pid));
    const twoSecsAgo = new Date(Date.now() - 2000);
    utimesSync(lockPath, twoSecsAgo, twoSecsAgo);

    const result = evaluateSpawnLock(lockPath, 500);
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
    dirs = Array.from({ length: n }, () => makeTempDir("pidiff-spawn-"));
    return dirs;
  };

  it("acquires the lock across every existing dir", () => {
    const [legacy, run] = mkDirs(2);
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, null);
    assert.deepEqual(held, [join(legacy, "pidiff.spawning"), join(run, "pidiff.spawning")]);
    assert.equal(readFileSync(join(run, "pidiff.spawning"), "utf-8"), String(process.pid));
    releaseSpawnLocks(held);
    assert.ok(!existsSync(join(legacy, "pidiff.spawning")), "release clears the legacy lock");
    assert.ok(!existsSync(join(run, "pidiff.spawning")), "release clears the new lock");
  });

  it("reports the legacy lock as contended when a pre-#1020 session holds it", () => {
    const [legacy, run] = mkDirs(2);
    writeFileSync(join(legacy, "pidiff.spawning"), String(process.pid));
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, join(legacy, "pidiff.spawning"));
    assert.deepEqual(held, []);
    assert.ok(!existsSync(join(run, "pidiff.spawning")), "no new-dir lock is taken while waiting");
  });

  it("skips a missing legacy dir instead of reporting contention", () => {
    const [run] = mkDirs(1);
    const legacy = join(run, "missing-legacy");
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, null, "a missing legacy dir is not lock contention");
    assert.deepEqual(held, [join(run, "pidiff.spawning")]);
    assert.ok(!existsSync(legacy), "the legacy dir is not created just to take the lock");
    releaseSpawnLocks(held);
  });

  it("releases an earlier lock when a later dir is contended", () => {
    const [legacy, run] = mkDirs(2);
    writeFileSync(join(run, "pidiff.spawning"), String(process.pid));
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, join(run, "pidiff.spawning"));
    assert.deepEqual(held, []);
    assert.ok(!existsSync(join(legacy, "pidiff.spawning")), "the legacy lock is not left behind");
  });
});

describe("findRunningPidiffPort across .pi/run and legacy .pi/tmp (#1024)", () => {
  let server: Server | undefined;
  let dirs: string[] = [];

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs = [];
  });

  const listenHealthy = async (): Promise<number> => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as { port: number }).port;
  };

  const mkDir = (prefix: string): string => {
    const dir = makeTempDir(prefix);
    dirs.push(dir);
    return dir;
  };

  it("returns the live legacy port when the .pi/run record is stale", async () => {
    const livePort = await listenHealthy();
    const runDir = mkDir("pidiff-start-run-");
    const legacyDir = mkDir("pidiff-start-legacy-");
    writeLockfile(runDir, await findFreePort(), null, () => {});
    writeLockfile(legacyDir, livePort, null, () => {});

    assert.equal(
      await findRunningPidiffPort(runDir, legacyDir),
      livePort,
      "the live legacy daemon is reused — no duplicate spawn on the same port",
    );
  });

  it("prefers the session's known port when it is healthy", async () => {
    const livePort = await listenHealthy();
    const runDir = mkDir("pidiff-start-run-");
    writeLockfile(runDir, await findFreePort(), null, () => {});

    assert.equal(await findRunningPidiffPort(runDir, "", livePort), livePort);
  });

  it("returns null when no recorded port answers health", async () => {
    const runDir = mkDir("pidiff-start-run-");
    writeLockfile(runDir, await findFreePort(), null, () => {});

    assert.equal(await findRunningPidiffPort(runDir, "", 0), null);
  });

  it("keeps pidiff control files in .pi/run, outside the swept .pi/tmp (#1020)", () => {
    const cwd = mkDir("pidiff-home-");
    const runDir = getProjectRunDir(cwd);
    writeLockfile(runDir, 12345, process.pid, () => {});

    assert.equal(runDir, join(cwd, ".pi", "run"));
    assert.ok(existsSync(join(runDir, "pidiff.port")), "port lives in .pi/run");
    assert.ok(existsSync(join(runDir, "pidiff.pid")), "pid lives in .pi/run");
    assert.equal(
      existsSync(join(getProjectLegacyRunDir(cwd), "pidiff.port")),
      false,
      "the swept dir is not the control-file home",
    );
  });
});
