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
  openBlockers,
  renderWorkloadPart,
  toDescribeDetail,
  WORKLOAD_NONE_LINE,
  WORKLOAD_UNKNOWN_LINE,
  workloadSectionLines,
  workloadUnknownLine,
  type PeerWorkloadDetail,
} from "../../../extensions/coms/coms-workload.js";
import { classifyNack, requestDescribe, validateDetail, DESCRIBE_MAX_ENTRIES } from "../../../extensions/coms/coms-describe.js";
import { sanitizePeerText } from "../../../extensions/coms/peer-text.js";
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

const cron = (over: Partial<{ id: string; scope: string; description: string; task: string; createdAt: number; intervalMs?: number; leader?: boolean; paused?: boolean }> = {}) => ({
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

describe("active counts (#1083)", () => {
  it("counts only running agents", () => {
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

  it("never counts a paused cron as active work (#1089)", () => {
    assert.equal(isActiveCron({ paused: true }), false);
    assert.equal(isActiveCron({ paused: true, leader: true }), false);
    assert.equal(isActiveCron({ paused: false }), true);
  });

  it("drops a paused cron from the counts and the detail rows (#1089)", () => {
    const crons = [cron({ id: "session:c1" }), cron({ id: "session:c2", paused: true })];
    const { counts, active } = collectWorkload([], [], crons);
    assert.deepEqual(counts, { agents: 0, tasks: 0, crons: 1 });
    assert.deepEqual(toDescribeDetail(active).crons.map((c) => c.id), ["session:c1"]);
    assert.equal(formatWorkloadSuffix(counts), " ⏰1");
  });

  it("reports none active when only a paused cron runs (#1089)", () => {
    const { counts, active } = collectWorkload([], [], [cron({ id: "session:c1", paused: true })]);
    assert.deepEqual(counts, { agents: 0, tasks: 0, crons: 0 });
    assert.deepEqual(workloadSectionLines(toDescribeDetail(active)), [WORKLOAD_NONE_LINE]);
    assert.equal(formatWorkloadSuffix(counts), "");
  });

  it("collects the active counts", () => {
    const { counts } = collectWorkload(
      [agent({ id: "a1" }), agent({ id: "a2", status: "queued" }), agent({ id: "a3", status: "complete" }), agent({ id: "a4", status: "failed" })],
      [task({ id: "1" }), task({ id: "2", status: "in_progress" }), task({ id: "3", status: "completed" })],
      [cron({ id: "session:c1" }), cron({ id: "persist:c2", scope: "project", leader: false })],
    );
    assert.deepEqual(counts, { agents: 1, tasks: 2, crons: 1 });
  });

  it("collects the active entries themselves", () => {
    const { active } = collectWorkload(
      [agent({ id: "a1" }), agent({ id: "a2", status: "queued" })],
      [task({ id: "1" }), task({ id: "3", status: "completed" })],
      [cron({ id: "session:c1" }), cron({ id: "persist:c2", scope: "project", leader: false })],
    );
    assert.deepEqual(active.agents.map((a) => a.id), ["a1"]);
    assert.deepEqual(active.tasks.map((t) => t.id), ["1"]);
    assert.deepEqual(active.crons.map((c) => c.id), ["session:c1"]);
  });
});

describe("blockers (#1084)", () => {
  it("keeps a blocker that is still open", () => {
    const status = new Map([["3", "in_progress"]]);
    assert.deepEqual(openBlockers(["3"], status), ["3"]);
  });

  it("drops a blocker that is already completed", () => {
    const status = new Map([["3", "completed"]]);
    assert.deepEqual(openBlockers(["3"], status), []);
  });

  it("drops a blocker that no longer exists", () => {
    assert.deepEqual(openBlockers(["9"], new Map()), []);
  });
});

describe("drilldown payload (#1083)", () => {
  it("ships the projected agent record", () => {
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
  });

  it("ships nothing but the five agent fields", () => {
    const projected = toDescribeDetail({ agents: [agent()], tasks: [], crons: [] }, 1_000);
    // Job output, worker dirs and other internals never cross the socket.
    assert.deepEqual(Object.keys(projected.agents[0]).sort(), ["elapsed", "id", "name", "purpose", "state"]);
  });

  it("keeps the open blockers so the drilldown can mark a blocked task", () => {
    const projected = toDescribeDetail({ agents: [], tasks: [task({ id: "7", status: "pending", subject: "Wire heartbeat", blockedBy: ["1", "2"] })], crons: [] }, 0);
    assert.deepEqual(projected.tasks, [{ id: "7", status: "pending", subject: "Wire heartbeat", blockedBy: ["1", "2"] }]);
  });

  it("pre-formats the cron schedule", () => {
    const projected = toDescribeDetail({ agents: [], tasks: [], crons: [cron({ intervalMs: 30 * 60_000 })] }, 1_000);
    assert.equal(projected.crons[0].schedule, "every 30m");
  });

  it("pre-formats the cron next-run label", () => {
    const projected = toDescribeDetail({ agents: [], tasks: [], crons: [cron({ intervalMs: 30 * 60_000 })] }, 10 * 60_000 + 1_000);
    assert.match(projected.crons[0].next, /^in \d+m$|^soon$/);
  });

  it("sanitizes whatever the peer sent", () => {
    const projected = toDescribeDetail(
      { agents: [agent({ task: "\x1b[2Jcleared" })], tasks: [task({ subject: "a\x1b]0;title\x07b" })], crons: [] },
      1_000,
    );
    assert.equal(projected.agents[0].purpose, "cleared");
    assert.equal(projected.tasks[0].subject, "ab");
  });
});

describe("workload widget suffix", () => {
  it("renders only the non-zero counts", () => {
    assert.equal(formatWorkloadSuffix({ agents: 2, tasks: 5, crons: 1 }), " ⏳2 ☰5 ⏰1");
    assert.equal(formatWorkloadSuffix({ agents: 0, tasks: 3, crons: 0 }), " ☰3");
    // The count is OPEN work that mixes pending and in-progress: a tick would claim "done", and a
    // row glyph would claim one state the aggregate does not have.
    for (const suffix of [
      formatWorkloadSuffix({ agents: 0, tasks: 3, crons: 0 }),
      formatWorkloadSuffix({ agents: 2, tasks: 5, crons: 1 }),
    ]) {
      for (const glyph of ["✓", "◻", "◼"]) assert.equal(suffix.includes(glyph), false, `no ${glyph} in ${suffix}`);
    }
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

describe("peer text sanitization (#1084)", () => {
  it("strips a screen-clear sequence", () => {
    assert.equal(sanitizePeerText("\x1b[2Jhello"), "hello");
  });

  it("strips a window-title sequence", () => {
    assert.equal(sanitizePeerText("a\x1b]0;forged\x07b"), "ab");
  });

  it("collapses whitespace into one space", () => {
    assert.equal(sanitizePeerText("a\nb\tc\r\nd"), "a b c d");
  });

  it("caps a very long field", () => {
    assert.equal(sanitizePeerText("x".repeat(500), 120).length, 120);
  });

  it("drops C1 control characters", () => {
    assert.equal(sanitizePeerText("a\u009bb"), "ab");
  });

  it("leaves ordinary text alone", () => {
    assert.equal(sanitizePeerText("Wire the heartbeat"), "Wire the heartbeat");
  });
});

describe("workload drilldown sections", () => {
  it("renders all three sections with the shared row format", () => {
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

  it("strips control sequences a peer put in a row", () => {
    const lines = workloadSectionLines(
      detail({ agents: [{ id: "job-1", name: "", state: "running\x1b[2J", elapsed: "1m", purpose: "\x1b]0;x\x07purpose" }] }),
    );
    assert.equal(lines[1], "  job-1  running  1m  purpose");
  });

  it("says so when an answered peer has nothing active", () => {
    assert.deepEqual(workloadSectionLines(detail()), [WORKLOAD_NONE_LINE]);
  });

  it("shows how many rows the cap trimmed", () => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({ id: String(i), status: "pending", subject: "s", blockedBy: [] }));
    const lines = workloadSectionLines(detail({ tasks }), { tasks: 12 });
    assert.equal(lines.at(-1), "  … 12 more");
  });

  it("has one honest line per failure reason", () => {
    assert.equal(workloadUnknownLine("not-reported"), "workload  unknown (not reported)");
    assert.equal(workloadUnknownLine("timeout"), WORKLOAD_UNKNOWN_LINE);
    assert.equal(workloadUnknownLine("unreachable"), WORKLOAD_UNKNOWN_LINE);
    assert.equal(workloadUnknownLine("malformed"), "workload  unknown (malformed reply)");
    assert.equal(workloadUnknownLine("oversize"), "workload  unknown (reply too large)");
  });

  it("renders a peer error with its local code", () => {
    assert.equal(workloadUnknownLine("peer-error", "internal-error"), "workload  unknown (error: internal-error)");
  });

  it("never renders peer error text in the line", () => {
    const line = workloadUnknownLine("peer-error", "\x1b[2Jpwned");
    assert.equal(line.includes("\x1b"), false);
    assert.equal(line, "workload  unknown (error: pwned)");
  });
});

describe("describe reply validation (#1083)", () => {
  it("keeps the valid entries", () => {
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
    assert.deepEqual(validateDetail({ tasks: [] }), {
      detail: { agents: [], tasks: [], crons: [] },
      malformed: false,
      truncated: { agents: 0, tasks: 0, crons: 0 },
    });
  });

  it("calls a wrong-typed section malformed instead of empty", () => {
    const { detail: empty, malformed } = validateDetail({ agents: 3 });
    assert.deepEqual(empty.agents, []);
    assert.equal(malformed, true);
  });

  it("calls a reply that names no section malformed", () => {
    assert.equal(validateDetail({}).malformed, true);
  });

  it("caps each section at the entry limit", () => {
    const many = Array.from({ length: DESCRIBE_MAX_ENTRIES + 5 }, (_, i) => ({ id: `t${i}`, status: "pending", subject: "s" }));
    const { detail: capped } = validateDetail({ tasks: many });
    assert.equal(capped.tasks.length, DESCRIBE_MAX_ENTRIES);
    assert.equal(capped.tasks[0].id, "t0");
  });

  it("reports how many entries the cap trimmed", () => {
    const many = Array.from({ length: DESCRIBE_MAX_ENTRIES + 5 }, (_, i) => ({ id: `t${i}`, status: "pending", subject: "s" }));
    assert.equal(validateDetail({ tasks: many }).truncated.tasks, 5);
  });
});

describe("coms_describe is the only source of workload", () => {
  const root = join(import.meta.dirname, "../../../extensions");

  // The whole point of #1083: the peer reports itself. A filesystem read here would be the
  // #1072/#1080 failure mode — two components disagreeing about another process's state.
  it("keeps the workload modules free of filesystem access", () => {
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

  const replyWith = async (reply: unknown): Promise<string> =>
    listen((socket) => {
      socket.on("data", () => socket.write(JSON.stringify(reply) + "\n"));
    });

  it("returns the peer's detail from a describe_reply", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const answered = detail({ agents: [{ id: "a1", name: "worker", state: "running", elapsed: "1m", purpose: "p" }] });
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: answered });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), {
      ok: true,
      detail: answered,
      truncated: { agents: 0, tasks: 0, crons: 0 },
    });
  });

  it("reports an answered-but-idle peer as ok with empty sections", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: detail() });
    const result = await requestDescribe(endpoint, { timeoutMs: 1_000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && workloadSectionLines(result.detail), [WORKLOAD_NONE_LINE]);
  });

  it("carries the truncation counts into the renderer", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const many = Array.from({ length: DESCRIBE_MAX_ENTRIES + 2 }, (_, i) => ({ id: String(i), status: "pending", subject: "s", blockedBy: [] }));
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: detail({ tasks: many }) });
    const result = await requestDescribe(endpoint, { timeoutMs: 1_000 });
    assert.equal(result.ok && result.truncated.tasks, 2);
    assert.equal(result.ok && workloadSectionLines(result.detail, result.truncated).at(-1), "  … 2 more");
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
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: { agents: 3 } });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("never reads a reply with no detail as an idle peer", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x" });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("never reads a non-object detail as an idle peer", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: "nope" });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("never reads an empty reply object as an idle peer", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({});
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("reads unknown when a non-empty section has no valid entry", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: { agents: [null], tasks: [], crons: [] } });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "malformed" });
  });

  it("classifies an unsupported-describe nack as not reported", () => {
    assert.deepEqual(classifyNack("unknown type"), { ok: false, reason: "not-reported" });
  });

  it("classifies a malformed-envelope nack as a peer error", () => {
    assert.deepEqual(classifyNack("malformed envelope"), { ok: false, reason: "peer-error", code: "malformed-envelope" });
  });

  it("classifies an internal-failure nack as a peer error", () => {
    assert.deepEqual(classifyNack("internal error"), { ok: false, reason: "peer-error", code: "internal-error" });
  });

  it("never echoes unrecognised nack text as a code", () => {
    const result = classifyNack("\x1b[2J something odd");
    assert.equal(result.reason, "peer-error");
    assert.equal(result.ok, false);
    assert.equal(String(result.code).includes("\x1b"), false);
  });

  it("returns the peer-error code over a socket", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "nack", msg_id: "x", error: "malformed envelope" });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "peer-error", code: "malformed-envelope" });
  });

  it("reports an older peer that nacks describe as not reported", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "nack", msg_id: "x", error: "unknown type" });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "not-reported" });
  });

  it("reports a peer that says it cannot report as not reported", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: null });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 1_000 }), { ok: false, reason: "not-reported" });
  });

  it("reports a withered connection as no reply", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    tmpDir = makeTempDir("coms-describe-dead-");
    const endpoint = join(tmpDir, "absent.sock");
    const result = await requestDescribe(endpoint, { timeoutMs: 1_000 });
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
  });

  it("refuses a reply larger than the buffer cap instead of growing memory", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const huge = "x".repeat(1024 * 1024 + 16);
    const endpoint = await replyWith({ type: "describe_reply", msg_id: "x", detail: { agents: [], tasks: [], crons: [], pad: huge } });
    assert.deepEqual(await requestDescribe(endpoint, { timeoutMs: 2_000 }), { ok: false, reason: "oversize" });
  });

  it("reads unknown when there is no endpoint to ask", async () => {
    assert.deepEqual(await requestDescribe(""), { ok: false, reason: "not-reported" });
  });
});
