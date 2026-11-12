import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as net from "node:net";
import { describe, it, afterEach } from "node:test";

import {
  collectWorkload,
  formatWorkloadSuffix,
  isActiveAgent,
  isActiveCron,
  isActiveTask,
  renderWorkloadPart,
  toDescribeDetail,
  WORKLOAD_NONE_LINE,
  WORKLOAD_UNKNOWN_LINE,
  workloadSectionLines,
  workloadUnknownLine,
  type PeerWorkloadDetail,
} from "../../../extensions/coms/coms-workload.js";
import { requestDescribe, validateDetail, DESCRIBE_MAX_ENTRIES } from "../../../extensions/coms/coms-describe.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const agent = (over: Partial<{ id: string; agent: string; name: string; task: string; status: string; startedAt: number }> = {}) => ({
  id: "a1",
  agent: "python-expert",
  task: "fix the thing",
  status: "running",
  startedAt: 1_000,
  ...over,
});

const task = (over: Partial<{ id: string; status: string; subject: string; blockedBy: string[] }> = {}) => ({
  id: "1",
  status: "pending",
  subject: "do the thing",
  blockedBy: [],
  ...over,
});

const cron = (over: Partial<{ id: string; scope: string; description: string; task: string; createdAt: number; intervalMs?: number; leader?: boolean }> = {}) => ({
  id: "session:c1",
  scope: "session",
  description: "nightly audit",
  task: "audit",
  createdAt: 1_000,
  intervalMs: 30 * 60_000,
  ...over,
});

const detail = (over: Partial<PeerWorkloadDetail> = {}): PeerWorkloadDetail => ({
  agents: [],
  tasks: [],
  crons: [],
  ...over,
});

describe("workload is active-only (#1083)", () => {
  it("counts agents that are running — a queued one is waiting, not in flight", () => {
    assert.equal(isActiveAgent({ status: "running" }), true);
    assert.equal(isActiveAgent({ status: "queued" }), false);
    assert.equal(isActiveAgent({ status: "complete" }), false);
    assert.equal(isActiveAgent({ status: "failed" }), false);
  });

  it("counts tasks that are not completed", () => {
    assert.equal(isActiveTask({ status: "pending" }), true);
    assert.equal(isActiveTask({ status: "in_progress" }), true);
    assert.equal(isActiveTask({ status: "completed" }), false);
  });

  it("counts scheduled crons this replica owns", () => {
    assert.equal(isActiveCron({ leader: true }), true);
    assert.equal(isActiveCron({}), true);
    assert.equal(isActiveCron({ leader: false }), false);
  });

  it("collects counts and the same active entries", () => {
    const { counts, active } = collectWorkload(
      [agent({ id: "a1" }), agent({ id: "a2", status: "queued" }), agent({ id: "a3", status: "complete" }), agent({ id: "a4", status: "failed" })],
      [task({ id: "1" }), task({ id: "2", status: "in_progress" }), task({ id: "3", status: "completed" })],
      [cron({ id: "session:c1" }), cron({ id: "persist:c2", scope: "project", leader: false })],
    );
    assert.deepEqual(counts, { agents: 1, tasks: 2, crons: 1 });
    assert.deepEqual(active.agents.map((a) => a.id), ["a1"]);
    assert.deepEqual(active.tasks.map((t) => t.id), ["1", "2"]);
    assert.deepEqual(active.crons.map((c) => c.id), ["session:c1"]);
  });
});

describe("drilldown payload is projected (#1083)", () => {
  it("ships agents as id/name/state/elapsed/purpose and nothing else", () => {
    const projected = toDescribeDetail(
      {
        agents: [agent({ id: "job-7", name: "ts-expert", status: "running", task: "migrate\nthe  widget", startedAt: 1_000 })],
        tasks: [],
        crons: [],
      },
      10 * 60_000 + 1_000,
    );
    assert.deepEqual(projected.agents, [
      { id: "job-7", name: "ts-expert", state: "running", elapsed: "10m0s", purpose: "migrate the widget" },
    ]);
    // Job output, worker dirs and other internals never cross the socket.
    assert.deepEqual(Object.keys(projected.agents[0]).sort(), ["elapsed", "id", "name", "purpose", "state"]);
  });

  it("keeps blockedBy so the drilldown marks blocked tasks", () => {
    const projected = toDescribeDetail({ agents: [], tasks: [task({ id: "7", status: "pending", subject: "Wire heartbeat", blockedBy: ["1", "2"] })], crons: [] }, 0);
    assert.deepEqual(projected.tasks, [{ id: "7", status: "pending", subject: "Wire heartbeat", blockedBy: ["1", "2"] }]);
  });

  it("pre-formats cron schedule and next run", () => {
    const projected = toDescribeDetail({ agents: [], tasks: [], crons: [cron({ id: "session:c9", description: "nightly audit", intervalMs: 30 * 60_000 })] }, 10 * 60_000 + 1_000);
    assert.equal(projected.crons[0].id, "session:c9");
    assert.equal(projected.crons[0].schedule, "every 30m");
    assert.match(projected.crons[0].next, /^in \d+m$|^soon$/);
    assert.equal(projected.crons[0].description, "nightly audit");
  });
});

describe("workload widget suffix", () => {
  it("renders only the non-zero counts", () => {
    assert.equal(formatWorkloadSuffix({ agents: 2, tasks: 5, crons: 1 }), " ⏳2 ✓5 ⏰1");
    assert.equal(formatWorkloadSuffix({ agents: 0, tasks: 3, crons: 0 }), " ✓3");
    assert.equal(formatWorkloadSuffix({ agents: 1, tasks: 0, crons: 0 }), " ⏳1");
  });

  it("renders nothing when the peer reports no active work", () => {
    assert.equal(formatWorkloadSuffix({ agents: 0, tasks: 0, crons: 0 }), "");
  });

  it("renders unknown — never 0 — when the peer reports no workload", () => {
    assert.equal(formatWorkloadSuffix(null), " unknown");
    assert.equal(formatWorkloadSuffix(undefined), " unknown");
  });

  it("colors through the theme when one is given", () => {
    const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
    assert.equal(renderWorkloadPart({ agents: 1, tasks: 0, crons: 0 }, theme), " <accent>⏳1");
  });
});

describe("workload drilldown sections", () => {
  it("renders agents, tasks and crons with the shared row format", () => {
    const lines = workloadSectionLines(
      detail({
        agents: [{ id: "job-7", name: "ts-expert", state: "running", elapsed: "10m0s", purpose: "migrate the widget" }],
        tasks: [{ id: "7", status: "in_progress", subject: "Wire heartbeat", blockedBy: [] }],
        crons: [{ id: "session:c9", schedule: "every 30m", next: "in 20m", description: "nightly audit" }],
      }),
    );
    assert.deepEqual(lines, [
      "agents (1)",
      "  ts-expert (job-7)  running  10m0s  migrate the widget",
      "tasks (1)",
      "  ◼ #7 [in_progress] Wire heartbeat",
      "crons (1)",
      "  session:c9  every 30m  in 20m  nightly audit",
    ]);
  });

  it("shows the id alone when the peer reported no friendly name", () => {
    const lines = workloadSectionLines(detail({ agents: [{ id: "job-9", name: "", state: "running", elapsed: "1m", purpose: "" }] }));
    assert.equal(lines[1], "  job-9  running  1m");
  });

  it("marks a blocked task the way /tasks does", () => {
    const lines = workloadSectionLines(detail({ tasks: [{ id: "4", status: "pending", subject: "wait on 3", blockedBy: ["3"] }] }));
    assert.equal(lines[1], "  ◻ #4 [pending] wait on 3 ⛔ blocked");
  });

  it("omits empty sections and says so when an answered peer has nothing active", () => {
    assert.deepEqual(workloadSectionLines(detail()), [WORKLOAD_NONE_LINE]);
  });

  it("has one honest line per failure reason", () => {
    assert.equal(workloadUnknownLine("timeout"), WORKLOAD_UNKNOWN_LINE);
    assert.equal(workloadUnknownLine("malformed"), "workload  unknown (malformed reply)");
    assert.equal(workloadUnknownLine("oversize"), "workload  unknown (reply too large)");
    assert.match(workloadUnknownLine("no-sources"), /cannot report/);
  });
});

describe("describe reply validation (#1083)", () => {
  it("keeps valid entries and drops invalid ones", () => {
    const { detail: valid, malformed } = validateDetail({
      agents: [{ id: "a1", name: "worker", state: "running", elapsed: "2m", purpose: "p" }, null, { id: 7 }],
      tasks: [],
      crons: [],
    });
    assert.equal(valid.agents.length, 1);
    assert.equal(valid.agents[0].id, "a1");
    assert.equal(malformed, false, "some entries survived, so the reply is usable");
  });

  it("calls a section malformed when nothing in it is valid", () => {
    const { malformed } = validateDetail({ agents: [null, { id: 1, state: "running", elapsed: "2m" }], tasks: [], crons: [] });
    assert.equal(malformed, true);
  });

  it("never lets a null element reach a renderer", () => {
    const { detail: safe } = validateDetail({ agents: [null], tasks: [null], crons: [null] });
    assert.deepEqual(safe, { agents: [], tasks: [], crons: [] });
  });

  it("treats a missing section as empty", () => {
    assert.deepEqual(validateDetail({}), { detail: { agents: [], tasks: [], crons: [] }, malformed: false });
  });

  it("calls a wrong-typed section malformed instead of empty", () => {
    const { detail: empty, malformed } = validateDetail({ agents: 3 });
    assert.deepEqual(empty.agents, []);
    assert.equal(malformed, true);
  });

  it("caps each section and keeps the first entries", () => {
    const many = Array.from({ length: DESCRIBE_MAX_ENTRIES + 5 }, (_, i) => ({ id: `t${i}`, status: "pending", subject: "s" }));
    const { detail: capped } = validateDetail({ tasks: many });
    assert.equal(capped.tasks.length, DESCRIBE_MAX_ENTRIES);
    assert.equal(capped.tasks[0].id, "t0");
  });
});

describe("coms_describe is the only source of workload", () => {
  const root = join(import.meta.dirname, "../../../extensions");

  // The whole point of #1083: the peer reports itself. A filesystem read here would be the
  // #1072/#1080 failure mode — two components disagreeing about another process's state.
  it("keeps the workload and describe modules free of filesystem access", () => {
    for (const file of ["coms/coms-workload.ts", "coms/coms-describe.ts"]) {
      const source = readFileSync(join(root, file), "utf-8");
      assert.equal(/from\s+"node:fs/.test(source), false, `${file} must not import node:fs`);
      assert.equal(/\brequire\("(node:)?fs"\)/.test(source), false, `${file} must not require fs`);
      assert.equal(/\bstatSync\b|\breadFileSync\b|\bexistsSync\b|\breaddirSync\b/.test(source), false, `${file} must not stat or read files`);
    }
  });

  let server: net.Server | undefined;
  let tmpDir: string | undefined;
  const sockets = new Set<net.Socket>();

  afterEach(async () => {
    // A peer that never answers leaves the accepted socket half-open; closing the server
    // alone would wait for it forever.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => { server!.close(() => resolve()); }).catch(() => {});
      server = undefined;
    }
    if (tmpDir) { try { const { rmSync } = await import("node:fs"); rmSync(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = undefined; }
  });

  const listen = async (onConnection: (socket: net.Socket) => void): Promise<string> => {
    tmpDir = makeTempDir("coms-describe-");
    const path = join(tmpDir, "peer.sock");
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      onConnection(socket);
    });
    await new Promise<void>((resolve) => { server!.listen(path, () => resolve()); });
    return path;
  };

  it("returns the peer's detail from a describe_reply", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const answered = detail({ agents: [{ id: "a1", name: "worker", state: "running", elapsed: "1m", purpose: "p" }] });
    const endpoint = await listen((socket) => {
      socket.on("data", (chunk) => {
        assert.match(chunk.toString("utf-8"), /"type":"describe"/);
        socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: answered }) + "\n");
      });
    });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: true, detail: answered });
  });

  it("reports an answered-but-idle peer as ok with empty sections, not unknown", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: detail() }) + "\n"));
    });
    const result = await requestDescribe(endpoint, { timeoutMs: 1_000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && workloadSectionLines(result.detail), [WORKLOAD_NONE_LINE]);
  });

  it("reads unknown when the peer does not answer in time", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen(() => { /* never replies */ });
    const started = Date.now();
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 50 }), { ok: false, reason: "timeout" });
    assert.ok(Date.now() - started < 1_000, "timeout must be the configured one");
  });

  it("reads unknown when the peer answers with a malformed detail", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: { agents: 3 } }) + "\n"));
    });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("reads unknown when a non-empty section has no valid entry", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: { agents: [null], tasks: [], crons: [] } }) + "\n"));
    });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("refuses a reply larger than the buffer cap instead of growing memory", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const huge = "x".repeat(1024 * 1024 + 16);
    const endpoint = await listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: { agents: [], tasks: [], crons: [], pad: huge } }) + "\n"));
    });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 2_000 }), { ok: false, reason: "oversize" });
  });

  it("distinguishes a peer that answered null from one that never answered", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: null }) + "\n"));
    });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "no-sources" });
  });

  it("reads unknown when there is no endpoint to ask", async () => {
    assert.deepEqual(await requestDescribe(""), { ok: false, reason: "no-sources" });
  });
});
