/**
 * Peer supervisor shutdown is deterministic: the supervisor waits for its child to exit before it
 * exits itself, so the record always carries both timestamps and a killed peer cannot leave a ghost.
 *
 * The child is a stub `pi` on PATH, so these tests drive the real script without a real peer.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("test-coms-supervisor");
const supervisor = join(process.cwd(), "scripts", "coms-peer-supervisor.mjs");
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throw-away HOME + coms dir + a stub `pi` whose SIGTERM behaviour the test controls. */
function harness({ ignoreSigterm = false, exitAfterMs = 200 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coms-supervisor-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const coms = join(root, "coms");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(coms, { recursive: true });

  // Stub peer as a POSIX shell script: on SIGTERM it leaves a marker and exits after a short delay —
  // or ignores the signal entirely, so only SIGKILL ends it.
  const marker = join(root, "saw-sigterm");
  const stub = ignoreSigterm
    ? `#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 0.1; done\n`
    : `#!/bin/sh\ntrap 'touch ${marker}; sleep 0.3; exit 0' TERM\nwhile :; do sleep 0.1; done\n`;
  writeFileSync(join(bin, "pi"), stub);
  chmodSync(join(bin, "pi"), 0o755);
  log.debug("harness_ready", { root, ignoreSigterm });
  return { root, home, bin, coms, marker };
}

function runSupervisor(h, { timeoutMs = 5000 } = {}) {
  const child = spawn(process.execPath, [supervisor, "peer1", "--project", "proj", "--cwd", h.root], {
    env: { ...process.env, HOME: h.home, PI_COMS_DIR: h.coms, PATH: `${h.bin}:${process.env.PATH}`, PI_COMS_STOP_TIMEOUT_MS: String(timeoutMs) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

const recordPath = (h) => join(h.coms, "peers", "peer1@proj.json");
const readRecord = (h) => JSON.parse(readFileSync(recordPath(h), "utf8"));
const waitFor = async (predicate, timeoutMs = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

describe("coms-peer-supervisor shutdown", () => {
  it("waits for the child, then records both timestamps", async () => {
    const h = harness({ exitAfterMs: 300 });
    const child = runSupervisor(h);
    assert.equal(await waitFor(() => existsSync(recordPath(h))), true, "the supervisor records the peer on spawn");

    child.kill("SIGTERM");
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const code = await exited;
    assert.equal(code, 0, "a clean stop exits 0");

    const record = readRecord(h);
    assert.ok(record.stoppedAt, "stoppedAt is recorded");
    assert.ok(record.exitedAt, "exitedAt is recorded — the supervisor waited instead of exiting first");
    assert.equal(existsSync(h.marker), true, "the stub saw SIGTERM");
    assert.ok(new Date(record.exitedAt) >= new Date(record.stoppedAt), "exitedAt does not precede stoppedAt");
    assert.equal(record.forced, undefined, "a peer that exits on SIGTERM is not marked forced");
    log.info("clean_stop_verified", { stoppedAt: record.stoppedAt, exitedAt: record.exitedAt });
  });

  it("escalates to SIGKILL and marks the record forced", async () => {
    const h = harness({ ignoreSigterm: true });
    const child = runSupervisor(h, { timeoutMs: 300 });
    assert.equal(await waitFor(() => existsSync(recordPath(h))), true);

    child.kill("SIGTERM");
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const code = await exited;
    assert.equal(code, 0, "the supervisor reports the outcome it produced");

    const record = readRecord(h);
    assert.equal(record.forced, true, "a peer that ignored SIGTERM is marked forced");
    assert.equal(record.exitSignal, "SIGKILL");
    assert.ok(record.exitedAt, "exitedAt is recorded");
    log.info("forced_stop_verified", { exitSignal: record.exitSignal });
  });
});
