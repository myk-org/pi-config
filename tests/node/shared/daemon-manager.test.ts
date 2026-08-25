/**
 * Tests for daemon-manager lockfile and port helpers.
 * Run with: npx tsx --test tests/node/shared/daemon-manager.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeLockfile, readLockfile, removeLockfile, findFreePort, killDaemonByPid, findJitiUnder, findJitiPath, spawnDaemon } from "../../../extensions/shared/daemon-manager.js";

describe("lockfile operations", () => {
  it("stores port and pid via writeLockfile, retrieves via readLockfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
    try {
      const log = () => {};
      removeLockfile(dir, log); // should not throw
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe("killDaemonByPid", () => {
  it("returns false for non-existent pid file", () => {
    const log = () => {};
    const result = killDaemonByPid("/tmp/nonexistent-pid-" + Date.now(), log);
    assert.strictEqual(result, false);
  });

  it("returns false for invalid pid in file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
    const pidFile = join(dir, "test.pid");
    try {
      writeFileSync(pidFile, "not-a-number");
      const log = () => {};
      const result = killDaemonByPid(pidFile, log);
      assert.strictEqual(result, false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("returns false for dead pid and cleans up file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-test-"));
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
    const root = mkdtempSync(join(tmpdir(), "jiti-walk-"));
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
    const root = mkdtempSync(join(tmpdir(), "jiti-miss-"));
    try {
      assert.strictEqual(findJitiUnder(root), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findJitiPath uses argv1 walk, not execPath-adjacent global", () => {
    const root = mkdtempSync(join(tmpdir(), "jiti-argv-"));
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
