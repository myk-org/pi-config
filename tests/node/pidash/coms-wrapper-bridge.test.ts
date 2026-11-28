/**
 * #1481 — Unit tests for coms-wrapper PiDash bridge (`pidash:coms-peers-request`,
 * `pidash:coms-kill`, tab-isolated `allPeers`) and dreaming PiDash bridge (`pidash:memory-dream-request`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createComsPeerRuntime, type ComsPeerRuntime } from "../../../extensions/coms/coms-p2p.ts";
import { registerComs } from "../../../extensions/coms/coms-wrapper.ts";
import { registerDreaming } from "../../../extensions/orchestrator/dreaming.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

type Handler = (data: unknown) => any;

function createFakePi(flags?: Map<string, any>) {
  const listeners = new Map<string, Handler[]>();
  const lifecycle = new Map<string, Array<(ev: any, ctx: any) => any>>();
  const emitted: Array<{ channel: string; data: any }> = [];
  const messages: any[] = [];
  const pi: any = {
    registerCommand: () => {},
    registerTool: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    getFlag: (name: string) => flags?.get(name),
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: (msg: any) => { messages.push(msg); },
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
    messages,
    fireEvent: (channel: string, data?: unknown) => {
      for (const h of [...(listeners.get(channel) ?? [])]) h(data);
    },
    fireEventAsync: async (channel: string, data?: unknown) => {
      for (const h of [...(listeners.get(channel) ?? [])]) await h(data);
    },
    fireLifecycle: async (name: string, ev: any = {}, ctx: any = {}) => {
      for (const h of [...(lifecycle.get(name) ?? [])]) await h(ev, ctx);
    },
    shutdown: async (ev: any = { reason: "quit" }, ctx: any = {}) => {
      for (const h of lifecycle.get("session_shutdown") ?? []) await h(ev, ctx);
    },
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`waitUntil timed out after ${timeoutMs}ms`);
}

async function bootActiveQueuePeer(workspace: string, sessionId: string) {
  const comsDir = join(workspace, "coms");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));

  const flags = new Map<string, any>([
    ["cname", "receiver"],
    ["project", "test-proj"],
  ]);
  const fake = createFakePi(flags);
  const runtime: ComsPeerRuntime = createComsPeerRuntime(fake.pi, {
    deferred: false,
    comsDir,
    sessionId,
    allowSubagentChild: true,
    registerSignalHandlers: false,
  });

  const ctx = {
    cwd: workspace,
    model: { id: "test-model" },
    hasUI: false,
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
  };
  await fake.fireLifecycle("session_start", {}, ctx);
  const self = runtime.getSelf();
  assert.ok(self?.registryFile, "peer wrote registry file");
  const reg = JSON.parse(readFileSync(self.registryFile, "utf-8"));
  return { fake, runtime, comsDir, endpoint: reg.endpoint as string };
}

async function createPromptSender(endpoint: string, senderSession: string, senderName: string, cwd: string) {
  const received: any[] = [];
  const sockets: net.Socket[] = [];
  const srv = net.createServer((sock) => {
    sockets.push(sock);
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const env = JSON.parse(line);
        received.push(env);
        try {
          sock.write(JSON.stringify({ type: "ack", msg_id: env.msg_id ?? "" }) + "\n");
        } catch { /* ignore */ }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(endpoint, () => resolve());
  });

  const sendPrompt = (receiverEndpoint: string, msgId: string, prompt: string) =>
    new Promise<any>((resolve, reject) => {
      const sock = net.createConnection({ path: receiverEndpoint });
      sockets.push(sock);
      let buf = "";
      sock.on("connect", () => {
        sock.write(
          JSON.stringify({
            type: "prompt",
            msg_id: msgId,
            sender_session: senderSession,
            sender_name: senderName,
            sender_endpoint: endpoint,
            sender_cwd: cwd,
            prompt,
            hops: 0,
            timestamp: new Date().toISOString(),
          }) + "\n",
        );
      });
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          sock.destroy();
          resolve(JSON.parse(buf.slice(0, nl)));
        }
      });
      sock.on("error", reject);
    });

  const close = () => {
    for (const s of sockets.splice(0)) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    try { srv.close(); } catch { /* ignore */ }
  };

  return { received, sendPrompt, close };
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

describe("coms-p2p PiDash queue bridge (#1481)", () => {
  it("emits pidash:coms-queue with items and active on pidash:coms-queue-request", async () => {
    const dir = makeTempDir("coms-queue-req-");
    const fake = createFakePi();
    try {
      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      fake.fireEvent("pidash:coms-queue-request");

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-queue");
      assert.ok(evt, "pidash:coms-queue emitted");
      assert.deepEqual(evt!.data.items, []);
      assert.equal(evt!.data.active, false);
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits msg_id required error when pidash:coms-queue-kill receives empty or whitespace msg_id", async () => {
    const dir = makeTempDir("coms-queue-kill-empty-");
    const fake = createFakePi();
    try {
      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      await fake.fireEventAsync("pidash:coms-queue-kill", { requestId: "qkill-blank", msg_id: "   " });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-queue-kill-result");
      assert.ok(evt, "pidash:coms-queue-kill-result emitted");
      assert.deepEqual(evt!.data, {
        requestId: "qkill-blank",
        ok: false,
        error: "msg_id required",
      });
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits not found error and re-emits pidash:coms-queue when pidash:coms-queue-kill receives unknown msg_id", async () => {
    const dir = makeTempDir("coms-queue-kill-unknown-");
    const fake = createFakePi();
    try {
      registerComs(fake.pi, { comsDir: dir, allowSubagentChild: true, registerSignalHandlers: false });
      const beforeQueueCount = fake.emitted.filter((e) => e.channel === "pidash:coms-queue").length;
      await fake.fireEventAsync("pidash:coms-queue-kill", { requestId: "qkill-missing", msg_id: "no-such-msg" });

      const resultEvt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:coms-queue-kill-result");
      assert.ok(resultEvt, "pidash:coms-queue-kill-result emitted");
      assert.equal(resultEvt!.data.requestId, "qkill-missing");
      assert.equal(resultEvt!.data.ok, false);
      assert.equal(resultEvt!.data.msg_id, "no-such-msg");
      assert.match(resultEvt!.data.error, /not found/i);

      const queueEvts = fake.emitted.filter((e) => e.channel === "pidash:coms-queue");
      assert.equal(queueEvts.length, beforeQueueCount + 1);
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels a queued inbound message on pidash:coms-queue-kill and re-emits updated pidash:coms-queue", async () => {
    const dir = makeTempDir("coms-queue-kill-real-");
    let peer: Awaited<ReturnType<typeof bootActiveQueuePeer>> | null = null;
    let sender: Awaited<ReturnType<typeof createPromptSender>> | null = null;
    try {
      peer = await bootActiveQueuePeer(dir, "sess-qkill-real");
      sender = await createPromptSender(join(peer.comsDir, "sender-qkill.sock"), "sess-sender", "coordinator", dir);

      await sender.sendPrompt(peer.endpoint, "msg-active", "Active work");
      await waitUntil(() => peer!.fake.messages.some((m) => m?.details?.msg_id === "msg-active"));
      await sender.sendPrompt(peer.endpoint, "msg-queued", "Queued work to cancel");

      await peer.fake.fireEventAsync("pidash:coms-queue-kill", {
        requestId: "qkill-ok-1",
        msg_id: "msg-queued",
      });

      const resultEvt = [...peer.fake.emitted].reverse().find((e) => e.channel === "pidash:coms-queue-kill-result");
      assert.ok(resultEvt, "pidash:coms-queue-kill-result emitted");
      assert.equal(resultEvt!.data.requestId, "qkill-ok-1");
      assert.equal(resultEvt!.data.ok, true);
      assert.equal(resultEvt!.data.msg_id, "msg-queued");
      assert.equal(resultEvt!.data.sender_name, "coordinator");

      const queueEvt = [...peer.fake.emitted].reverse().find((e) => e.channel === "pidash:coms-queue");
      assert.ok(queueEvt, "pidash:coms-queue re-emitted");
      assert.equal(queueEvt!.data.active, true);
      assert.deepEqual(
        queueEvt!.data.items.map((i: any) => i.msg_id),
        ["msg-active"],
      );
    } finally {
      sender?.close();
      if (peer) await peer.runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits empty inactive pidash:coms-queue when Coms stops while an inbound item is present", async () => {
    const dir = makeTempDir("coms-queue-stop-clear-");
    let peer: Awaited<ReturnType<typeof bootActiveQueuePeer>> | null = null;
    let sender: Awaited<ReturnType<typeof createPromptSender>> | null = null;
    try {
      peer = await bootActiveQueuePeer(dir, "sess-qstop");
      sender = await createPromptSender(join(peer.comsDir, "sender-qstop.sock"), "sess-sender", "coordinator", dir);

      await sender.sendPrompt(peer.endpoint, "msg-inflight", "In-flight work");
      await waitUntil(() => peer!.fake.messages.some((m) => m?.details?.msg_id === "msg-inflight"));

      await peer.runtime.stop();

      const queueEvt = [...peer.fake.emitted].reverse().find((e) => e.channel === "pidash:coms-queue");
      assert.ok(queueEvt, "pidash:coms-queue emitted on stop");
      assert.deepEqual(queueEvt!.data, { items: [], active: false });
    } finally {
      sender?.close();
      if (peer) await peer.runtime.stop();
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
      withSubagentChildEnv(undefined, () => {
        registerDreaming(fake.pi, () => {
          spawned++;
          return { started: true, id: "dream-job-42" };
        });
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

  for (const reason of ["new", "fork", "resume"] as const) {
    it(`keeps pidash:memory-dream-request working after session_shutdown(${reason})`, async () => {
      const dir = makeTempDir(`dream-bridge-${reason}-`);
      const fake = createFakePi();
      let spawned = 0;
      try {
        withSubagentChildEnv(undefined, () => {
          registerDreaming(fake.pi, () => {
            spawned++;
            return { started: true, id: `dream-job-${reason}` };
          });
        });
        await fake.shutdown({ reason });
        fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: `dream-req-${reason}` });

        const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:memory-dream-result");
        assert.ok(evt, "pidash:memory-dream-result emitted");
        assert.equal(spawned, 1);
        assert.equal(evt!.data.requestId, `dream-req-${reason}`);
        assert.equal(evt!.data.ok, true);
      } finally {
        await fake.shutdown();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("re-subscribes pidash:memory-dream-request after session_shutdown(reload) followed by session_start", async () => {
    const dir = makeTempDir("dream-bridge-reload-");
    const fake = createFakePi();
    let spawned = 0;
    try {
      withSubagentChildEnv(undefined, () => {
        registerDreaming(fake.pi, () => {
          spawned++;
          return { started: true, id: "dream-job-reload" };
        });
      });
      await fake.shutdown({ reason: "reload" });
      await fake.fireLifecycle("session_start", { reason: "reload" }, { cwd: dir, mode: "interactive" });
      fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: "dream-req-reload" });

      const evt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:memory-dream-result");
      assert.ok(evt, "pidash:memory-dream-result emitted");
      assert.equal(spawned, 1);
      assert.equal(evt!.data.requestId, "dream-req-reload");
      assert.equal(evt!.data.ok, true);
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps dreamInFlight across session_start and ignores stale onComplete callbacks", async () => {
    const dir = makeTempDir("dream-bridge-inflight-");
    const fake = createFakePi();
    let spawned = 0;
    const onCompletes: Array<() => void> = [];
    try {
      withSubagentChildEnv(undefined, () => {
        registerDreaming(fake.pi, (_agent, _task, _cwd, _agents, opts) => {
          spawned++;
          if (opts?.onComplete) onCompletes.push(opts.onComplete);
          return { started: true, id: `dream-job-${spawned}` };
        });
      });

      fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: "req-1" });
      assert.equal(spawned, 1);

      // Switching sessions while a dream worker is still running must not start a competing dream.
      await fake.fireLifecycle("session_start", { reason: "new" }, { cwd: dir, mode: "interactive" });
      fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: "req-2" });
      const secondEvt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:memory-dream-result");
      assert.equal(spawned, 1, "does not spawn a competing dream across session_start");
      assert.equal(secondEvt?.data.ok, false);
      assert.equal(secondEvt?.data.inFlight, true);
      assert.equal(secondEvt?.data.id, "dream-job-1");

      // Completing worker 1 allows worker 2 to start; re-firing worker 1's onComplete must not clear worker 2's guard.
      onCompletes[0]?.();
      fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: "req-3" });
      assert.equal(spawned, 2);
      onCompletes[0]?.();
      fake.fireEvent("pidash:memory-dream-request", { cwd: dir, requestId: "req-4" });
      const fourthEvt = [...fake.emitted].reverse().find((e) => e.channel === "pidash:memory-dream-result");
      assert.equal(spawned, 2, "stale onComplete from dream-job-1 does not clear dream-job-2 guard");
      assert.equal(fourthEvt?.data.inFlight, true);
      assert.equal(fourthEvt?.data.id, "dream-job-2");
    } finally {
      await fake.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
