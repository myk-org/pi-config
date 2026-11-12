import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deadPeerCardIds } from "../../../extensions/coms/coms-shared.js";
import { activationVerified, describePeerOrigin, filterRegistry, formatPeerTable, isFreshHeartbeat, pickSupervisionRecord, buildPeerSpawn, planActiveClaim, projectProblem, planPeerKills, resolveKillScope, resolveListScope, resolvePeerScope, selectKillTargets, supervisedPeerKeys, type RegistryRow } from "../../../extensions/coms/coms-peers.js";

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

  // Render-only sanitization (#1084). A peer whose name carries a control character must stay
  // ADDRESSABLE by that raw value — identity is the wire value — while the rendered row strips it.
  // If this ever fails, the fix is to sanitize in the projection, not to widen it into identity.
  it("renders a hostile name stripped yet still resolves it by the raw value", () => {
    const raw = "peer\u0007one\x1b[2J";
    const rows = [row({ name: raw })];
    const table = formatPeerTable(rows);
    assert.equal(table.includes("\u0007"), false, "a control character must not reach the table");
    assert.equal(table.includes("\x1b"), false, "an escape sequence must not reach the table");
    assert.match(table, /● peerone · proj-a/);

    // Identity is untouched: the raw value is what filters and kill targeting compare against.
    assert.deepEqual(filterRegistry(rows, { name: raw }).map((r) => r.name), [raw]);
    assert.deepEqual(selectKillTargets(rows, { name: raw }, () => true).targets.map((r) => r.name), [raw]);
    assert.deepEqual(
      selectKillTargets(rows, { name: "peerone" }, () => true).missing,
      ["peerone"],
      "the stripped form is a render artifact, not an address",
    );
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

  it("refuses a peer no supervisor started", () => {
    const plan = planPeerKills({ ...base, supervisedKeys: new Set() });
    assert.deepEqual(plan.map((e) => [e.signalPid, e.reason]), [[null, "not-supervised"]]);
  });

  it("still stops a live peer whose record is retired bookkeeping", () => {
    // A leftover stoppedAt must not leave a running peer unstoppable.
    const plan = planPeerKills({ ...base, records: [{ cname: "peer1", project: "p1", pid: 900, childPid: 100, stoppedAt: "t" }] });
    assert.deepEqual(plan.map((e) => [e.signalPid, e.reason]), [[100, "peer"]]);
  });

  it("refuses an ambiguous name instead of stopping both", () => {
    const rows = [row(), row({ project: "p2", pid: 200 })];
    const plan = planPeerKills({ ...base, rows, supervisedKeys: new Set(["p1::peer1", "p2::peer1"]) });
    assert.deepEqual(plan.map((e) => [e.signalPid, e.reason]), [[null, "ambiguous"], [null, "ambiguous"]]);
    const chosen = planPeerKills({
      ...base,
      rows,
      request: { name: "peer1", project: "p2" },
      supervisedKeys: new Set(["p1::peer1", "p2::peer1"]),
      records: [{ cname: "peer1", project: "p2", pid: 900, childPid: 200 }],
    });
    assert.deepEqual(chosen.map((e) => [e.project, e.reason]), [["p2", "supervisor"]]);
  });

  it("scopes kill-all to the requested project", () => {
    const rows = [row(), row({ project: "p2", name: "peer2", pid: 200 })];
    const plan = planPeerKills({ ...base, rows, request: { all: true, project: "p2" }, supervisedKeys: new Set(["p1::peer1", "p2::peer2"]) });
    assert.deepEqual(plan.map((e) => e.project), ["p2"]);
  });

  it("treats project * as every project", () => {
    const rows = [row(), row({ project: "p2", name: "peer2", pid: 200 })];
    const plan = planPeerKills({
      ...base,
      rows,
      request: { all: true, project: "*" },
      supervisedKeys: new Set(["p1::peer1", "p2::peer2"]),
    });
    assert.deepEqual(plan.map((e) => e.project).sort(), ["p1", "p2"]);
  });

  it("logs the kill-plan scope it applied", () => {
    const rows = [row(), row({ project: "p2", name: "peer2", pid: 200 })];
    const events: unknown[] = [];
    planPeerKills({
      ...base,
      rows,
      request: { all: true, project: "*" },
      supervisedKeys: new Set(["p1::peer1", "p2::peer2"]),
      logger: { debug: (m, data) => events.push({ m, data }) },
    });
    assert.deepEqual(events, [{ m: "coms_kill_plan_scope", data: { project: "*", everyProject: true, rows: 2 } }]);
  });

  it("refuses an ambiguous name even in the every-project view", () => {
    const rows = [row(), row({ project: "p2", pid: 200 })];
    const plan = planPeerKills({ ...base, rows, request: { name: "peer1", project: "*" }, supervisedKeys: new Set(["p1::peer1", "p2::peer1"]) });
    assert.deepEqual(plan.map((e) => [e.signalPid, e.reason]), [[null, "ambiguous"], [null, "ambiguous"]]);
  });
});

describe("describePeerOrigin", () => {
  const row = (over: Partial<RegistryRow> = {}): RegistryRow => ({
    project: "p", name: "peer", pid: 1, cwd: "/w", purpose: "", endpoint: "/s",
    busy: false, queueDepth: null, contextUsedPct: null, startedAt: null, heartbeatAt: null, ...over,
  });

  it("prefers the supervisor record over the registry's activation origin", () => {
    assert.deepEqual(describePeerOrigin(row({ createdBy: "agent", origin: "user" })), { by: "agent", via: "supervisor" });
  });

  it("names the actual entry point, which is not always a slash command", () => {
    assert.deepEqual(describePeerOrigin(row({ origin: "tool" })), { by: "agent", via: "coms_start tool" });
    assert.deepEqual(describePeerOrigin(row({ origin: "slash" })), { by: "user", via: "/coms start" });
    assert.deepEqual(describePeerOrigin(row({ origin: "cli" })), { by: "user", via: "pi --coms" });
  });

  it("keeps the attribution of a peer started before the entry-point vocabulary", () => {
    // A running peer keeps writing the legacy value through its heartbeats until it restarts.
    assert.deepEqual(describePeerOrigin(row({ origin: "agent" })), { by: "agent", via: "coms_start (legacy record)" });
    assert.deepEqual(describePeerOrigin(row({ origin: "user" })), { by: "user", via: "/coms start (legacy record)" });
  });

  it("says unknown rather than guessing user for a peer predating both fields", () => {
    assert.deepEqual(describePeerOrigin(row()), { by: "unknown", via: "no record" });
    assert.deepEqual(describePeerOrigin(row({ createdBy: "", origin: "garbage" })), { by: "unknown", via: "no record" });
  });
});

describe("pickSupervisionRecord", () => {
  const row = (over: Partial<RegistryRow> = {}): RegistryRow => ({
    project: "p", name: "peer", pid: 100, cwd: "/w", purpose: "", endpoint: "/s",
    busy: false, queueDepth: null, contextUsedPct: null, startedAt: null, heartbeatAt: null, ...over,
  });

  it("picks the record whose child is this pid, not the first name match", () => {
    const records = [
      { cname: "peer", project: "p", childPid: 999, startedAt: "2026-01-01T00:00:00Z", createdBy: "user" },
      { cname: "peer", project: "p", childPid: 100, startedAt: "2026-01-02T00:00:00Z", createdBy: "agent" },
    ];
    assert.equal(pickSupervisionRecord(records, row())?.createdBy, "agent");
  });

  it("ignores retired records: a new peer must not inherit an old creator", () => {
    const records = [{ cname: "peer", project: "p", childPid: 555, startedAt: "2026-01-01T00:00:00Z", createdBy: "user", stoppedAt: "x" }];
    assert.equal(pickSupervisionRecord(records, row()), null);
  });

  it("falls back to the newest live record when no child pid matches", () => {
    const records = [
      { cname: "peer", project: "p", childPid: 1, startedAt: "2026-01-01T00:00:00Z", createdBy: "user" },
      { cname: "peer", project: "p", childPid: 2, startedAt: "2026-02-01T00:00:00Z", createdBy: "agent" },
    ];
    assert.equal(pickSupervisionRecord(records, row())?.createdBy, "agent");
  });
});

describe("activationVerified", () => {
  it("rejects an activation that published no socket", () => {
    assert.equal(activationVerified(null, "linux", () => true), false);
    assert.equal(activationVerified({ endpoint: "" }, "linux", () => true), false);
  });

  it("rejects a socket path that does not exist on disk", () => {
    assert.equal(activationVerified({ endpoint: "/s" }, "linux", () => false), false);
    assert.equal(activationVerified({ endpoint: "/s" }, "linux", () => true), true);
  });

  it("accepts a Windows named pipe, which the filesystem cannot see", () => {
    assert.equal(activationVerified({ endpoint: "\\.\pipe\coms" }, "win32", () => false), true);
  });
});

describe("planActiveClaim", () => {
  it("reuses a claim that has a socket behind it", () => {
    assert.deepEqual(planActiveClaim({ endpoint: "/s" }, "linux", () => true), { action: "reuse", message: "📡 coms already active" });
  });

  it("restarts a claim with no socket, and says so", () => {
    const claim = planActiveClaim({ endpoint: "/gone" }, "linux", () => false);
    assert.equal(claim.action, "restart");
    assert.match(claim.message, /previous peer is gone/);
  });

  it("restarts when activation published nothing, and logs the verdict", () => {
    const warnings: string[] = [];
    const claim = planActiveClaim(null, "linux", () => true, { warn: (m) => warnings.push(m) });
    assert.equal(claim.action, "restart");
    assert.deepEqual(warnings, ["coms_active_claim_unverified"]);
  });
});

describe("resolvePeerScope", () => {
  it("defaults a tool call to its own project", () => {
    assert.deepEqual(resolvePeerScope(undefined, "home__myakove__git__pi-config"), { project: "home__myakove__git__pi-config", everyProject: false });
    assert.deepEqual(resolvePeerScope("", "own"), { project: "own", everyProject: false });
  });

  it("shows every project only when asked", () => {
    assert.deepEqual(resolvePeerScope("*", "own"), { project: null, everyProject: true });
    assert.deepEqual(resolvePeerScope("all", "own"), { project: null, everyProject: true });
  });

  it("honours an explicit project namespace", () => {
    assert.deepEqual(resolvePeerScope("pi-config", "own"), { project: "pi-config", everyProject: false });
  });
});

describe("buildPeerSpawn", () => {
  const supervisor = "/opt/sup/coms-peer-supervisor.mjs";

  it("builds the supervisor invocation with the flags it understands", () => {
    assert.deepEqual(
      buildPeerSpawn(supervisor, { cname: "builder", project: "p", cwd: "/w", purpose: "builds" }),
      { ok: true, command: ["node", supervisor, "builder", "--project", "p", "--cwd", "/w", "--purpose", "builds"] },
    );
  });

  it("omits empty optional flags rather than passing blank values", () => {
    assert.deepEqual(buildPeerSpawn(supervisor, { cname: "builder" }), { ok: true, command: ["node", supervisor, "builder"] });
  });

  it("logs why a spawn was refused", () => {
    const events: string[] = [];
    const logger = { warn: (m: string) => events.push(m) };
    buildPeerSpawn(supervisor, {}, logger);
    buildPeerSpawn(supervisor, { cname: "bad name" }, logger);
    buildPeerSpawn(supervisor, { cname: "peer", project: ".." }, logger);
    buildPeerSpawn("", { cname: "peer" }, logger);
    assert.deepEqual(events, ["coms_spawn_refused", "coms_spawn_refused", "coms_spawn_refused", "coms_spawn_refused"]);
  });

  it("refuses a missing peer name", () => {
    assert.equal(buildPeerSpawn(supervisor, {}).ok, false);
  });

  it("refuses a shell-hostile peer name", () => {
    for (const bad of ["a b", "x;rm -rf /", "../escape", "-leading", ""]) {
      assert.equal(buildPeerSpawn(supervisor, { cname: bad }).ok, false, bad);
    }
  });

  it("refuses a missing supervisor", () => {
    assert.equal(buildPeerSpawn("", { cname: "ok" }).ok, false);
  });
});

describe("resolveKillScope", () => {
  it("scopes kill-all to the caller's project, widening only when asked", () => {
    assert.deepEqual(resolveKillScope({ all: true }, "own"), { all: true, project: "own" });
    assert.deepEqual(resolveKillScope({ all: true, project: "*" }, "own"), { all: true, project: "*" });
  });

  it("lets an explicit every-project view kill what it shows", () => {
    assert.deepEqual(resolveKillScope({ all: true, project: "*" }, "own"), { all: true, project: "*" });
  });

  it("refuses kill-all when no project can be derived, and logs the refusal", () => {
    const events: string[] = [];
    const scope = resolveKillScope({ all: true }, "", { debug: (m) => events.push(`debug:${m}`), warn: (m) => events.push(`warn:${m}`) });
    assert.equal(scope.project, undefined);
    assert.match(scope.refused ?? "", /cannot tell which project/);
    assert.deepEqual(events, ["warn:coms_kill_refused"]);
  });

  it("logs the scope it settled on, including the every-project wildcard", () => {
    const events: string[] = [];
    resolveKillScope({ all: true }, "own", { debug: (m) => events.push(m), warn: (m) => events.push(m) });
    resolveKillScope({ name: "peer" }, "own", { debug: (m) => events.push(m), warn: (m) => events.push(m) });
    resolveKillScope({ all: true, project: "*" }, "own", { debug: (m) => events.push(m), warn: (m) => events.push(m) });
    assert.deepEqual(events, ["coms_kill_scope", "coms_kill_scope", "coms_kill_scope"]);
  });

  it("looks a NAMED peer up across projects, since naming one is already specific", () => {
    assert.deepEqual(resolveKillScope({ name: "builder" }, "own"), { name: "builder", project: undefined });
    assert.deepEqual(resolveKillScope({ name: "builder", project: "other" }, "own"), { name: "builder", project: "other" });
  });
});

describe("resolveListScope", () => {
  it("defaults to the caller's project", () => {
    assert.equal(resolveListScope(["list"], "own"), "own");
  });

  it("widens to every project with --all", () => {
    assert.equal(resolveListScope(["list", "--all"], "own"), undefined);
  });

  it("treats --project * as every project, so the view and its kill-all agree", () => {
    assert.equal(resolveListScope(["list", "--project", "*"], "own"), undefined);
  });

  it("honours an explicit --project namespace", () => {
    assert.equal(resolveListScope(["list", "--project", "other"], "own"), "other");
  });
});

describe("buildPeerSpawn project validation", () => {
  const supervisor = "/opt/sup/coms-peer-supervisor.mjs";
  it("refuses a project that could escape the coms root", () => {
    for (const bad of ["../etc", "a/b", "..", "a\\b"]) {
      assert.equal(buildPeerSpawn(supervisor, { cname: "peer", project: bad }).ok, false, bad);
    }
  });

  it("accepts a namespace activation would derive from a real directory, spaces included", () => {
    assert.equal(buildPeerSpawn(supervisor, { cname: "peer", project: "work__My Projects" }).ok, true);
  });

  it("refuses projects that cannot become a directory, on any platform", () => {
    // Dots only resolves to projects/agents (the peer would register under the scanner's own name),
    // and Windows cannot create these directories at all.
    for (const bad of [".", "...", "CON", "nul.txt", "lpt9", "a:b"]) {
      assert.notEqual(projectProblem(bad), null, bad);
    }
    assert.equal(projectProblem("pi-config"), null);
    assert.equal(projectProblem("work__My Projects"), null);
  });
  it("accepts a normal namespace", () => {
    assert.equal(buildPeerSpawn(supervisor, { cname: "peer", project: "pi-config" }).ok, true);
  });
});
