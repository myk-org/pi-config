/**
 * Integration tests coordinating stream-loop-guard aborts with COMS replies (issue #1374).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import comsP2p from "../../../extensions/coms/coms-p2p.js";
import {
  CONSECUTIVE_LINE_THRESHOLD,
  registerStreamLoopGuard,
} from "../../../extensions/orchestrator/stream-loop-guard.js";
import {
  consumeStreamLoopAborted,
  markStreamLoopAborted,
  resetStreamLoopAbortBridgeForTests,
} from "../../../extensions/shared/stream-loop-abort-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

type Handler = (...args: any[]) => any;

interface PeerHarness {
  tools: Map<string, any>;
  handlers: Map<string, Handler[]>;
  messages: any[];
  ctx: any;
  getAbortCalls: () => number;
  emit: (event: string, payload?: any, ctx?: any) => Promise<void>;
  shutdown: () => Promise<void>;
}

const cleanupDirs: string[] = [];
const startedPeers: PeerHarness[] = [];

afterEach(async () => {
  for (const peer of startedPeers.splice(0)) {
    try {
      await peer.shutdown();
    } catch {
      /* ignore */
    }
  }
  resetStreamLoopAbortBridgeForTests();
  (globalThis as any).__comsSelf = null;
  (globalThis as any).__comsUserSend = null;
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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
  const workspace = makeTempDir("coms-stream-loop-abort-");
  cleanupDirs.push(workspace);
  const comsDir = join(workspace, "coms");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(
    join(workspace, ".pi", "pi-config-settings.json"),
    JSON.stringify({ coms_dir: comsDir }),
  );
  return { workspace, comsDir };
}

function makeCtx(cwd: string, sessionId: string, branchReply: string, onAbort?: () => void) {
  return {
    mode: "interactive",
    cwd,
    model: { id: "test-model" },
    hasUI: false,
    abort: () => onAbort?.(),
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () =>
        branchReply
          ? [
              {
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: branchReply }] },
              },
            ]
          : [],
    },
  };
}

async function startPeer(opts: {
  name: string;
  sessionId: string;
  project: string;
  cwd: string;
  branchReply?: string;
}): Promise<PeerHarness> {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const messages: any[] = [];
  const flags = new Map<string, any>([
    ["cname", opts.name],
    ["project", opts.project],
  ]);
  let abortCalls = 0;

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
    sendMessage: async (msg: any) => {
      messages.push(msg);
    },
    events: { on: () => () => {}, emit: () => {} },
  };

  withSubagentChildEnv(undefined, () => {
    comsP2p(fakePi);
    registerStreamLoopGuard(fakePi);
  });

  (globalThis as any).__piConfigSessionId = opts.sessionId;
  const ctx = makeCtx(opts.cwd, opts.sessionId, opts.branchReply ?? "", () => {
    abortCalls += 1;
  });

  async function emit(event: string, payload: any = {}, eventCtx: any = ctx): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, eventCtx);
    }
  }

  await emit("session_start", {}, ctx);
  const harness: PeerHarness = {
    tools,
    handlers,
    messages,
    ctx,
    getAbortCalls: () => abortCalls,
    emit,
    shutdown: () => emit("session_shutdown", {}, ctx),
  };
  startedPeers.push(harness);
  return harness;
}

describe("stream-loop-guard + COMS abort coordination (#1374)", { concurrency: false }, () => {
  it("isolates stream-loop abort marks across concurrent sessions", () => {
    markStreamLoopAborted("session-a");
    assert.equal(consumeStreamLoopAborted("session-b"), false);
    assert.equal(consumeStreamLoopAborted("session-a"), true);
    assert.equal(consumeStreamLoopAborted("session-a"), false);
  });

  it("sends error response instead of aborted or earlier branch text to peer", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({
      name: "sender",
      sessionId: "sla-sender",
      project: "proj-1374",
      cwd: workspace,
    });
    const receiver = await startPeer({
      name: "receiver",
      sessionId: "sla-receiver",
      project: "proj-1374",
      cwd: workspace,
      branchReply: "stale earlier assistant message",
    });

    const sent = await sender.tools
      .get("coms_send")
      .execute("s1", { target: "receiver", prompt: "do work" });
    const msgId = sent.details.msg_id as string;
    await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === msgId));
    const inboundMsg = receiver.messages.find((m) => m?.details?.msg_id === msgId);

    await receiver.emit("agent_start", {});
    await receiver.emit("message_start", { message: { role: "custom", ...inboundMsg } });
    await receiver.emit("turn_start", {});
    await receiver.emit("message_start", { message: { role: "assistant", content: [] } });
    await receiver.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD),
      },
    });
    assert.equal(receiver.getAbortCalls(), 1);

    // Even if turn_end reports stopReason "aborted" or races with "stop", peer must not receive branch text.
    await receiver.emit("turn_end", {
      message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: ".\n.\n" }] },
      toolResults: [],
    });
    await receiver.emit("agent_end", { messages: [] });

    await waitUntil(async () => {
      const res = await sender.tools.get("coms_get").execute("g1", { msg_id: msgId });
      return res.details.status !== "pending";
    });
    const reply = await sender.tools.get("coms_get").execute("g2", { msg_id: msgId });
    assert.equal(reply.details.status, "complete");
    assert.equal(reply.details.error, "stream_repetition_loop_aborted");
    assert.equal(reply.details.response, null);
  });

  it("defers turn_end with stopReason stop after stream-loop abort so peer receives error", async () => {
    const { workspace } = makeWorkspace();
    const sender = await startPeer({
      name: "sender2",
      sessionId: "sla-sender-2",
      project: "proj-1374-b",
      cwd: workspace,
    });
    const receiver = await startPeer({
      name: "receiver2",
      sessionId: "sla-receiver-2",
      project: "proj-1374-b",
      cwd: workspace,
      branchReply: "looping dots output",
    });

    const sent = await sender.tools
      .get("coms_send")
      .execute("s1", { target: "receiver2", prompt: "do work" });
    const msgId = sent.details.msg_id as string;
    await waitUntil(() => receiver.messages.some((m) => m?.details?.msg_id === msgId));
    const inboundMsg = receiver.messages.find((m) => m?.details?.msg_id === msgId);

    await receiver.emit("agent_start", {});
    await receiver.emit("message_start", { message: { role: "custom", ...inboundMsg } });
    await receiver.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD),
      },
    });
    await receiver.emit("turn_end", {
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "looping dots" }] },
      toolResults: [],
    });
    await receiver.emit("agent_end", { messages: [] });

    await waitUntil(async () => {
      const res = await sender.tools.get("coms_get").execute("g1", { msg_id: msgId });
      return res.details.status !== "pending";
    });
    const reply = await sender.tools.get("coms_get").execute("g2", { msg_id: msgId });
    assert.equal(reply.details.status, "complete");
    assert.equal(reply.details.error, "stream_repetition_loop_aborted");
    assert.equal(reply.details.response, null);
  });
});
