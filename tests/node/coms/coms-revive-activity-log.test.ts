/**
 * Unit tests for #1417: `/coms` stopped-peer revive (`r`), supervisor `--session` resume,
 * unified live Activity Log (`1`/`2`), and cross-project history routing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildPeerSpawn,
  collectComsActivityEvents,
  formatComsPeersPlainText,
  listStoppedSupervisedPeers,
  type RegistryRow,
  type SupervisionRecord,
} from "../../../extensions/coms/coms-peers.js";
import { openComsPeersOverlay, REVIVE_PENDING_TTL_MS } from "../../../extensions/coms/coms-peers-ui.js";
import { createComsPeerRuntime } from "../../../extensions/coms/coms-p2p.js";
import { ComsRegistry } from "../../../extensions/coms/coms-registry.js";
import {
  createTailHistoryReader,
  readRecentHistoryRecords,
  type HistoryRecord,
} from "../../../extensions/coms/coms-history.js";
import { fakeCommandCtx, fakeCustom, type FakeCustomFactory } from "../helpers/fake-extension-ctx.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

after(() => {
  for (const child of spawnedChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const livePeer: RegistryRow = {
  project: "repo",
  name: "alpha",
  pid: 4242,
  cwd: "/repo",
  purpose: "active worker",
  endpoint: "/tmp/alpha.sock",
  busy: false,
  queueDepth: 0,
  contextUsedPct: 25,
  startedAt: "2026-11-26T10:00:00.000Z",
  heartbeatAt: "2026-11-26T10:01:00.000Z",
  origin: "cli",
  createdBy: "agent",
  piSessionId: "sess-alpha",
};

const stoppedPeer: RegistryRow = {
  project: "repo",
  name: "beta",
  pid: null,
  cwd: "/repo/wt-beta",
  purpose: "stopped worker",
  endpoint: "",
  busy: false,
  queueDepth: null,
  contextUsedPct: null,
  startedAt: "2026-11-26T09:00:00.000Z",
  heartbeatAt: null,
  origin: null,
  createdBy: "agent",
  piSessionId: "sess-beta-123",
  stopped: true,
  stoppedAt: "2026-11-26T09:30:00.000Z",
  exitCode: 0,
};

function makeUi(scripts: string[][], width = 100) {
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const frames: string[][] = [];
  let opened = 0;
  const custom = (<T,>(factory: FakeCustomFactory<T>) => {
    const idx = opened++;
    const keys = scripts[idx] ?? ["close"];
    frames[idx] = [];
    return fakeCustom(factory, keys, {
      onOpen: (comp) => {
        frames[idx].push((comp.render?.(width) ?? []).join("\n"));
      },
      onKey: (_k, _d, comp) => {
        frames[idx].push((comp.render?.(width) ?? []).join("\n"));
      },
    });
  }) satisfies ExtensionUIContext["custom"];

  return {
    notifications,
    frames,
    openedCount: () => opened,
    ctx: fakeCommandCtx({
      notify: (message: string, level?: "info" | "warning" | "error") => {
        notifications.push({ message, level });
      },
      custom,
    }),
  };
}

function makeNamesakeFixture() {
  const repoAPeer: RegistryRow = { ...livePeer, project: "repo-a", name: "worker", endpoint: "/tmp/a.sock" };
  const repoBPeer: RegistryRow = { ...livePeer, project: "repo-b", name: "worker", endpoint: "/tmp/b.sock" };
  const history: HistoryRecord[] = [
    { ts: "2026-11-26T10:01:00.000Z", msg_id: "m-a", direction: "out", peer: "worker", project: "repo-a", peer_project: "repo-a", preview: "Secret A" },
    { ts: "2026-11-26T10:02:00.000Z", msg_id: "m-b", direction: "out", peer: "worker", project: "repo-b", peer_project: "repo-b", preview: "Secret B" },
    { ts: "2026-11-26T10:02:30.000Z", msg_id: "m-in-remote", direction: "in", peer: "worker", project: "repo-a", preview: "From remote namesake" },
    { ts: "2026-11-26T10:02:45.000Z", msg_id: "m-xproj", direction: "out", peer: "worker", project: "repo-a", peer_project: "repo-b", preview: "Cross-project send" },
    { ts: "2026-11-26T10:03:00.000Z", msg_id: "m-legacy", direction: "out", peer: "worker", preview: "Legacy untagged" },
  ];
  return { repoAPeer, repoBPeer, history };
}

describe("listStoppedSupervisedPeers / buildPeerSpawn (#1417)", () => {
  it("lists stopped supervised peers excluding live ones with newest session metadata", () => {
    const records: SupervisionRecord[] = [
      { cname: "alpha", project: "repo", cwd: "/repo", purpose: "live now", exitedAt: "2026-11-26T09:00:00.000Z" },
      { cname: "beta", project: "repo", cwd: "/repo/old", purpose: "older stop", exitedAt: "2026-11-26T09:10:00.000Z" },
      { cname: "beta", project: "repo", cwd: "/repo/new", purpose: "newer stop", piSessionId: "sess-beta-latest", exitedAt: "2026-11-26T09:40:00.000Z", exitCode: 0 },
      { cname: "gamma", project: "other", cwd: "/other", purpose: "other project", failedAt: "2026-11-26T09:50:00.000Z", exitCode: 1 },
    ];

    const repoStopped = listStoppedSupervisedPeers(records, [livePeer], { project: "repo" });
    assert.equal(repoStopped.length, 1);
    assert.equal(repoStopped[0].name, "beta");
    assert.equal(repoStopped[0].cwd, "/repo/new");
    assert.equal(repoStopped[0].piSessionId, "sess-beta-latest");
    assert.equal(repoStopped[0].stopped, true);

    const allStopped = listStoppedSupervisedPeers(records, [livePeer]);
    assert.deepEqual(allStopped.map((r) => r.name), ["gamma", "beta"]);
  });

  it("includes --session in buildPeerSpawn", () => {
    const ok = buildPeerSpawn("/path/to/supervisor.mjs", {
      cname: "beta",
      project: "repo",
      cwd: "/repo",
      purpose: "work",
      session: "sess-beta-123",
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const idx = ok.command.indexOf("--session");
      assert.ok(idx > 0);
      assert.equal(ok.command[idx + 1], "sess-beta-123");
    }
  });

  it("rejects control characters in buildPeerSpawn session", () => {
    const bad = buildPeerSpawn("/path/to/supervisor.mjs", {
      cname: "beta",
      session: "bad\nsession",
    });
    assert.equal(bad.ok, false);
  });
});

describe("coms-peer-supervisor --session preservation (#1417)", () => {
  it("forwards --session to pi while preserving piSessionId across shutdown", async () => {
    const root = makeTempDir("coms-sup-session-");
    tempDirs.push(root);
    const home = join(root, "home");
    const bin = join(root, "bin");
    const coms = join(root, "coms");
    const argsFile = join(root, "pi-args.txt");
    const ready = join(root, "ready");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(coms, { recursive: true });

    writeFileSync(
      join(bin, "pi"),
      `#!/bin/sh\ntrap 'exit 0' TERM\nprintf '%s\\n' "$@" > "${argsFile}"\ntouch "${ready}"\nwhile :; do sleep 0.05; done\n`,
    );
    chmodSync(join(bin, "pi"), 0o755);

    const supervisor = join(process.cwd(), "scripts", "coms-peer-supervisor.mjs");
    const child = spawn(
      process.execPath,
      [supervisor, "revived-peer", "--project", "proj", "--cwd", root, "--session", "sess-resume-42"],
      {
        env: {
          ...process.env,
          HOME: home,
          PI_COMS_DIR: coms,
          PATH: `${bin}:${process.env.PATH}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    spawnedChildren.push(child);

    const statePath = join(coms, "peers", "revived-peer@proj.json");
    const started = Date.now();
    while (Date.now() - started < 8000 && (!existsSync(statePath) || !existsSync(ready))) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(existsSync(statePath), true);
    assert.equal(existsSync(ready), true);

    const piArgs = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    const sessIdx = piArgs.indexOf("--session");
    assert.ok(sessIdx >= 0, "supervisor forwards --session to child pi");
    assert.equal(piArgs[sessIdx + 1], "sess-resume-42");

    const liveState = JSON.parse(readFileSync(statePath, "utf8"));
    liveState.piSessionId = "live-pi-session-99";
    writeFileSync(statePath, JSON.stringify(liveState, null, 2));

    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);

    const finalState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(finalState.session, "sess-resume-42");
    assert.equal(finalState.piSessionId, "live-pi-session-99");
    assert.ok(finalState.stoppedAt);
    assert.ok(finalState.exitedAt);
  });
});

describe("/coms revive (`r`) overlay behavior (#1417)", () => {
  it("revives a stopped supervised peer on Kitty CSI-u `r` while refusing live peers", async () => {
    const h = makeUi([["r", "j", "\x1b[114u", "close"]]);
    const revived: RegistryRow[] = [];

    await openComsPeersOverlay(h.ctx, {
      listPeers: () => [livePeer],
      listStoppedPeers: () => [stoppedPeer],
      revivePeer: (row) => {
        revived.push(row);
        return { ok: true, pid: 7777, message: `Reviving "${row.name}" (pid 7777) · session resumed` };
      },
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.equal(revived.length, 1);
    assert.equal(revived[0].name, "beta");
    assert.equal(revived[0].piSessionId, "sess-beta-123");
    assert.equal(h.notifications.length, 2);
    assert.match(h.notifications[0].message, /already running/);
    assert.match(h.notifications[1].message, /Reviving "beta"/);
    assert.match(h.frames[0][h.frames[0].length - 1], /ℹ Reviving "beta"/);
  });

  it("guards `x` kill on stopped peers without calling describePeer on Enter", async () => {
    const h = makeUi([["x", "\r"], ["\x1b"], ["close"]]);
    let killCalls = 0;
    let describeCalls = 0;

    await openComsPeersOverlay(h.ctx, {
      listPeers: () => [],
      listStoppedPeers: () => [stoppedPeer],
      revivePeer: () => ({ ok: true, message: "revived" }),
      describePeer: async () => {
        describeCalls++;
        return { ok: false, reason: "not-reported" };
      },
      killPeer: () => {
        killCalls++;
        return "killed";
      },
      killAll: () => "killed all",
    });

    assert.equal(killCalls, 0);
    assert.equal(describeCalls, 0);
    assert.match(h.notifications[0]?.message ?? "", /already stopped/);
    assert.match(h.frames[1][0], /sess-beta-123/);
    assert.match(h.frames[1][0], /\/repo\/wt-beta/);
  });

  it("prevents duplicate supervisor launches on repeated `r` presses (Qodo #9)", async () => {
    const h = makeUi([["\r"], ["r"], ["r", "close"]]);
    let reviveCalls = 0;

    await openComsPeersOverlay(h.ctx, {
      listPeers: () => [],
      listStoppedPeers: () => [stoppedPeer],
      revivePeer: () => {
        reviveCalls++;
        return { ok: true, pid: 8888, message: 'Reviving "beta" (pid 8888)' };
      },
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.equal(reviveCalls, 1, "repeated r across detail and roster must launch supervisor only once");
    assert.match(h.frames[2][0], /reviving…/);
    assert.ok(h.notifications.some((n) => /already reviving/.test(n.message)));
  });

  it("reports skipped stopped peers when messaging a mixed selection (Qodo #10)", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const sent: Array<{ target: string; prompt: string }> = [];
    let opened = 0;
    const custom = (<T,>(factory: FakeCustomFactory<T>) => {
      opened++;
      if (opened > 1) return Promise.resolve(null as never);
      return fakeCustom(factory, [" ", "j", " ", "m"]);
    }) satisfies ExtensionUIContext["custom"];

    const ctx = fakeCommandCtx({
      notify: (message: string, level?: "info" | "warning" | "error") => { notifications.push({ message, level }); },
      input: async () => "hello team",
      custom,
    });

    await openComsPeersOverlay(ctx, {
      listPeers: () => [livePeer],
      listStoppedPeers: () => [stoppedPeer],
      tellPeer: async (req) => {
        sent.push({ target: req.target, prompt: req.prompt });
        return { ok: true };
      },
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.deepEqual(sent, [{ target: "alpha", prompt: "hello team" }]);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.match(notifications[0].message, /sent 1 of 2/);
    assert.match(notifications[0].message, /skipped 1 stopped peer \(beta/);
  });

  it("expires stalled pending revives after TTL so retry succeeds (Qodo C2 #5)", async () => {
    let clock = Date.parse(stoppedPeer.stoppedAt!) + 60_000;
    let reviveCalls = 0;
    const h = makeUi([["r", "r", "\r"], ["\x1b"], ["r", "close"]]);

    const origCustom = h.ctx.ui.custom;
    let opens = 0;
    h.ctx.ui.custom = (<T,>(factory: FakeCustomFactory<T>) => {
      opens++;
      if (opens === 3) clock += REVIVE_PENDING_TTL_MS + 1000;
      return origCustom(factory as any);
    }) satisfies ExtensionUIContext["custom"];

    await openComsPeersOverlay(h.ctx, {
      listPeers: () => [],
      listStoppedPeers: () => [stoppedPeer],
      now: () => clock,
      revivePeer: () => {
        reviveCalls++;
        return { ok: true, pid: 8888 + reviveCalls, message: `Reviving "beta" (#${reviveCalls})` };
      },
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.equal(reviveCalls, 2);
  });
});

describe("/coms Activity Log scoping, routing, tail reader (#1417)", () => {
  it("excludes other-project or legacy untagged records in project-scoped Activity", () => {
    const { repoAPeer, history } = makeNamesakeFixture();
    const scoped = collectComsActivityEvents({
      historyRecords: history,
      livePeers: [repoAPeer],
      projectFilter: "repo-a",
    });
    assert.ok(scoped.some((e) => /Secret A/.test(e.summary)));
    assert.equal(scoped.some((e) => /Secret B/.test(e.summary)), false);
    assert.equal(scoped.some((e) => /Legacy untagged/.test(e.summary)), false);
  });

  it("leaves an unverified remote namesake inbound unlinked instead of targeting local peer", () => {
    const { repoAPeer, history } = makeNamesakeFixture();
    const scoped = collectComsActivityEvents({
      historyRecords: history,
      livePeers: [repoAPeer],
      projectFilter: "repo-a",
    });
    const remoteIn = scoped.find((e) => /From remote namesake/.test(e.summary));
    assert.ok(remoteIn);
    assert.equal(remoteIn.sourceId, "peer:unverified:worker");
  });

  it("maps project-qualified sourceIds in all-projects view while marking ambiguous legacy records", () => {
    const { repoAPeer, repoBPeer, history } = makeNamesakeFixture();
    const allEvents = collectComsActivityEvents({
      historyRecords: history,
      livePeers: [repoAPeer, repoBPeer],
      projectFilter: null,
    });
    assert.equal(allEvents.find((e) => /Secret A/.test(e.summary))?.sourceId, "repo-a:worker\0/tmp/a.sock");
    assert.equal(allEvents.find((e) => /Secret B/.test(e.summary))?.sourceId, "repo-b:worker\0/tmp/b.sock");
    assert.equal(allEvents.find((e) => /Cross-project send/.test(e.summary))?.sourceId, "repo-b:worker\0/tmp/b.sock");
    assert.equal(allEvents.find((e) => /Legacy untagged/.test(e.summary))?.sourceId, "peer:ambiguous:worker");
  });

  it("opens a verified cross-project recipient from project-scoped Activity on Enter (Qodo C3 #7)", async () => {
    const { repoAPeer, repoBPeer, history } = makeNamesakeFixture();
    const xprojOnly = history.filter((h) => h.msg_id === "m-xproj");
    const scopedEvents = collectComsActivityEvents({
      historyRecords: xprojOnly,
      livePeers: [repoAPeer],
      allKnownPeers: [repoAPeer, repoBPeer],
      projectFilter: "repo-a",
    });
    const xprojEv = scopedEvents.find((e) => /Cross-project send/.test(e.summary));
    assert.equal(xprojEv?.sourceId, "repo-b:worker\0/tmp/b.sock");

    const described: string[] = [];
    const h = makeUi([
      ["2"],
      ["f", "f", "f", "\r"], // Messages filter -> Enter on m-xproj
      ["\x1b"],              // Esc from repo-b:worker drilldown
      ["close"],             // Close Activity
    ]);

    await openComsPeersOverlay(h.ctx, {
      listPeers: (scope) => (scope === "all" ? [repoAPeer, repoBPeer] : [repoAPeer]),
      listActivityEvents: () => scopedEvents,
      describePeer: async (row) => {
        described.push(`${row.project}:${row.name}`);
        return { ok: false, reason: "not-reported" };
      },
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.deepEqual(described, ["repo-b:worker"]);
  });

  it("applies project filter before the tail limit in createTailHistoryReader (Qodo C2 #6)", () => {
    const dir = makeTempDir("coms-hist-tail-");
    tempDirs.push(dir);
    const histPath = join(dir, "history.jsonl");
    const lines: string[] = [
      JSON.stringify({
        ts: "2026-11-26T09:59:00.000Z",
        msg_id: "m-repo-a",
        direction: "out",
        peer: "alpha",
        project: "repo-a",
        peer_project: "repo-a",
        preview: "Important repo-a message",
      }),
    ];
    for (let i = 0; i < 210; i++) {
      lines.push(JSON.stringify({
        ts: `2026-11-26T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        msg_id: `m-b-${i}`,
        direction: "out",
        peer: "beta",
        project: "repo-b",
        peer_project: "repo-b",
        preview: `msg-${i}-${"x".repeat(40)}`,
      }));
    }
    writeFileSync(histPath, `${lines.join("\n")}\n`, "utf-8");

    const reader = createTailHistoryReader(histPath);
    const repoARecords = reader.readRecent(200, "repo-a");
    assert.equal(repoARecords.length, 1);
    assert.equal(repoARecords[0].msg_id, "m-repo-a");

    const smallTail = readRecentHistoryRecords(histPath, { limit: 10 }, 2048);
    assert.ok(smallTail.length > 0 && smallTail.length <= 10);
    assert.equal(smallTail[smallTail.length - 1].msg_id, "m-b-209");

    const first = reader.readRecent(10, "repo-b");
    const second = reader.readRecent(10, "repo-b");
    assert.equal(first, second);

    writeFileSync(
      histPath,
      `${JSON.stringify({ ts: "2026-11-26T11:00:00.000Z", msg_id: "m-rotated", direction: "in", peer: "alpha", project: "repo-a", preview: "fresh" })}\n`,
      "utf-8",
    );
    const afterRotate = reader.readRecent(10, "repo-a");
    assert.equal(afterRotate.length, 1);
    assert.equal(afterRotate[0].msg_id, "m-rotated");
  });

  it("retries createTailHistoryReader after a transient read failure recovers (Qodo C3 #5)", () => {
    const dir = makeTempDir("coms-hist-eperm-");
    tempDirs.push(dir);
    const histPath = join(dir, "history.jsonl");
    writeFileSync(
      histPath,
      `${JSON.stringify({ ts: "2026-11-26T11:00:00.000Z", msg_id: "m-recover", direction: "out", peer: "alpha", project: "repo-a", preview: "recovered" })}\n`,
      "utf-8",
    );

    const reader = createTailHistoryReader(histPath);
    // Only test chmod-based EACCES when not running as root
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      chmodSync(histPath, 0o000);
      try {
        assert.deepEqual(reader.readRecent(10, "repo-a"), []);
      } finally {
        chmodSync(histPath, 0o600);
      }
      const recovered = reader.readRecent(10, "repo-a");
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].msg_id, "m-recover");
    }
  });

  it("records verified recipient peer_project on cross-project sendAsUser without --project (Qodo C2 #9)", async () => {
    const dir = makeTempDir("coms-xproj-send-");
    tempDirs.push(dir);
    const makeStubPi = () => ({
      on: () => {},
      registerTool: () => {},
      registerCommand: () => {},
      registerFlag: () => {},
      registerMessageRenderer: () => {},
      getFlag: () => undefined,
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
      events: { on: () => () => {}, emit: () => {} },
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
    }) as unknown as ExtensionAPI;

    const rtA = createComsPeerRuntime(makeStubPi(), {
      deferred: true,
      comsDir: dir,
      sessionId: "sess-a-xproj",
      allowSubagentChild: true,
      registerSignalHandlers: false,
    });
    const rtB = createComsPeerRuntime(makeStubPi(), {
      deferred: true,
      comsDir: dir,
      sessionId: "sess-b-xproj",
      allowSubagentChild: true,
      registerSignalHandlers: false,
    });

    try {
      await rtA.start({ cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "pi-a" } } as any, {
        flags: { cname: "alice", project: "proj-a" },
      });
      await rtB.start({ cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "pi-b" } } as any, {
        flags: { cname: "bob-unique", project: "proj-b" },
      });

      const res = await rtA.sendAsUser({ target: "bob-unique", prompt: "cross project ping" });
      assert.equal(res.ok, true);

      const histPath = new ComsRegistry(dir).historyPath();
      const outRecs = readRecentHistoryRecords(histPath, { direction: "out", peer: "bob-unique" });
      assert.equal(outRecs.length, 1);
      assert.equal(outRecs[0].project, "proj-a");
      assert.equal(outRecs[0].peer_project, "proj-b");
    } finally {
      await rtA.stop();
      await rtB.stop();
    }
  });

  it("records verified recipient peer_project on cross-project coms_send tool calls (Qodo C3 #6)", async () => {
    const dir = makeTempDir("coms-xproj-tool-");
    tempDirs.push(dir);
    const toolsA = new Map<string, any>();
    const makeStubPi = (map?: Map<string, any>) => ({
      on: () => {},
      registerTool: (t: any) => { map?.set(t.name, t); },
      registerCommand: () => {},
      registerFlag: () => {},
      registerMessageRenderer: () => {},
      getFlag: () => undefined,
      getAllTools: () => [...(map?.values() ?? [])],
      getActiveTools: () => [...(map?.keys() ?? [])],
      setActiveTools: () => {},
      events: { on: () => () => {}, emit: () => {} },
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
    }) as unknown as ExtensionAPI;

    const rtA = createComsPeerRuntime(makeStubPi(toolsA), {
      deferred: true,
      comsDir: dir,
      sessionId: "sess-a-tool",
      allowSubagentChild: true,
      registerSignalHandlers: false,
    });
    const rtB = createComsPeerRuntime(makeStubPi(), {
      deferred: true,
      comsDir: dir,
      sessionId: "sess-b-tool",
      allowSubagentChild: true,
      registerSignalHandlers: false,
    });

    try {
      await rtA.start({ cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "pi-a-tool" } } as any, {
        flags: { cname: "alice-tool", project: "proj-a" },
      });
      await rtB.start({ cwd: dir, hasUI: false, sessionManager: { getSessionId: () => "pi-b-tool" } } as any, {
        flags: { cname: "bob-tool", project: "proj-b" },
      });

      const sendTool = toolsA.get("coms_send");
      assert.ok(sendTool);
      await sendTool.execute("call-1", { target: "sess-b-tool", prompt: "cross-project tool ping" });

      const histPath = new ComsRegistry(dir).historyPath();
      const outRecs = readRecentHistoryRecords(histPath, { direction: "out", peer: "bob-tool" });
      assert.equal(outRecs.length, 1);
      assert.equal(outRecs[0].project, "proj-a");
      assert.equal(outRecs[0].peer_project, "proj-b");
    } finally {
      await rtA.stop();
      await rtB.stop();
    }
  });

  it("toggles Roster/Activity tabs, filters errors, jumps to peer within 44-col width", async () => {
    const history: HistoryRecord[] = [
      {
        ts: "2026-11-26T10:02:00.000Z",
        msg_id: "m1",
        direction: "out",
        peer: "alpha",
        project: "repo",
        peer_project: "repo",
        preview: "Start PR review \x1b[2Jclean",
        status: "delivered",
      },
      {
        ts: "2026-11-26T10:03:00.000Z",
        msg_id: "m2",
        direction: "response_in",
        peer: "alpha",
        project: "repo",
        peer_project: "repo",
        preview: "Connection refused",
        status: "error",
        error: "ECONNREFUSED",
      },
    ];

    const events = collectComsActivityEvents({
      historyRecords: history,
      livePeers: [livePeer],
      stoppedPeers: [stoppedPeer],
    });
    const msgEvent = events.find((e) => e.category === "message");
    assert.ok(msgEvent);
    assert.equal(/\x1b/.test(msgEvent.summary), false);
    assert.ok(events.some((e) => e.category === "error" && /ECONNREFUSED/.test(e.summary)));

    const h = makeUi([["2"], ["f", "\r"], ["\x1b"], ["1"], ["close"]], 44);

    await openComsPeersOverlay(h.ctx, {
      listPeers: () => [livePeer],
      listStoppedPeers: () => [stoppedPeer],
      listActivityEvents: () => events,
      describePeer: async () => ({ ok: false, reason: "not-reported" }),
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.equal(h.openedCount(), 5);
    assert.match(h.frames[0][0], /\[1\] Roster/);
    assert.match(h.frames[1][0], /\[2\] Activity/);
    assert.match(h.frames[2][0], /Peer alpha/);
    assert.match(h.frames[3][0], /filter: Errors/);
    assert.match(h.frames[4][0], /\[1\] Roster/);

    for (const frameList of h.frames) {
      for (const frame of frameList) {
        for (const line of frame.split("\n")) {
          assert.ok(visibleWidth(line) <= 44, `overflowed 44 cols (${visibleWidth(line)}): ${line}`);
        }
      }
    }
  });

  it("falls back safely to plain text when ctx.hasUI is false", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = fakeCommandCtx(
      { notify: (message: string, level?: "info" | "warning" | "error") => { notifications.push({ message, level }); } },
      { hasUI: false },
    );

    await openComsPeersOverlay(ctx, {
      listPeers: () => [livePeer],
      listStoppedPeers: () => [stoppedPeer],
      killPeer: () => "killed",
      killAll: () => "killed all",
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "info");
    assert.match(notifications[0].message, /alpha/);
    assert.match(notifications[0].message, /Recently stopped supervised peer/);
    assert.match(notifications[0].message, /beta/);
    assert.equal(/\x1b\[/.test(notifications[0].message), false);

    assert.equal(formatComsPeersPlainText([]), "No peers in the coms registry.");
  });
});
