/**
 * Unit tests for `coms_local_queue` LLM tool (#1384).
 *
 * Run with: npx tsx --test tests/node/coms/coms-local-queue.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { createComsPeerRuntime, type ComsPeerRuntime } from "../../../extensions/coms/coms-p2p.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

interface TestPeer {
  tools: Map<string, any>;
  handlers: Map<string, Function>;
  messages: any[];
  runtime: ComsPeerRuntime;
  shutdown: () => Promise<void>;
  endpoint: string;
}

const startedPeers: TestPeer[] = [];
const activeServers: net.Server[] = [];
const activeSockets: net.Socket[] = [];

afterEach(async () => {
  for (const sock of activeSockets.splice(0)) {
    try { sock.destroy(); } catch { /* ignore */ }
  }
  for (const srv of activeServers.splice(0)) {
    try { srv.close(); } catch { /* ignore */ }
  }
  for (const peer of startedPeers.splice(0)) {
    try { await peer.shutdown(); } catch { /* ignore */ }
  }
});

async function waitUntil(pred: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`waitUntil timed out after ${timeoutMs}ms`);
}

function textOf(result: any): string {
  return (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

function makeWorkspace() {
  const workspace = makeTempDir("coms-local-queue-");
  const comsDir = join(workspace, "coms");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
  return { workspace, comsDir };
}

async function bootPeer(opts: { name: string; sessionId: string; project: string; cwd: string; comsDir: string }): Promise<TestPeer> {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const messages: any[] = [];
  const flags = new Map<string, any>([
    ["cname", opts.name],
    ["project", opts.project],
  ]);
  let runtime!: ComsPeerRuntime;

  const fakePi: any = {
    registerFlag: () => {},
    getFlag: (name: string) => flags.get(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
    sendMessage: (msg: any) => messages.push(msg),
    events: { on: () => () => {}, emit: () => {} },
  };

  withSubagentChildEnv(undefined, () => {
    runtime = createComsPeerRuntime(fakePi, {
      deferred: false,
      comsDir: opts.comsDir,
      sessionId: opts.sessionId,
      registerSignalHandlers: false,
    });
  });

  const ctx = {
    cwd: opts.cwd,
    model: { id: "test-model" },
    hasUI: false,
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => opts.sessionId,
      getBranch: () => [],
    },
  };

  const peer: TestPeer = {
    tools,
    handlers,
    messages,
    get runtime() { return runtime; },
    shutdown: async () => { await handlers.get("session_shutdown")?.(); },
    endpoint: "",
  };
  startedPeers.push(peer);

  await handlers.get("session_start")!({}, ctx);
  const self = runtime.getSelf();
  assert.ok(self?.registryFile, "peer wrote registry file");
  const reg = JSON.parse(readFileSync(self.registryFile, "utf-8"));
  peer.endpoint = reg.endpoint;
  return peer;
}

async function createSenderServer(endpoint: string, senderSession: string, senderName: string, cwd: string) {
  const received: any[] = [];
  const srv = net.createServer((sock) => {
    activeSockets.push(sock);
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
  activeServers.push(srv);
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(endpoint, () => resolve());
  });

  const sendPrompt = (receiverEndpoint: string, msgId: string, prompt: string) =>
    new Promise<any>((resolve, reject) => {
      const sock = net.createConnection({ path: receiverEndpoint });
      activeSockets.push(sock);
      let buf = "";
      sock.on("connect", () => {
        sock.write(JSON.stringify({
          type: "prompt",
          msg_id: msgId,
          sender_session: senderSession,
          sender_name: senderName,
          sender_endpoint: endpoint,
          sender_cwd: cwd,
          prompt,
          hops: 0,
          timestamp: new Date().toISOString(),
        }) + "\n");
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

  return { received, sendPrompt };
}

describe("coms_local_queue tool (#1384)", () => {
  it("returns inactive message when coms has not been started", async () => {
    const tools = new Map<string, any>();
    const fakePi: any = {
      registerFlag: () => {},
      getFlag: () => undefined,
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: () => {},
      sendMessage: () => {},
      events: { on: () => () => {}, emit: () => {} },
    };

    withSubagentChildEnv(undefined, () => {
      createComsPeerRuntime(fakePi, {
        deferred: true,
        allowSubagentChild: true,
        registerSignalHandlers: false,
      });
    });

    const tool = tools.get("coms_local_queue");
    assert.ok(tool, "coms_local_queue tool registered");
    assert.equal(tool.defaultActive, false);
    const res = await tool.execute("call-1", { action: "list" });
    assert.match(textOf(res), /coms not active/i);
  });

  it("reports an empty local inbound queue when idle", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-idle",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });

    const res = await peer.tools.get("coms_local_queue").execute("call-1", { action: "list" });
    assert.deepEqual(res.details.items, []);
    assert.match(textOf(res), /No queued inbound coms messages/i);
  });

  it("lists processing with pending inbound messages", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-list",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });
    const sender = await createSenderServer(join(comsDir, "sender-list.sock"), "sess-sender", "coordinator", workspace);

    await sender.sendPrompt(peer.endpoint, "msg-first", "Handle task one");
    await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === "msg-first"));
    await sender.sendPrompt(peer.endpoint, "msg-second", "Handle task two");

    const res = await peer.tools.get("coms_local_queue").execute("call-1", { action: "list" });
    const out = textOf(res);
    assert.equal(res.details.items.length, 2);
    assert.match(out, /msg-first \| processing \| from: coordinator \| Handle task one/);
    assert.match(out, /msg-second \| pending \| from: coordinator \| Handle task two/);
  });

  it("kills a pending inbound message notifying the sender", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-kill",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });
    const sender = await createSenderServer(join(comsDir, "sender-kill.sock"), "sess-sender", "coordinator", workspace);

    await sender.sendPrompt(peer.endpoint, "msg-active", "Active prompt");
    await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === "msg-active"));
    await sender.sendPrompt(peer.endpoint, "msg-queued", "Queued prompt to kill");

    const killRes = await peer.tools.get("coms_local_queue").execute("call-1", { action: "kill", msg_id: "msg-queued" });
    assert.equal(killRes.details.killed, true);
    assert.match(textOf(killRes), /Killed inbound message msg-queued/);

    await waitUntil(() => sender.received.some((e) => e.type === "response" && e.msg_id === "msg-queued"));
    const responseEnv = sender.received.find((e) => e.type === "response" && e.msg_id === "msg-queued");
    assert.equal(responseEnv.error, "killed_by_user");

    const listAfter = await peer.tools.get("coms_local_queue").execute("call-2", { action: "list" });
    assert.equal(listAfter.details.items.length, 1);
    assert.equal(listAfter.details.items[0].msg_id, "msg-active");
  });

  it("returns an error when kill is called without msg_id", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-noid",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });

    const res = await peer.tools.get("coms_local_queue").execute("call-1", { action: "kill" });
    assert.equal(res.details.killed, false);
    assert.match(textOf(res), /'msg_id' is required/i);
  });

  it("reports not found when killing an unknown msg_id", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-unknown",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });

    const res = await peer.tools.get("coms_local_queue").execute("call-1", { action: "kill", msg_id: "missing-msg" });
    assert.equal(res.details.killed, false);
    assert.match(textOf(res), /No queued inbound message found/i);
  });

  it("drains the next queued inbound on agent_end after killing the active message mid-turn", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-kill-active-midturn",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });
    const sender = await createSenderServer(join(comsDir, "sender-active.sock"), "sess-sender", "coordinator", workspace);

    await sender.sendPrompt(peer.endpoint, "msg-active", "Active prompt");
    await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === "msg-active"));
    await peer.handlers.get("agent_start")?.({}, {});
    await sender.sendPrompt(peer.endpoint, "msg-next", "Queued next prompt");

    const killRes = await peer.tools.get("coms_local_queue").execute("call-1", { action: "kill", msg_id: "msg-active" });
    assert.equal(killRes.details.killed, true);
    await waitUntil(() => sender.received.some((e) => e.type === "response" && e.msg_id === "msg-active"));

    // Mid-turn: next message must not be injected while the cancelled turn is still running
    assert.equal(peer.messages.some((m) => m?.details?.msg_id === "msg-next"), false);

    // Once agent_end fires, the pending message drains cleanly
    await peer.handlers.get("agent_end")?.({ messages: [] }, {
      cwd: workspace,
      hasUI: false,
      ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
      sessionManager: { getSessionId: () => "sess-kill-active-midturn", getBranch: () => [] },
    });
    await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === "msg-next"));
  });

  it("drains the next queued inbound immediately when killing the active message while idle", async () => {
    const { workspace, comsDir } = makeWorkspace();
    const peer = await bootPeer({
      name: "receiver",
      sessionId: "sess-kill-active-idle",
      project: "test-proj",
      cwd: workspace,
      comsDir,
    });
    const sender = await createSenderServer(join(comsDir, "sender-idle.sock"), "sess-sender", "coordinator", workspace);

    await sender.sendPrompt(peer.endpoint, "msg-active-idle", "Active prompt");
    await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === "msg-active-idle"));
    await sender.sendPrompt(peer.endpoint, "msg-next-idle", "Queued next prompt");

    const killRes = await peer.tools.get("coms_local_queue").execute("call-1", { action: "kill", msg_id: "msg-active-idle" });
    assert.equal(killRes.details.killed, true);
    await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === "msg-next-idle"));
  });
});
