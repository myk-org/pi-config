/**
 * #1090 — the peer's `☰n` is agent work in flight, so the owner's tasks must not inflate it, while
 * the drilldown still lists them (tagged) so they are visible rather than hidden.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  collectWorkload,
  toDescribeDetail,
  workloadSectionLines,
  type PeerWorkloadDetail,
  type WorkloadTask,
} from "../../../extensions/coms/coms-workload.js";
import { isPeerTaskCreator } from "../../../extensions/coms/coms-shared.js";
import { requestDescribe, validateDetail } from "../../../extensions/coms/coms-describe.js";
import { buildDrilldownRows } from "../../../extensions/coms/coms-drilldown.js";
import pitasks, { taskStore } from "../../../extensions/pitasks/index.js";
import { formatTaskRowLine } from "../../../extensions/pitasks/tasks-view.js";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";
import { clearWorkloadSources, publishWorkloadSources } from "../../../extensions/shared/workload-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const peerTask = (over: Partial<WorkloadTask> = {}): WorkloadTask => ({
  id: "1",
  status: "pending",
  subject: "do the thing",
  blockedBy: [],
  ...over,
});

const detail = (over: Partial<PeerWorkloadDetail> = {}): PeerWorkloadDetail => ({
  agents: [],
  tasks: [],
  crons: [],
  ...over,
});

describe("the peer count excludes the owner's tasks (#1090)", () => {
  it("counts agent tasks only, while keeping the owner's rows in the payload", () => {
    const { counts, active } = collectWorkload(
      [],
      [peerTask({ id: "1" }), peerTask({ id: "2", assignee: "user" })],
      [],
    );
    assert.equal(counts.tasks, 1, "☰n is agent work in flight");
    assert.deepEqual(active.tasks.map((task) => task.id), ["1", "2"], "the owner's task is still reported");
  });

  it("reports zero when the only open task belongs to the owner", () => {
    const { counts } = collectWorkload([], [peerTask({ id: "2", assignee: "user" })], []);
    assert.equal(counts.tasks, 0);
  });

  it("carries the assignee through the describe projection", () => {
    const projected = toDescribeDetail({
      agents: [],
      tasks: [peerTask({ id: "2", assignee: "user" })],
      crons: [],
    });
    assert.equal(projected.tasks[0].assignee, "user");
  });
});

describe("the drilldown shows the owner's task, tagged (#1090)", () => {
  it("renders [you] in the workload section rows", () => {
    const lines = workloadSectionLines(
      detail({ tasks: [{ id: "2", status: "pending", subject: "run the Discord test", blockedBy: [], assignee: "user" }] }),
    );
    assert.deepEqual(lines, ["tasks (1)", `  ${formatTaskRowLine({ id: "2", status: "pending", subject: "run the Discord test", blockedBy: [], assignee: "user" })}`]);
    assert.match(lines[1], /\[you\] run the Discord test/);
  });

  it("renders [you] in the drilldown item rows too", () => {
    const rows = buildDrilldownRows({
      ok: true,
      detail: detail({ tasks: [{ id: "2", status: "pending", subject: "run the Discord test", blockedBy: [], assignee: "user" }] }),
      truncated: {},
    });
    const tasksSection = rows.find((row) => row.section === "tasks");
    assert.ok(tasksSection);
    assert.match(tasksSection.items[0].row, /\[you\] run the Discord test/);
  });

  it("treats a peer that sends no assignee as the agent's task", () => {
    const rows = buildDrilldownRows({
      ok: true,
      detail: detail({ tasks: [{ id: "3", status: "pending", subject: "agent step", blockedBy: [] }] }),
      truncated: {},
    });
    assert.match(rows.find((row) => row.section === "tasks")?.items[0].row ?? "", /\[llm\] agent step/);
  });

  it("preserves assignee through validateDetail on peer replies", () => {
    const validated = validateDetail({
      tasks: [
        { id: "2", status: "pending", subject: "owner step", blockedBy: [], assignee: "user" },
        { id: "3", status: "pending", subject: "legacy step", blockedBy: [] },
      ],
    });
    assert.equal(validated.malformed, false);
    assert.equal(validated.detail.tasks[0]?.assignee, "user");
    assert.equal(validated.detail.tasks[1]?.assignee, undefined);
  });
});

describe("coms-p2p peer task boundaries (#1090)", { concurrency: false }, () => {
  let workspace: string | undefined;
  let replyServer: net.Server | undefined;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    if (replyServer) {
      await new Promise<void>((resolve) => { replyServer!.close(() => resolve()); }).catch(() => {});
      replyServer = undefined;
    }
    clearWorkloadSources();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  async function bootLivePeer(tag: string) {
    workspace = makeTempDir(`coms-assignee-${tag}-`);
    mkdirSync(join(workspace, ".pi"));
    writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: join(workspace, "coms") }));

    const subagent = process.env.PI_SUBAGENT_CHILD;
    const piTasks = process.env.PI_TASKS;
    process.env.PI_SUBAGENT_CHILD = "0";
    process.env.PI_TASKS = "off";
    try {
      const sessionId = `peer-${tag}`;
      const pitasksHandlers = new Map<string, Function>();
      pitasks({
        on(name: string, fn: Function) { pitasksHandlers.set(name, fn); },
        registerTool() {},
        registerCommand() {},
        events: { on() { return () => {}; }, emit() {} },
      } as any);
      cleanups.push(() => pitasksHandlers.get("session_shutdown")?.());
      await pitasksHandlers.get("session_start")!(
        { reason: "new" },
        { ui: { setWidget() {} }, sessionManager: { getSessionId: () => sessionId } },
      );

      publishWorkloadSources({ agents: () => [], crons: () => [] }, sessionId);

      let start: ((event: any, ctx: any) => Promise<void>) | undefined;
      let shutdown: (() => Promise<void>) | undefined;
      const comsPi = {
        registerFlag() {},
        getFlag: (f: string) => (f === "cname" ? `peer-${tag}` : undefined),
        registerTool() {},
        registerCommand() {},
        on(event: string, fn: any) {
          if (event === "session_start") start = fn;
          if (event === "session_shutdown") shutdown = fn;
        },
        sendMessage() {},
        events: { on() {}, emit() {} },
      };
      const initComs = (await import(`../../../extensions/coms/coms-p2p.ts?assignee=${tag}`)).default;
      initComs(comsPi as any);
      cleanups.push(() => {
        clearWorkloadSources(sessionId);
        return shutdown?.();
      });
      (globalThis as any).__piConfigSessionId = sessionId;
      await start!({}, {
        cwd: workspace,
        model: { id: "test-model" },
        hasUI: false,
        ui: { notify() {} },
        sessionManager: { getSessionId: () => sessionId },
      });
      const endpoint = (globalThis as any).__comsSelf?.endpoint as string;
      assert.ok(endpoint);
      return { endpoint, workspace };
    } finally {
      if (subagent === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = subagent;
      if (piTasks === undefined) delete process.env.PI_TASKS;
      else process.env.PI_TASKS = piTasks;
    }
  }

  async function sendTaskManage(targetEndpoint: string, dir: string, envelope: Record<string, any>): Promise<any> {
    if (replyServer) {
      await new Promise<void>((resolve) => { replyServer!.close(() => resolve()); }).catch(() => {});
      replyServer = undefined;
    }
    const replySock = join(dir, `reply-${Math.random().toString(36).slice(2, 8)}.sock`);
    const responsePromise = new Promise<any>((resolve) => {
      replyServer = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const parsed = JSON.parse(buf.slice(0, nl));
          sock.write(JSON.stringify({ type: "ack", msg_id: parsed.msg_id, status: "ok" }) + "\n");
          sock.end();
          resolve(parsed);
        });
      });
    });
    await new Promise<void>((resolve) => { replyServer!.listen(replySock, () => resolve()); });
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ path: targetEndpoint }, () => {
        client.write(
          JSON.stringify({
            type: "task_manage",
            msg_id: "tm-1",
            sender_endpoint: replySock,
            sender_name: "attacker",
            hops: 0,
            timestamp: new Date().toISOString(),
            ...envelope,
          }) + "\n",
        );
      });
      client.on("data", () => { client.end(); resolve(); });
      client.once("error", reject);
    });
    return responsePromise;
  }

  it("projects assignee from the live peer's describe handler", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint } = await bootLivePeer("describe");
    taskStore.create("owner step", "", { type: "local", origin: "user", session: "", project: "" }, undefined, undefined, "user");
    taskStore.create("agent step", "", { type: "local", origin: "system", session: "", project: "" });
    const result = await requestDescribe(endpoint, { timeoutMs: 1_500 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.detail.tasks.map((item) => ({ subject: item.subject, assignee: item.assignee })),
      [
        { subject: "owner step", assignee: "user" },
        { subject: "agent step", assignee: "llm" },
      ],
    );
  });

  it("rejects empty-session task_manage updates against local tasks", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint, workspace: dir } = await bootLivePeer("local-upd");
    const local = taskStore.create("local step", "", { type: "local", origin: "user", session: "", project: "" });
    const reply = await sendTaskManage(endpoint, dir, {
      sender_session: "",
      action: "update",
      task_id: local.id,
      fields: { subject: "hijacked" },
    });
    assert.match(String(reply.error), /ownership_denied/);
    assert.equal(taskStore.get(local.id)?.subject, "local step");
  });

  it("rejects empty-session task_manage deletes against local tasks", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint, workspace: dir } = await bootLivePeer("local-del");
    const local = taskStore.create("owner step", "", { type: "local", origin: "user", session: "", project: "" }, undefined, undefined, "user");
    const reply = await sendTaskManage(endpoint, dir, {
      sender_session: "",
      action: "delete",
      task_id: local.id,
    });
    assert.match(String(reply.error), /ownership_denied/);
    assert.ok(taskStore.get(local.id));
  });

  it("rejects peer task_manage completion of a user-assigned coms task", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint, workspace: dir } = await bootLivePeer("coms-owner");
    const owned = taskStore.create("owner step", "", { type: "coms", origin: "peer", session: "peer-sid", project: "" }, undefined, undefined, "user");
    const reply = await sendTaskManage(endpoint, dir, {
      sender_session: "peer-sid",
      action: "update",
      task_id: owned.id,
      fields: { status: "completed" },
    });
    assert.match(String(reply.error), /only the user/);
    assert.equal(taskStore.get(owned.id)?.status, "pending");
  });

  it("rejects two-step peer task_manage closure of a user-assigned coms task", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint, workspace: dir } = await bootLivePeer("two-step");
    const owned = taskStore.create("owner step", "", { type: "coms", origin: "peer", session: "peer-sid", project: "" }, undefined, undefined, "user");
    const flip = await sendTaskManage(endpoint, dir, {
      sender_session: "peer-sid",
      action: "update",
      task_id: owned.id,
      fields: { assignee: "llm" },
    });
    assert.match(String(flip.error), /only the user/);
    assert.equal(taskStore.get(owned.id)?.assignee, "user");
    const close = await sendTaskManage(endpoint, dir, {
      sender_session: "peer-sid",
      action: "update",
      task_id: owned.id,
      fields: { status: "completed" },
    });
    assert.match(String(close.error), /only the user/);
    assert.equal(taskStore.get(owned.id)?.status, "pending");
  });

  it("rejects peer task_manage spoofing of completedBy", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint, workspace: dir } = await bootLivePeer("comp-by");
    const peerOwned = taskStore.create("agent step", "", { type: "coms", origin: "peer", session: "peer-sid", project: "" });
    const reply = await sendTaskManage(endpoint, dir, {
      sender_session: "peer-sid",
      action: "update",
      task_id: peerOwned.id,
      fields: { status: "completed", completedBy: "user" },
    });
    assert.match(String(reply.error), /only the user/);
    assert.equal(taskStore.get(peerOwned.id)?.status, "pending");
    assert.equal(taskStore.get(peerOwned.id)?.completedBy, undefined);
  });

  it("rejects peer task_manage injection of completionNote", async (t) => {
    if (process.platform === "win32") return t.skip("unix sockets only");
    const { endpoint, workspace: dir } = await bootLivePeer("comp-note");
    const peerOwned = taskStore.create("agent step", "", { type: "coms", origin: "peer", session: "peer-sid", project: "" });
    const reply = await sendTaskManage(endpoint, dir, {
      sender_session: "peer-sid",
      action: "update",
      task_id: peerOwned.id,
      fields: { status: "completed", completionNote: "forged outcome" },
    });
    assert.match(String(reply.error), /only the user/);
    assert.equal(taskStore.get(peerOwned.id)?.completionNote, undefined);
  });
});

describe("peer task ownership logging (#1090)", () => {
  it("logs peer_task_creator_check decisions at debug level", () => {
    const tmpHome = makeTempDir("coms-creator-log-");
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedLevel = process.env.PI_LOG_COMS;
    const savedSid = (globalThis as any).__piConfigSessionId;
    try {
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.PI_LOG_COMS = "debug";
      setGlobalSessionId("coms-creator-check-test");
      clearLogLevelCache();

      assert.equal(isPeerTaskCreator({ type: "coms", session: "peer-1" }, "peer-1"), true);
      assert.equal(isPeerTaskCreator({ type: "local", session: "" }, ""), false);

      const logPath = getPiLogPath("coms");
      assert.ok(logPath && existsSync(logPath));
      assert.match(readFileSync(logPath, "utf-8"), /peer_task_creator_check/);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedLevel === undefined) delete process.env.PI_LOG_COMS;
      else process.env.PI_LOG_COMS = savedLevel;
      if (savedSid !== undefined) setGlobalSessionId(savedSid);
      clearLogLevelCache();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
