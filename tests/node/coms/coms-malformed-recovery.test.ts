/**
 * Integration tests coordinating malformed-response recovery with COMS agent_end (#1333).
 *
 * Run with: npx tsx --test tests/node/coms/coms-malformed-recovery.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import comsP2p from "../../../extensions/coms/coms-p2p.js";
import { registerMalformedResponseRecovery } from "../../../extensions/orchestrator/malformed-response-recovery.js";
import { resetMalformedRecoveryBridgeForTests } from "../../../extensions/shared/malformed-recovery-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

type Handler = (...args: any[]) => any;

interface PeerHarness {
  tools: Map<string, any>;
  handlers: Map<string, Handler[]>;
  messages: any[];
  ctx: any;
  sessionId: string;
  emit: (event: string, payload?: any, ctx?: any) => Promise<void>;
  shutdown: () => Promise<void>;
}

const cleanupDirs: string[] = [];
const startedPeers: PeerHarness[] = [];

afterEach(async () => {
  for (const peer of startedPeers.splice(0)) {
    try { await peer.shutdown(); } catch { /* ignore */ }
  }
  resetMalformedRecoveryBridgeForTests();
  for (const dir of cleanupDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`waitUntil timed out after ${timeoutMs}ms`);
}

function makeWorkspace() {
  const workspace = makeTempDir("coms-malformed-recovery-");
  cleanupDirs.push(workspace);
  const comsDir = join(workspace, "coms");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: comsDir }));
  return { workspace, comsDir };
}

function makeCtx(cwd: string, sessionId: string, branchReply = "") {
  return {
    cwd,
    model: { id: "test-model" },
    hasUI: false,
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () =>
        branchReply
          ? [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: branchReply }] } }]
          : [],
    },
  };
}

function malformedAssistant(reason = "MALFORMED_RESPONSE") {
  return {
    role: "assistant",
    stopReason: "error",
    rawStopReason: reason,
    errorMessage: `Unhandled stop reason: ${reason}`,
  };
}

async function startPeer(opts: {
  name: string;
  sessionId: string;
  project: string;
  cwd: string;
  registerRecoveryOrder?: "orchestrator-first" | "coms-first";
  maxRetries?: number;
  sendMessageImpl?: (msg: any, sendOpts?: any) => Promise<void> | void;
}): Promise<PeerHarness> {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const messages: any[] = [];
  const flags = new Map<string, any>([
    ["cname", opts.name],
    ["project", opts.project],
  ]);

  const fakePi: any = {
    registerFlag: () => {},
    getFlag: (name: string) => flags.get(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: async (msg: any, sendOpts?: any) => {
      messages.push(msg);
      if (opts.sendMessageImpl) {
        await opts.sendMessageImpl(msg, sendOpts);
      }
    },
    events: { on: () => () => {}, emit: () => {} },
  };

  withSubagentChildEnv(undefined, () => {
    if (opts.registerRecoveryOrder === "orchestrator-first") {
      registerMalformedResponseRecovery(
        fakePi,
        opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : undefined,
      );
      comsP2p(fakePi);
    } else if (opts.registerRecoveryOrder === "coms-first") {
      comsP2p(fakePi);
      registerMalformedResponseRecovery(
        fakePi,
        opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : undefined,
      );
    } else {
      comsP2p(fakePi);
    }
  });

  const emit = async (event: string, payload?: any, ctx?: any) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx ?? peer.ctx);
    }
  };

  (globalThis as any).__piConfigSessionId = opts.sessionId;
  const ctx = makeCtx(opts.cwd, opts.sessionId);
  const peer: PeerHarness = {
    tools,
    handlers,
    messages,
    ctx,
    sessionId: opts.sessionId,
    emit,
    shutdown: async () => {
      await emit("session_shutdown", {}, ctx);
    },
  };

  startedPeers.push(peer);
  await emit("session_start", {}, ctx);
  return peer;
}

async function deliverInbound(peer: PeerHarness, msgId: string): Promise<any> {
  await waitUntil(() => peer.messages.some((m) => m?.details?.msg_id === msgId));
  const msg = [...peer.messages].reverse().find((m) => m?.details?.msg_id === msgId);
  assert.ok(msg, `expected injected inbound ${msgId}`);
  await peer.emit("message_start", { message: { role: "custom", ...msg } });
  return msg;
}

describe("COMS malformed-response recovery coordination (#1333)", { concurrency: false }, () => {
  it("defers COMS finalization until recovered reply when orchestrator runs first", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({ name: "sender", sessionId: "s-ord1", project: "p-1333-1", cwd: workspace });
    const receiver = await startPeer({
      name: "receiver",
      sessionId: "r-ord1",
      project: "p-1333-1",
      cwd: workspace,
      registerRecoveryOrder: "orchestrator-first",
      maxRetries: 2,
    });

    const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "status?" });
    const msgId = sent.details.msg_id as string;

    await receiver.emit("agent_start", {});
    await deliverInbound(receiver, msgId);

    const errMsg = malformedAssistant("MALFORMED_RESPONSE");
    await receiver.emit("turn_end", { type: "turn_end", turnIndex: 0, message: errMsg, toolResults: [] });
    await receiver.emit("agent_end", { messages: [errMsg] });

    assert.equal(
      receiver.messages.filter((m) => m?.customType === "malformed-response-recovery").length,
      1,
      "recovery follow-up note must be sent",
    );
    const midStatus = await sender.tools.get("coms_get").execute("g-mid", { msg_id: msgId });
    assert.equal(midStatus.details.status, "pending", "inbound must stay pending while recovery runs");

    const okMsg = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered answer" }],
    };
    await receiver.emit("agent_start", {});
    await receiver.emit("turn_end", { type: "turn_end", turnIndex: 0, message: okMsg, toolResults: [] });
    await receiver.emit("agent_end", { messages: [okMsg] });

    await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
    const done = await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId });
    assert.equal(done.details.response, "recovered answer");
    assert.equal(done.details.error, null);
  });

  it("defers COMS finalization until recovered reply when COMS runs first", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({ name: "sender", sessionId: "s-ord2", project: "p-1333-2", cwd: workspace });
    const receiver = await startPeer({
      name: "receiver",
      sessionId: "r-ord2",
      project: "p-1333-2",
      cwd: workspace,
      registerRecoveryOrder: "coms-first",
      maxRetries: 2,
    });

    const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "status?" });
    const msgId = sent.details.msg_id as string;

    await receiver.emit("agent_start", {});
    await deliverInbound(receiver, msgId);

    const errMsg = malformedAssistant("MALFORMED_RESPONSE");
    await receiver.emit("turn_end", { type: "turn_end", turnIndex: 0, message: errMsg, toolResults: [] });
    await receiver.emit("agent_end", { messages: [errMsg] });

    assert.equal(
      receiver.messages.filter((m) => m?.customType === "malformed-response-recovery").length,
      1,
    );
    const midStatus = await sender.tools.get("coms_get").execute("g-mid", { msg_id: msgId });
    assert.equal(midStatus.details.status, "pending", "inbound must stay pending while recovery runs");

    const okMsg = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered answer coms-first" }],
    };
    await receiver.emit("agent_start", {});
    await receiver.emit("turn_end", { type: "turn_end", turnIndex: 0, message: okMsg, toolResults: [] });
    await receiver.emit("agent_end", { messages: [okMsg] });

    await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
    const done = await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId });
    assert.equal(done.details.response, "recovered answer coms-first");
    assert.equal(done.details.error, null);
  });

  it("finalizes deferred COMS inbound cleanly when recovery sendSystemNote rejects", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({ name: "sender", sessionId: "s-abort", project: "p-1333-3", cwd: workspace });
    const receiver = await startPeer({
      name: "receiver",
      sessionId: "r-abort",
      project: "p-1333-3",
      cwd: workspace,
      registerRecoveryOrder: "coms-first",
      maxRetries: 2,
      sendMessageImpl: async (msg) => {
        if (msg?.customType === "malformed-response-recovery") {
          throw new Error("transport closed");
        }
      },
    });

    const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "status?" });
    const msgId = sent.details.msg_id as string;

    await receiver.emit("agent_start", {});
    await deliverInbound(receiver, msgId);

    const errMsg = malformedAssistant("MALFORMED_RESPONSE");
    await receiver.emit("agent_end", { messages: [errMsg] });

    await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
    const done = await sender.tools.get("coms_get").execute("g-done", { msg_id: msgId });
    assert.equal(done.details.status, "complete");
  });

  it("finalizes COMS inbound immediately when malformed retry limit is exhausted", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({ name: "sender", sessionId: "s-exh", project: "p-1333-4", cwd: workspace });
    const receiver = await startPeer({
      name: "receiver",
      sessionId: "r-exh",
      project: "p-1333-4",
      cwd: workspace,
      registerRecoveryOrder: "coms-first",
      maxRetries: 1,
    });

    const sent = await sender.tools.get("coms_send").execute("s1", { target: "receiver", prompt: "status?" });
    const msgId = sent.details.msg_id as string;

    await receiver.emit("agent_start", {});
    await deliverInbound(receiver, msgId);

    // 1st malformed turn -> deferred, 1/1 retry scheduled.
    await receiver.emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] });
    const midStatus = await sender.tools.get("coms_get").execute("g-mid", { msg_id: msgId });
    assert.equal(midStatus.details.status, "pending");

    // 2nd malformed turn -> retry limit exhausted, COMS finalizes immediately.
    await receiver.emit("agent_start", {});
    await receiver.emit("agent_end", { messages: [malformedAssistant("MALFORMED_RESPONSE")] });

    await waitUntil(async () => (await sender.tools.get("coms_get").execute("g-wait", { msg_id: msgId })).details.status === "complete");
    assert.equal(
      receiver.messages.filter((m) => m?.customType === "malformed-response-recovery").length,
      1,
      "must not send a recovery note once retries are exhausted",
    );
  });

  it("isolates COMS malformed recovery deferral across concurrent peer sessions", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({ name: "sender", sessionId: "s-conc", project: "p-1333-5", cwd: workspace });
    const receiverA = await startPeer({
      name: "receiver-a",
      sessionId: "r-conc-a",
      project: "p-1333-5",
      cwd: workspace,
      registerRecoveryOrder: "coms-first",
      maxRetries: 1,
    });
    const receiverB = await startPeer({
      name: "receiver-b",
      sessionId: "r-conc-b",
      project: "p-1333-5",
      cwd: workspace,
      registerRecoveryOrder: "coms-first",
      maxRetries: 1,
    });

    const sentB = await sender.tools.get("coms_send").execute("sb", { target: "receiver-b", prompt: "status b?" });
    const msgIdB = sentB.details.msg_id as string;

    await receiverB.emit("agent_start", {});
    await deliverInbound(receiverB, msgIdB);

    // Receiver A shuts down while Receiver B hits a malformed response.
    await receiverA.shutdown();

    const errMsgB = malformedAssistant("MALFORMED_RESPONSE");
    await receiverB.emit("turn_end", { type: "turn_end", turnIndex: 0, message: errMsgB, toolResults: [] });
    await receiverB.emit("agent_end", { messages: [errMsgB] });

    const midStatusB = await sender.tools.get("coms_get").execute("gb-mid", { msg_id: msgIdB });
    assert.equal(midStatusB.details.status, "pending", "Receiver B must remain deferred after Receiver A shuts down");

    const okMsgB = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered answer b" }],
    };
    await receiverB.emit("agent_start", {});
    await receiverB.emit("turn_end", { type: "turn_end", turnIndex: 0, message: okMsgB, toolResults: [] });
    await receiverB.emit("agent_end", { messages: [okMsgB] });

    await waitUntil(async () => (await sender.tools.get("coms_get").execute("gb-wait", { msg_id: msgIdB })).details.status === "complete");
    const doneB = await sender.tools.get("coms_get").execute("gb-done", { msg_id: msgIdB });
    assert.equal(doneB.details.response, "recovered answer b");
    assert.equal(doneB.details.error, null);
  });
});
