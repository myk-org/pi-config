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
import { createServer, type Server } from "node:http";
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

  it("skips a legacy dir that does not exist instead of reporting contention", async () => {
    const { acquireSpawnLocks, releaseSpawnLocks } = await import(
      `../../../extensions/pidiff/spawn-lock.ts?t=${Date.now() + 13}`
    );
    // Fresh project: `.pi/tmp` was never created (only `.pi/run` is).
    const [run] = mkDirs(1);
    const legacy = join(run, "missing-legacy");
    const { held, contended } = acquireSpawnLocks([legacy, run]);
    assert.equal(contended, null, "a missing legacy dir is not lock contention");
    assert.deepEqual(held, [join(run, "pidiff.spawning")]);
    assert.ok(!existsSync(legacy), "the legacy dir is not created just to take the lock");
    releaseSpawnLocks(held);
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

/** `/pidiff start` and connect() share this probe: a stale `.pi/run` record must
 *  never hide the live pre-#1020 daemon in `.pi/tmp` — `start` would spawn a
 *  duplicate on top of it (#1024, Qodo). */
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
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  it("returns the live legacy port when the `.pi/run` record is stale", async () => {
    const { findRunningPidiffPort } = await import(
      `../../../extensions/pidiff/pidiff.ts?t=${Date.now() + 20}`
    );
    const { writeLockfile, findFreePort } = await import(
      `../../../extensions/shared/daemon-manager.ts?t=${Date.now() + 21}`
    );
    const livePort = await listenHealthy();
    const runDir = mkDir("pidiff-start-run-");
    const legacyDir = mkDir("pidiff-start-legacy-");
    writeLockfile(runDir, await findFreePort(), null, () => {}); // stale: nothing listens
    writeLockfile(legacyDir, livePort, null, () => {}); // daemon started pre-#1020

    assert.equal(
      await findRunningPidiffPort(runDir, legacyDir),
      livePort,
      "the live legacy daemon is reused — no duplicate spawn on the same port",
    );
  });

  it("prefers the session's known port when it is healthy", async () => {
    const { findRunningPidiffPort } = await import(
      `../../../extensions/pidiff/pidiff.ts?t=${Date.now() + 22}`
    );
    const { writeLockfile, findFreePort } = await import(
      `../../../extensions/shared/daemon-manager.ts?t=${Date.now() + 23}`
    );
    const livePort = await listenHealthy();
    const runDir = mkDir("pidiff-start-run-");
    writeLockfile(runDir, await findFreePort(), null, () => {});

    assert.equal(await findRunningPidiffPort(runDir, "", livePort), livePort);
  });

  it("returns null when no recorded port answers health", async () => {
    const { findRunningPidiffPort } = await import(
      `../../../extensions/pidiff/pidiff.ts?t=${Date.now() + 24}`
    );
    const { writeLockfile, findFreePort } = await import(
      `../../../extensions/shared/daemon-manager.ts?t=${Date.now() + 25}`
    );
    const runDir = mkDir("pidiff-start-run-");
    writeLockfile(runDir, await findFreePort(), null, () => {});

    assert.equal(await findRunningPidiffPort(runDir, "", 0), null);
  });

  it("keeps pidiff control files in `.pi/run`, outside the swept `.pi/tmp` (#1020)", async () => {
    const { writeLockfile } = await import(
      `../../../extensions/shared/daemon-manager.ts?t=${Date.now() + 26}`
    );
    const { getProjectRunDir, getProjectLegacyRunDir } = await import(
      `../../../extensions/orchestrator/utils.ts?t=${Date.now() + 27}`
    );
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
