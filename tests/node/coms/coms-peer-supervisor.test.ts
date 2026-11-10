/**
 * Peer supervisor shutdown is deterministic: the supervisor waits for its child to exit before it
 * exits itself, so the record always carries both timestamps and a killed peer cannot leave a ghost.
 *
 * The child is a stub `pi` on PATH, so these tests drive the real script without a real peer. Each
 * stub writes a READY marker once its trap is installed, so a test never signals the supervisor
 * before the child is armed.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

const supervisor = join(process.cwd(), "scripts", "coms-peer-supervisor.mjs");
const roots = [];
const children = [];

after(() => {
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throw-away HOME + coms dir + a stub `pi` whose SIGTERM behaviour the test controls. */
function harness({ ignoreSigterm = false, exitAfterMs = 200 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coms-supervisor-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const coms = join(root, "coms");
  const marker = join(root, "saw-sigterm");
  const ready = join(root, "ready");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(coms, { recursive: true });

  const trap = ignoreSigterm ? "trap '' TERM" : `trap 'touch ${marker}; sleep ${exitAfterMs / 1000}; exit 0' TERM`;
  writeFileSync(join(bin, "pi"), `#!/bin/sh\n${trap}\ntouch ${ready}\nwhile :; do sleep 0.05; done\n`);
  chmodSync(join(bin, "pi"), 0o755);
  return { root, home, bin, coms, marker, ready };
}

function runSupervisor(h, { timeoutMs = 5000 } = {}) {
  const child = spawn(process.execPath, [supervisor, "peer1", "--project", "proj", "--cwd", h.root], {
    env: {
      ...process.env,
      HOME: h.home,
      PI_COMS_DIR: h.coms,
      PATH: `${h.bin}:${process.env.PATH}`,
      PI_COMS_STOP_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

const recordPath = (h) => join(h.coms, "peers", "peer1@proj.json");
const peerLog = (h) => join(h.home, ".pi", "logs", "coms-peers", "peer1@proj.log");
const readRecord = (h) => JSON.parse(readFileSync(recordPath(h), "utf8"));

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Start a peer and wait until its record exists AND its stub has armed its trap. */
async function startedPeer(h, opts) {
  const child = runSupervisor(h, opts);
  assert.equal(await waitFor(() => existsSync(recordPath(h))), true, "the supervisor records the peer on spawn");
  assert.equal(await waitFor(() => existsSync(h.ready)), true, "the stub armed its SIGTERM trap");
  return child;
}

/** Signal the supervisor and resolve with its exit code. */
function stopAndWait(child, signal = "SIGTERM") {
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill(signal);
  return exited;
}

describe("coms-peer-supervisor shutdown", () => {
  it("waits for the child before recording the stop", async () => {
    const h = harness({ exitAfterMs: 300 });
    const child = await startedPeer(h);
    assert.equal(await stopAndWait(child), 0);

    const record = readRecord(h);
    assert.ok(record.stoppedAt, "stoppedAt is recorded");
    assert.ok(record.exitedAt, "exitedAt is recorded — the supervisor waited instead of exiting first");
    assert.ok(new Date(record.exitedAt) >= new Date(record.stoppedAt), "exitedAt does not precede stoppedAt");
    assert.equal(record.forced, undefined, "a peer that exits on SIGTERM is not forced");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const h = harness({ ignoreSigterm: true });
    const child = await startedPeer(h, { timeoutMs: 300 });
    assert.equal(await stopAndWait(child), 0);
    assert.equal(readRecord(h).exitSignal, "SIGKILL");
  });

  it("records a forced stop", async () => {
    const h = harness({ ignoreSigterm: true });
    const child = await startedPeer(h, { timeoutMs: 300 });
    assert.equal(await stopAndWait(child), 0);
    assert.equal(readRecord(h).forced, true);
  });

  it("treats an invalid timeout as the default instead of cutting cleanup short", async () => {
    const h = harness({ exitAfterMs: 200 });
    const child = await startedPeer(h, { timeoutMs: "not-a-number" });
    assert.equal(await stopAndWait(child), 0);

    const record = readRecord(h);
    assert.ok(record.exitedAt, "the wait still happened");
    assert.equal(record.forced, undefined, "a cooperating peer is not killed for a bad override");
  });

  it("handles a repeated stop signal once", async () => {
    const h = harness({ exitAfterMs: 300 });
    const child = await startedPeer(h);
    child.kill("SIGTERM");
    child.kill("SIGTERM"); // second signal must not restart the wait or double-record
    await new Promise((resolve) => child.on("exit", resolve));

    const stops = readFileSync(peerLog(h), "utf8").split("\n").filter((line) => line.includes("stopping"));
    assert.equal(stops.length, 1, "the second signal is ignored");
    assert.equal(readRecord(h).forced, undefined);
  });

  it("does not overwrite a record owned by a newer supervisor", async () => {
    const h = harness({ exitAfterMs: 200 });
    const child = await startedPeer(h);
    // A replacement peer already owns this name+project before the old one finished exiting.
    const replacement = { cname: "peer1", project: "proj", pid: 999999, childPid: 999998, startedAt: new Date().toISOString() };
    writeFileSync(recordPath(h), JSON.stringify(replacement, null, 2));

    assert.equal(await stopAndWait(child), 0);
    assert.equal(readRecord(h).pid, 999999, "the newer supervisor's live record survives");
  });
});
