import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deadPeerCardIds } from "../../../extensions/coms/coms-shared.js";
import { filterRegistry, formatPeerTable, isFreshHeartbeat, planPeerKills, selectKillTargets, supervisedPeerKeys, type RegistryRow } from "../../../extensions/coms/coms-peers.js";

describe("deadPeerCardIds", () => {
  const cards = () => new Map<string, { endpoint?: string | null; name?: string }>([
    ["alive", { endpoint: "/tmp/alive.sock", name: "alive-peer" }],
    ["dead", { endpoint: "/tmp/dead.sock", name: "dead-peer" }],
    ["noendpoint", { name: "unknown" }],
  ]);

  it("drops the cards whose socket disappeared", () => {
    // A killed peer kept being advertised, so an agent could message a corpse.
    const exists = (p: string) => p === "/tmp/alive.sock";
    assert.deepEqual(deadPeerCardIds(cards(), exists), ["dead"]);
  });

  it("keeps cards that make no endpoint claim", () => {
    assert.deepEqual(deadPeerCardIds(cards(), () => true), []);
  });

  it("does not judge Windows named pipes", () => {
    assert.deepEqual(deadPeerCardIds(cards(), () => false, "win32"), []);
  });
});

describe("registry-wide peer view", () => {
  const row = (over: Partial<RegistryRow> = {}): RegistryRow => ({
    project: "proj-a", name: "peer1", pid: 100, cwd: "/w", purpose: "p", endpoint: "/sock",
    busy: false, queueDepth: null, contextUsedPct: null, startedAt: null, heartbeatAt: null, ...over,
  });

  it("lists every project and filters on demand", () => {
    const rows = [row(), row({ project: "proj-b", name: "peer2" })];
    assert.equal(filterRegistry(rows).length, 2, "no filter = the whole machine");
    assert.deepEqual(filterRegistry(rows, { project: "proj-b" }).map((r) => r.name), ["peer2"]);
    assert.deepEqual(filterRegistry(rows, { name: "peer1" }).map((r) => r.project), ["proj-a"]);
  });

  it("kills by name, and refuses an ambiguous name instead of guessing", () => {
    const rows = [row(), row({ project: "proj-b" })];
    const alive = () => true;
    assert.equal(selectKillTargets(rows, { name: "peer1" }, alive).ambiguous.length, 2);
    assert.deepEqual(selectKillTargets(rows, { name: "peer1", project: "proj-b" }, alive).targets.map((r) => r.project), ["proj-b"]);
    assert.deepEqual(selectKillTargets(rows, { all: true }, alive).targets.length, 2);
    assert.deepEqual(selectKillTargets(rows, { name: "ghost" }, alive).missing, ["ghost"]);
  });

  it("shows the live state that makes the list worth watching", () => {
    const table = formatPeerTable([row({ busy: true, queueDepth: 2, contextUsedPct: 41 })]);
    assert.match(table, /● peer1 · proj-a \(busy queue:2 ctx:41% pid:100\)/);
    assert.match(formatPeerTable([]), /No peers found/);
  });
});

describe("isFreshHeartbeat", () => {
  const now = Date.parse("2026-11-09T14:00:00.000Z");
  it("accepts a heartbeat inside the window", () => {
    assert.equal(isFreshHeartbeat("2026-11-09T13:59:30.000Z", now), true);
  });

  it("rejects a stale heartbeat, a missing one and an unparseable one", () => {
    // The bug this prevents: a crashed peer's pid gets reused and the record looks alive forever.
    assert.equal(isFreshHeartbeat("2026-11-09T13:50:00.000Z", now), false);
    assert.equal(isFreshHeartbeat(null, now), false);
    assert.equal(isFreshHeartbeat("not-a-date", now), false);
  });
});

describe("supervisedPeerKeys", () => {
  it("keys peers by project and name so same-name peers stay separate", () => {
    // Two projects may use one name (rootcoz ↔ pi-sidecar share a project name deliberately).
    const keys = supervisedPeerKeys([
      { cname: "coder", project: "proj-a", pid: 1 },
      { cname: "coder", project: "proj-b", pid: 2 },
    ]);
    assert.deepEqual([...keys].sort(), ["proj-a::coder", "proj-b::coder"]);
  });

  it("ignores records without a live supervisor pid", () => {
    // The registry lists human sessions too; only supervised peers may be killed.
    assert.equal(supervisedPeerKeys([{ cname: "manager" }, { cname: "x", pid: 0 }]).size, 0);
  });
});

describe("planPeerKills", () => {
  const row = (over: Partial<RegistryRow> = {}): RegistryRow => ({
    project: "p1", name: "peer1", pid: 100, cwd: "/w", purpose: "", endpoint: "/sock",
    busy: false, queueDepth: null, contextUsedPct: null, startedAt: null, heartbeatAt: null, ...over,
  });
  const base = {
    rows: [row()],
    supervisedKeys: new Set(["p1::peer1"]),
    records: [{ cname: "peer1", project: "p1", pid: 900, childPid: 100 }],
    request: { name: "peer1" },
    isAlive: () => true,
  };

  it("signals the supervisor only when its child is this peer", () => {
    assert.deepEqual(planPeerKills(base), [{ name: "peer1", project: "p1", signalPid: 900, reason: "supervisor" }]);
  });

  it("falls back to the peer when the record belongs to a different child", () => {
    // A reused supervisor pid must never be signalled.
    const plan = planPeerKills({ ...base, records: [{ cname: "peer1", project: "p1", pid: 900, childPid: 999 }] });
    assert.deepEqual(plan.map((e) => [e.signalPid, e.reason]), [[100, "peer"]]);
  });

  it("refuses a peer no supervisor started, and a retired record", () => {
    const unsupervised = planPeerKills({ ...base, supervisedKeys: new Set() });
    assert.deepEqual(unsupervised.map((e) => [e.signalPid, e.reason]), [[null, "not-supervised"]]);
    const retired = planPeerKills({ ...base, records: [{ cname: "peer1", project: "p1", pid: 900, childPid: 100, stoppedAt: "t" }] });
    assert.deepEqual(retired.map((e) => [e.signalPid, e.reason]), [[null, "stale-record"]]);
  });

  it("scopes kill-all to the requested project", () => {
    const rows = [row(), row({ project: "p2", name: "peer2", pid: 200 })];
    const plan = planPeerKills({ ...base, rows, request: { all: true, project: "p2" }, supervisedKeys: new Set(["p1::peer1", "p2::peer2"]) });
    assert.deepEqual(plan.map((e) => e.project), ["p2"]);
  });
});
