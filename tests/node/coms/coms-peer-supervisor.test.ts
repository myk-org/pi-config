/**
 * Peer supervisor shutdown is deterministic: the supervisor waits for its child to exit before it
 * exits itself, so the record always carries both timestamps and a killed peer cannot leave a ghost.
 *
 * The child is a stub `pi` on PATH, so these tests drive the real script without a real peer. Each
 * stub writes a READY marker once its trap is installed, so a test never signals the supervisor
 * before the child is armed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

const supervisor = join(process.cwd(), "scripts", "coms-peer-supervisor.mjs");
const roots: string[] = [];
const children: ChildProcess[] = [];

after(() => {
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  root: string;
  home: string;
  bin: string;
  coms: string;
  marker: string;
  ready: string;
  envFile: string;
  agentDirFile: string;
}

/** A throw-away HOME + coms dir + a stub `pi` whose SIGTERM behaviour the test controls. */
function harness({ ignoreSigterm = false, exitAfterMs = 200 }: { ignoreSigterm?: boolean; exitAfterMs?: number } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "coms-supervisor-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const coms = join(root, "coms");
  const marker = join(root, "saw-sigterm");
  const ready = join(root, "ready");
  const envFile = join(root, "child-env.txt");
  const agentDirFile = join(root, "child-agent-dir.txt");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(coms, { recursive: true });

  const trap = ignoreSigterm ? "trap '' TERM" : `trap 'touch ${marker}; sleep ${exitAfterMs / 1000}; exit 0' TERM`;
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh\n${trap}\nprintf '%s' "$PI_COMS_SUPERVISED_PEER" > "${envFile}"\nprintf '%s' "\${PI_CODING_AGENT_DIR-<unset>}" > "${agentDirFile}"\ntouch ${ready}\nwhile :; do sleep 0.05; done\n`,
  );
  chmodSync(join(bin, "pi"), 0o755);
  return { root, home, bin, coms, marker, ready, envFile, agentDirFile };
}

/** `timeoutMs` reaches the supervisor as the string env var, so a test may pass garbage there. */
function runSupervisor(
  h: Harness,
  {
    timeoutMs = 5000,
    extraArgs = [],
    envOverrides = {},
  }: {
    timeoutMs?: number | string;
    extraArgs?: string[];
    envOverrides?: Record<string, string | undefined>;
  } = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: h.home,
    PI_COMS_DIR: h.coms,
    PATH: `${h.bin}:${process.env.PATH}`,
    PI_COMS_STOP_TIMEOUT_MS: String(timeoutMs),
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(
    process.execPath,
    [supervisor, "peer1", "--project", "proj", "--cwd", h.root, ...extraArgs],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  return child;
}

const recordPath = (h: Harness) => join(h.coms, "peers", "peer1@proj.json");
const peerLog = (h: Harness) => join(h.home, ".pi", "logs", "coms-peers", "peer1@proj.log");
const readRecord = (h: Harness) => JSON.parse(readFileSync(recordPath(h), "utf8"));

async function waitFor(predicate: () => boolean, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Start a peer and wait until its record exists AND its stub has armed its trap. */
async function startedPeer(
  h: Harness,
  opts?: {
    timeoutMs?: number | string;
    extraArgs?: string[];
    envOverrides?: Record<string, string | undefined>;
  },
) {
  const child = runSupervisor(h, opts);
  assert.equal(await waitFor(() => existsSync(recordPath(h))), true, "the supervisor records the peer on spawn");
  assert.equal(await waitFor(() => existsSync(h.ready)), true, "the stub armed its SIGTERM trap");
  return child;
}

/** Signal the supervisor and resolve with its exit code. */
function stopAndWait(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
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

  it("#1403: sets PI_COMS_SUPERVISED_PEER=1 on spawned child env without mutating spawner env", async () => {
    const previous = process.env.PI_COMS_SUPERVISED_PEER;
    delete process.env.PI_COMS_SUPERVISED_PEER;
    try {
      const h = harness({ exitAfterMs: 100 });
      const child = await startedPeer(h);
      assert.equal(readFileSync(h.envFile, "utf8"), "1", "child pi process receives PI_COMS_SUPERVISED_PEER=1");
      assert.equal(process.env.PI_COMS_SUPERVISED_PEER, undefined, "spawner env remains untouched");
      assert.equal(await stopAndWait(child), 0);
    } finally {
      if (previous === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
      else process.env.PI_COMS_SUPERVISED_PEER = previous;
    }
  });

  it("#1490: forwards --agent-dir CLI flag to spawned peer as PI_CODING_AGENT_DIR and logs it", async () => {
    const h = harness({ exitAfterMs: 100 });
    const child = await startedPeer(h, {
      extraArgs: ["--agent-dir", "/custom/peer-agent"],
      envOverrides: { PI_CODING_AGENT_DIR: undefined },
    });
    assert.equal(readFileSync(h.agentDirFile, "utf8"), "/custom/peer-agent");
    const peerLog = readFileSync(join(h.home, ".pi", "logs", "coms-peers", "peer1@proj.log"), "utf8");
    assert.match(peerLog, /peer peer1 using agent dir \/custom\/peer-agent/);
    assert.equal(await stopAndWait(child), 0);
  });

  it("#1490: forwards --agent-dir equals form to spawned peer as PI_CODING_AGENT_DIR", async () => {
    const h = harness({ exitAfterMs: 100 });
    const child = await startedPeer(h, {
      extraArgs: ["--agent-dir=/custom/equals-peer-agent"],
      envOverrides: { PI_CODING_AGENT_DIR: "/env/overridden" },
    });
    assert.equal(readFileSync(h.agentDirFile, "utf8"), "/custom/equals-peer-agent");
    assert.equal(await stopAndWait(child), 0);
  });

  it("#1490: preserves inherited PI_CODING_AGENT_DIR on spawned peer", async () => {
    const h = harness({ exitAfterMs: 100 });
    const child = await startedPeer(h, {
      envOverrides: { PI_CODING_AGENT_DIR: "/inherited/peer-agent" },
    });
    assert.equal(readFileSync(h.agentDirFile, "utf8"), "/inherited/peer-agent");
    assert.equal(await stopAndWait(child), 0);
  });

  it("#1490: omits PI_CODING_AGENT_DIR on spawned peer when unconfigured", async () => {
    const h = harness({ exitAfterMs: 100 });
    const child = await startedPeer(h, {
      envOverrides: { PI_CODING_AGENT_DIR: undefined },
    });
    assert.equal(readFileSync(h.agentDirFile, "utf8"), "<unset>");
    const peerLog = readFileSync(join(h.home, ".pi", "logs", "coms-peers", "peer1@proj.log"), "utf8");
    assert.doesNotMatch(peerLog, /using agent dir/);
    assert.equal(await stopAndWait(child), 0);
  });

  it("#1490: ignores --agent-dir=... consumed as the value of --purpose", async () => {
    const h = harness({ exitAfterMs: 100 });
    const child = await startedPeer(h, {
      extraArgs: ["--purpose", "--agent-dir=/fake/peer-agent"],
      envOverrides: { PI_CODING_AGENT_DIR: undefined },
    });
    assert.equal(readFileSync(h.agentDirFile, "utf8"), "<unset>");
    assert.equal(await stopAndWait(child), 0);
  });
});
