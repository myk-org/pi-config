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
  WORKLOAD_UNKNOWN_LINE,
  workloadSectionLines,
  type PeerWorkloadDetail,
} from "../../../extensions/coms/coms-workload.js";
import { requestDescribe } from "../../../extensions/coms/coms-describe.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const agent = (over: Partial<{ id: string; agent: string; name: string; task: string; status: string; startedAt: number }> = {}) => ({
  id: "a1",
  agent: "python-expert",
  task: "fix the thing",
  status: "running",
  startedAt: 1_000,
  ...over,
});

const task = (over: Partial<{ id: string; status: string; subject: string }> = {}) => ({
  id: "1",
  status: "pending",
  subject: "do the thing",
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

describe("workload is active-only (#1083)", () => {
  it("counts agents that are not complete or failed", () => {
    assert.equal(isActiveAgent({ status: "running" }), true);
    assert.equal(isActiveAgent({ status: "queued" }), true);
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

  it("collects counts and the same active detail", () => {
    const { counts, detail } = collectWorkload(
      [agent({ id: "a1" }), agent({ id: "a2", status: "queued" }), agent({ id: "a3", status: "complete" }), agent({ id: "a4", status: "failed" })],
      [task({ id: "1" }), task({ id: "2", status: "in_progress" }), task({ id: "3", status: "completed" })],
      [cron({ id: "session:c1" }), cron({ id: "persist:c2", scope: "project", leader: false })],
    );
    assert.deepEqual(counts, { agents: 2, tasks: 2, crons: 1 });
    assert.deepEqual(detail.agents.map((a) => a.id), ["a1", "a2"]);
    assert.deepEqual(detail.tasks.map((t) => t.id), ["1", "2"]);
    assert.deepEqual(detail.crons.map((c) => c.id), ["session:c1"]);
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
  it("renders agents, tasks and crons with the existing formatters", () => {
    const now = 10 * 60_000 + 1_000;
    const detail: PeerWorkloadDetail = {
      agents: [agent({ id: "a1", agent: "ts-expert", status: "running", task: "migrate\nthe  widget", startedAt: 1_000 })],
      tasks: [task({ id: "7", status: "in_progress", subject: "Wire heartbeat" })],
      crons: [cron({ id: "session:c9", description: "nightly audit", intervalMs: 30 * 60_000 })],
    };
    const lines = workloadSectionLines(detail, now);
    assert.equal(lines[0], "agents (1)");
    assert.match(lines[1], /^ {2}ts-expert {2}running {2}10m0s {2}migrate the widget$/);
    assert.equal(lines[2], "tasks (1)");
    // The SAME row format /tasks renders (#1082/#1083: one definition in tasks-view).
    assert.equal(lines[3], "  ◼ #7 [in_progress] Wire heartbeat");
    assert.equal(lines[4], "crons (1)");
    assert.match(lines[5], /^ {2}session:c9 {2}every 30m {2}.+ {2}nightly audit$/);
  });

  it("omits empty sections and says so when nothing is active", () => {
    const lines = workloadSectionLines({ agents: [], tasks: [], crons: [] }, 0);
    assert.deepEqual(lines, ["workload  none active"]);
  });

  it("reads unknown when the peer never answered", () => {
    assert.deepEqual(workloadSectionLines(null), [WORKLOAD_UNKNOWN_LINE]);
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
    const detail: PeerWorkloadDetail = { agents: [agent()], tasks: [], crons: [] };
    const endpoint = await listen((socket) => {
      socket.on("data", (chunk) => {
        assert.match(chunk.toString("utf-8"), /"type":"describe"/);
        socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail }) + "\n");
      });
    });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), detail);
  });

  it("reads unknown when the peer does not answer in time", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen(() => { /* never replies */ });
    const started = Date.now();
    assert.equal(await requestDescribe(endpoint, { timeoutMs: 50 }), null);
    assert.ok(Date.now() - started < 1_000, "timeout must be the configured one");
  });

  it("reads unknown for a peer that answers with a malformed detail", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify({ type: "describe_reply", msg_id: "x", detail: { agents: 3 } }) + "\n"));
    });
    assert.equal(await requestDescribe(endpoint, { timeoutMs: 1_000 }), null);
  });

  it("reads unknown when there is no endpoint to ask", async () => {
    assert.equal(await requestDescribe(""), null);
  });
});
