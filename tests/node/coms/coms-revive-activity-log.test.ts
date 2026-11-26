/**
 * Unit tests for #1417: `/coms` stopped-peer revive (`r`), supervisor `--session` resume,
 * and unified live Activity Log (`1`/`2`).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildPeerSpawn,
  collectComsActivityEvents,
  formatComsPeersPlainText,
  listStoppedSupervisedPeers,
  type RegistryRow,
  type SupervisionRecord,
} from "../../../extensions/coms/coms-peers.js";
import { openComsPeersOverlay } from "../../../extensions/coms/coms-peers-ui.js";
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

describe("listStoppedSupervisedPeers & buildPeerSpawn (--session) (#1417)", () => {
  it("lists recently stopped supervised peers, excludes live ones, and preserves session metadata", () => {
    const records: SupervisionRecord[] = [
      {
        cname: "alpha",
        project: "repo",
        cwd: "/repo",
        purpose: "live now",
        exitedAt: "2026-11-26T09:00:00.000Z",
      },
      {
        cname: "beta",
        project: "repo",
        cwd: "/repo/old",
        purpose: "older stop",
        exitedAt: "2026-11-26T09:10:00.000Z",
      },
      {
        cname: "beta",
        project: "repo",
        cwd: "/repo/new",
        purpose: "newer stop",
        piSessionId: "sess-beta-latest",
        exitedAt: "2026-11-26T09:40:00.000Z",
        exitCode: 0,
      },
      {
        cname: "gamma",
        project: "other",
        cwd: "/other",
        purpose: "other project",
        failedAt: "2026-11-26T09:50:00.000Z",
        exitCode: 1,
      },
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

  it("passes --session in buildPeerSpawn and rejects control chars", () => {
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

    const bad = buildPeerSpawn("/path/to/supervisor.mjs", {
      cname: "beta",
      session: "bad\nsession",
    });
    assert.equal(bad.ok, false);
  });
});

describe("coms-peer-supervisor --session and piSessionId preservation (#1417)", () => {
  it("forwards --session to pi and preserves piSessionId across shutdown", async () => {
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

    // Simulate coms-wrapper recording piSessionId before sending SIGTERM
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

describe("/coms revive (`r`) and Unified Activity Log (`1`/`2`) (#1417)", () => {
  it("revives a stopped supervised peer on `r` (and Kitty CSI-u `r`) with inline banner, refuses live peer", async () => {
    // Row 0 is livePeer, Row 1 is stoppedPeer
    // Press `r` on livePeer -> inline notice "already running", then `j` to stoppedPeer, then Kitty CSI-u `r` -> revive!
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

  it("guards `x` kill and `Enter` drilldown safely on stopped peers without RPC", async () => {
    const h = makeUi([
      ["x", "\r"],
      ["\x1b"],
      ["close"],
    ]);
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
    // Stopped peer detail pane renders saved session & cwd
    assert.match(h.frames[1][0], /sess-beta-123/);
    assert.match(h.frames[1][0], /\/repo\/wt-beta/);
  });

  it("prevents duplicate supervisor launches on repeated `r` presses and shows reviving… (Qodo #9)", async () => {
    // 1) Roster: Enter stoppedPeer detail
    // 2) Detail: press `r` -> revives once & closes detail
    // 3) Roster reopens: row renders `reviving…`; pressing `r` again does NOT call revivePeer a second time!
    const h = makeUi([
      ["\r"],
      ["r"],
      ["r", "close"],
    ]);
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

  it("isolates project-scoped history and disambiguates namesake peers across projects (Qodo #2 & #7)", async () => {
    const repoAPeer: RegistryRow = { ...livePeer, project: "repo-a", name: "worker", endpoint: "/tmp/a.sock" };
    const repoBPeer: RegistryRow = { ...livePeer, project: "repo-b", name: "worker", endpoint: "/tmp/b.sock" };
    const history: HistoryRecord[] = [
      { ts: "2026-11-26T10:01:00.000Z", msg_id: "m-a", direction: "out", peer: "worker", project: "repo-a", preview: "Secret A" },
      { ts: "2026-11-26T10:02:00.000Z", msg_id: "m-b", direction: "out", peer: "worker", project: "repo-b", preview: "Secret B" },
      { ts: "2026-11-26T10:03:00.000Z", msg_id: "m-legacy", direction: "out", peer: "worker", preview: "Legacy untagged" },
    ];

    // Project-scoped view ("repo-a") MUST exclude repo-b AND untagged legacy records
    const scoped = collectComsActivityEvents({
      historyRecords: history,
      livePeers: [repoAPeer],
      projectFilter: "repo-a",
    });
    assert.ok(scoped.some((e) => /Secret A/.test(e.summary)));
    assert.equal(scoped.some((e) => /Secret B/.test(e.summary)), false);
    assert.equal(scoped.some((e) => /Legacy untagged/.test(e.summary)), false);

    // All-projects view maps repo-b record to repo-b's exact row ID and marks ambiguous legacy record non-ambiguous-safe
    const allEvents = collectComsActivityEvents({
      historyRecords: history,
      livePeers: [repoAPeer, repoBPeer],
      projectFilter: null,
    });
    const evA = allEvents.find((e) => /Secret A/.test(e.summary));
    const evB = allEvents.find((e) => /Secret B/.test(e.summary));
    const evLegacy = allEvents.find((e) => /Legacy untagged/.test(e.summary));
    assert.equal(evA?.sourceId, "repo-a:worker\0/tmp/a.sock");
    assert.equal(evB?.sourceId, "repo-b:worker\0/tmp/b.sock");
    assert.equal(evLegacy?.sourceId, "peer:ambiguous:worker");
  });

  it("reads bounded history tails and invalidates cache on rotation/append (Qodo #4)", () => {
    const dir = makeTempDir("coms-hist-tail-");
    tempDirs.push(dir);
    const histPath = join(dir, "history.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(JSON.stringify({
        ts: `2026-11-26T10:00:${String(i).padStart(2, "0")}.000Z`,
        msg_id: `m-${i}`,
        direction: "out",
        peer: "alpha",
        project: "repo",
        preview: `msg-${i}-${"x".repeat(80)}`,
      }));
    }
    writeFileSync(histPath, `${lines.join("\n")}\n`, "utf-8");

    // Tail budget smaller than full file drops oldest records cleanly without corrupting lines
    const tail = readRecentHistoryRecords(histPath, { limit: 10 }, 2048);
    assert.ok(tail.length > 0 && tail.length <= 10);
    assert.equal(tail[tail.length - 1].msg_id, "m-59");

    // Stat-cached tail reader returns identical array when unchanged and refreshes on rotation/truncation
    const reader = createTailHistoryReader(histPath, 2048);
    const first = reader.readRecent(10);
    const second = reader.readRecent(10);
    assert.equal(first, second, "unchanged stat returns cached snapshot");

    // Simulate rotation (file shrinks with a brand new record)
    writeFileSync(
      histPath,
      `${JSON.stringify({ ts: "2026-11-26T11:00:00.000Z", msg_id: "m-rotated", direction: "in", peer: "alpha", project: "repo", preview: "fresh" })}\n`,
      "utf-8",
    );
    const afterRotate = reader.readRecent(10);
    assert.equal(afterRotate.length, 1);
    assert.equal(afterRotate[0].msg_id, "m-rotated");
  });

  it("switches Roster (`1`) <-> Activity (`2`), filters messages/errors, jumps to peer on Enter, and fits narrow widths", async () => {
    const history: HistoryRecord[] = [
      {
        ts: "2026-11-26T10:02:00.000Z",
        msg_id: "m1",
        direction: "out",
        peer: "alpha",
        preview: "Start PR review \x1b[2Jclean",
        status: "delivered",
      },
      {
        ts: "2026-11-26T10:03:00.000Z",
        msg_id: "m2",
        direction: "response_in",
        peer: "alpha",
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
    // ANSI escapes stripped from history preview
    const msgEvent = events.find((e) => e.category === "message");
    assert.ok(msgEvent);
    assert.equal(/\x1b/.test(msgEvent.summary), false);
    assert.ok(events.some((e) => e.category === "error" && /ECONNREFUSED/.test(e.summary)));

    // Open narrow width (44 cols):
    // 1) Roster -> `2` -> Activity
    // 2) Activity -> `f` (Errors) -> `Enter` on alpha error -> opens alpha drilldown
    // 3) Drilldown sections -> Esc back to Activity
    // 4) Activity -> `1` back to Roster
    // 5) Roster -> close
    const h = makeUi([
      ["2"],
      ["f", "\r"],
      ["\x1b"],
      ["1"],
      ["close"],
    ], 44);

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

    // Verify narrow-width rendering never overflows 44 cols
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
