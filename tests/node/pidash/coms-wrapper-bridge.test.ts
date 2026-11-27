/**
 * #1481 — Unit tests for coms-wrapper PiDash bridge (`pidash:coms-peers-request`,
 * `pidash:coms-kill`, tab-isolated `allPeers`) and dreaming PiDash bridge (`pidash:memory-dream-request`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerComs } from "../../../extensions/coms/coms-wrapper.ts";
import { registerDreaming } from "../../../extensions/orchestrator/dreaming.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

type Handler = (data: unknown) => void;

function createFakePi() {
  const listeners = new Map<string, Handler[]>();
  const lifecycle = new Map<string, Array<(ev: any, ctx: any) => any>>();
  const emitted: Array<{ channel: string; data: any }> = [];
  const pi: any = {
    registerCommand: () => {},
    registerTool: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    getFlag: () => undefined,
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    on: (name: string, fn: (ev: any, ctx: any) => any) => {
      const list = lifecycle.get(name) ?? [];
      list.push(fn);
      lifecycle.set(name, list);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
      on: (channel: string, fn: Handler) => {
        const list = listeners.get(channel) ?? [];
        list.push(fn);
        listeners.set(channel, list);
        return () => {
          listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== fn));
        };
      },
    },
  };
  return {
    pi,
    emitted,
    fireEvent: (channel: string, data?: unknown) => {
      for (const h of [...(listeners.get(channel) ?? [])]) h(data);
    },
    shutdown: async () => {
      for (const h of lifecycle.get("session_shutdown") ?? []) await h({ reason: "quit" }, {});
    },
  };
}

function seedLivePeer(comsDir: string, project: string, name: string, pid: number): void {
  const dir = join(comsDir, "projects", project, "agents");
  const sockDir = join(comsDir, "sockets");
  const endpoint = join(sockDir, `${name}.sock`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockDir, { recursive: true });
  writeFileSync(endpoint, "");
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({
      coms_session_id: `sid-${project}-${name}`,
      name,
      purpose: `work-${name}`,
      model: "gemini-4-neon",
      color: "#00bcd4",
      pid,
      endpoint,
      cwd: `/tmp/${project}`,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      busy: false,
      queue_depth: 0,
      context_used_pct: 15,
      explicit: false,
      version: 1,
    }),
  );
}

describe("coms-wrapper PiDash bridge (#1481)", () => {
  it("emits scoped project peers alongside allPeers on pidash:coms-peers-request", async () => {
    const dir = makeTempDir("coms-bridge-scope-");
    const fake = createFakePi();
    try {
      const ownProj = process.cwd().replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
      seedLivePeer(dir, ownProj, "peer-local", process.pid);
      seedLivePeer(dir, "other-project", "peer-remote", process.pid);

      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      fake.fireEvent("pidash:coms-peers-request", { scope: "project", requestId: "req-1" });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-peers");
      assert.ok(evt, "pidash:coms-peers emitted");
      assert.equal(evt!.data.scope, "project");
      assert.equal(evt!.data.requestId, "req-1");
      assert.deepEqual(evt!.data.peers.map((p: any) => p.name), ["peer-local"]);
      assert.deepEqual(
        evt!.data.allPeers.map((p: any) => p.name).sort(),
        ["peer-local", "peer-remote"],
      );
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits all projects when pidash:coms-peers-request asks for all scope", async () => {
    const dir = makeTempDir("coms-bridge-all-");
    const fake = createFakePi();
    try {
      const ownProj = process.cwd().replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
      seedLivePeer(dir, ownProj, "peer-local", process.pid);
      seedLivePeer(dir, "other-project", "peer-remote", process.pid);

      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      fake.fireEvent("pidash:coms-peers-request", { scope: "all", requestId: "req-all" });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-peers");
      assert.ok(evt);
      assert.equal(evt!.data.scope, "all");
      assert.deepEqual(
        evt!.data.peers.map((p: any) => p.name).sort(),
        ["peer-local", "peer-remote"],
      );
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits error pidash:coms-kill-result when peer name is missing", async () => {
    const dir = makeTempDir("coms-bridge-kill-empty-");
    const fake = createFakePi();
    try {
      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      fake.fireEvent("pidash:coms-kill", { requestId: "kill-empty", name: "" });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-kill-result");
      assert.ok(evt);
      assert.equal(evt!.data.requestId, "kill-empty");
      assert.equal(evt!.data.ok, false);
      assert.equal(evt!.data.killed, 0);
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses pidash:coms-kill for an unsupervised peer", async () => {
    const dir = makeTempDir("coms-bridge-kill-unsup-");
    const fake = createFakePi();
    try {
      const ownProj = process.cwd().replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
      seedLivePeer(dir, ownProj, "human-session", process.pid);

      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      fake.fireEvent("pidash:coms-kill", {
        requestId: "kill-unsup",
        name: "human-session",
        project: ownProj,
      });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-kill-result");
      assert.ok(evt);
      assert.equal(evt!.data.requestId, "kill-unsup");
      assert.equal(evt!.data.ok, false);
      assert.equal(evt!.data.killed, 0);
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dreaming PiDash bridge (#1481)", () => {
  it("starts dreaming via spawnAsyncAgent on pidash:memory-dream-request", async () => {
    const dir = makeTempDir("dream-bridge-");
    const fake = createFakePi();
    let spawned = 0;
    try {
      registerDreaming(fake.pi, () => {
        spawned++;
        return { started: true, id: "dream-job-42" };
      });
      fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: "dream-req-1" });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:memory-dream-result");
      assert.ok(evt, "pidash:memory-dream-result emitted");
      assert.equal(spawned, 1);
      assert.equal(evt!.data.requestId, "dream-req-1");
      assert.equal(evt!.data.ok, true);
      assert.equal(evt!.data.id, "dream-job-42");
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
