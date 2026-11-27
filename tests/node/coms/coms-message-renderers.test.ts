/**
 * Unit tests for compact 1-line COMS TUI message renderers & legacy customType compatibility (#1454).
 * Run with: npx tsx --test tests/node/coms/coms-message-renderers.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  CompactCustomMessage,
  CompactMessageRenderOptions,
} from "../../../extensions/shared/compact-message-renderer.js";
import {
  createComsPeerRuntime,
  registerComsMessageRenderers,
  renderComsInboundMessage,
  renderComsPeerJoinedMessage,
  renderComsPeerLeftMessage,
  renderComsResponseMessage,
  type ComsPeerRuntime,
} from "../../../extensions/coms/coms-p2p.js";
import {
  COMS_INBOUND_CUSTOM_TYPE,
  COMS_PEER_JOINED_CUSTOM_TYPE,
  COMS_PEER_LEFT_CUSTOM_TYPE,
  COMS_RESPONSE_CUSTOM_TYPE,
  detectMixedTurn,
  isComsInboundCustomType,
  isComsResponseCustomType,
  type BranchEntry,
  type ComsInboundDetails,
  type ComsPeerEventDetails,
  type ComsResponseDetails,
} from "../../../extensions/coms/coms-shared.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function createFakeTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function makeOptions(overrides: Partial<CompactMessageRenderOptions> = {}): CompactMessageRenderOptions {
  return {
    expanded: false,
    outputPad: 1,
    keyText: () => "ctrl+o",
    keyHint: (_action: any, desc: string) => `ctrl+o ${desc}`,
    ...overrides,
  };
}

describe("COMS customType backwards-compatible detection (#1454)", () => {
  it("matches fixed coms-inbound customType", () => {
    assert.equal(isComsInboundCustomType(COMS_INBOUND_CUSTOM_TYPE), true);
  });

  it("matches legacy dynamic from-peer inbound customType", () => {
    assert.equal(isComsInboundCustomType("from manager → worker @ /repo"), true);
    assert.equal(isComsInboundCustomType("from manager → worker @ /repo (from the USER)"), true);
  });

  it("matches legacy dynamic steer inbound customType", () => {
    assert.equal(isComsInboundCustomType("steer from manager → worker @ /repo"), true);
  });

  it("rejects unrelated customTypes for inbound detection", () => {
    assert.equal(isComsInboundCustomType("coms-response"), false);
    assert.equal(isComsInboundCustomType("async-agent-result"), false);
    assert.equal(isComsInboundCustomType(undefined), false);
  });

  it("matches fixed coms-response customType", () => {
    assert.equal(isComsResponseCustomType(COMS_RESPONSE_CUSTOM_TYPE), true);
  });

  it("matches legacy dynamic coms-response customType", () => {
    assert.equal(isComsResponseCustomType("coms response from peer-a → self (1 more queued: m1)"), true);
  });

  it("rejects unrelated customTypes for response detection", () => {
    assert.equal(isComsResponseCustomType("coms-inbound"), false);
    assert.equal(isComsResponseCustomType("from peer → self @ /repo"), false);
    assert.equal(isComsResponseCustomType(null), false);
  });

  it("detectMixedTurn recognizes legacy dynamic inbound entries under coms-inbound", () => {
    const branch: BranchEntry[] = [
      { type: "message", message: { role: "user" } },
      { type: "custom_message", customType: "from alpha → beta @ /repo", details: { msg_id: "m-legacy" } },
      { type: "message", message: { role: "assistant" } },
    ];
    assert.equal(detectMixedTurn(branch, "m-legacy", COMS_INBOUND_CUSTOM_TYPE), false);
  });

  it("detectMixedTurn still flags user messages after legacy dynamic inbound entries", () => {
    const branch: BranchEntry[] = [
      { type: "custom_message", customType: "from alpha → beta @ /repo", details: { msg_id: "m-legacy" } },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ];
    assert.equal(detectMixedTurn(branch, "m-legacy", COMS_INBOUND_CUSTOM_TYPE), true);
  });
});

describe("COMS compact message renderers (#1454)", () => {
  const theme = createFakeTheme();

  it("registers all four COMS message renderers", () => {
    const registered = new Map<string, unknown>();
    const fakePi = {
      registerMessageRenderer: (customType: string, renderer: unknown) => {
        registered.set(customType, renderer);
      },
    };
    registerComsMessageRenderers(fakePi as any);

    assert.equal(registered.get(COMS_PEER_JOINED_CUSTOM_TYPE), renderComsPeerJoinedMessage);
    assert.equal(registered.get(COMS_PEER_LEFT_CUSTOM_TYPE), renderComsPeerLeftMessage);
    assert.equal(registered.get(COMS_RESPONSE_CUSTOM_TYPE), renderComsResponseMessage);
    assert.equal(registered.get(COMS_INBOUND_CUSTOM_TYPE), renderComsInboundMessage);
  });

  it("renders coms-peer-joined as one compact line when collapsed", () => {
    const msg: CompactCustomMessage<ComsPeerEventDetails> = {
      role: "custom",
      customType: COMS_PEER_JOINED_CUSTOM_TYPE,
      content: "📡 Peer joined: peer-1449-snapshots (gemini-4-neon) — Implement snapshots [2026-11-27T14:00:00.000Z]",
      display: true,
      details: { peer: "peer-1449-snapshots", model: "gemini-4-neon", purpose: "Implement snapshots" },
      timestamp: Date.now(),
    };

    const lines = renderComsPeerJoinedMessage(msg, makeOptions({ expanded: false }), theme).render(100);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /📡 \+ peer-1449-snapshots joined/);
  });

  it("renders coms-peer-joined full content when expanded", () => {
    const fullContent = "📡 Peer joined: peer-1449-snapshots (gemini-4-neon) — Implement snapshots [2026-11-27T14:00:00.000Z]";
    const msg: CompactCustomMessage<ComsPeerEventDetails> = {
      role: "custom",
      customType: COMS_PEER_JOINED_CUSTOM_TYPE,
      content: fullContent,
      display: true,
      details: { peer: "peer-1449-snapshots" },
      timestamp: Date.now(),
    };

    const rendered = renderComsPeerJoinedMessage(msg, makeOptions({ expanded: true }), theme).render(120).join("\n");
    assert.match(rendered, /\[coms-peer-joined\]/);
    assert.match(rendered, /Implement snapshots/);
  });

  it("renders coms-peer-left as one compact line when collapsed", () => {
    const msg: CompactCustomMessage<ComsPeerEventDetails> = {
      role: "custom",
      customType: COMS_PEER_LEFT_CUSTOM_TYPE,
      content: "📡 Peer left: peer-1449-snapshots [2026-11-27T14:05:00.000Z]",
      display: true,
      details: { peer: "peer-1449-snapshots" },
      timestamp: Date.now(),
    };

    const lines = renderComsPeerLeftMessage(msg, makeOptions({ expanded: false }), theme).render(100);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /📡 - peer-1449-snapshots left/);
  });

  it("renders coms-response as one compact line when collapsed", () => {
    const msg: CompactCustomMessage<ComsResponseDetails> = {
      role: "custom",
      customType: COMS_RESPONSE_CUSTOM_TYPE,
      content: "PR #1452 ready\nAll checks passed.\nReady for merge.",
      display: true,
      details: {
        msg_id: "m1",
        header: "coms response from peer-1449-snapshots → main",
        sender: "peer-1449-snapshots",
        target: "main",
        error: null,
        queued_msg_ids: [],
        queuedMsgIds: [],
        summaryLine: "PR #1452 ready",
      },
      timestamp: Date.now(),
    };

    const lines = renderComsResponseMessage(msg, makeOptions({ expanded: false }), theme).render(120);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /📡 ← peer-1449-snapshots: PR #1452 ready/);
    assert.match(lines[0], /\(ctrl\+o to expand\)/);
  });

  it("renders coms-response header plus full body when expanded", () => {
    const msg: CompactCustomMessage<ComsResponseDetails> = {
      role: "custom",
      customType: COMS_RESPONSE_CUSTOM_TYPE,
      content: "PR #1452 ready\nLine two body\nLine three body",
      display: true,
      details: {
        msg_id: "m1",
        header: "coms response from peer-1449-snapshots → main (1 more queued: m2)",
        sender: "peer-1449-snapshots",
        target: "main",
        error: null,
        queued_msg_ids: ["m2"],
        queuedMsgIds: ["m2"],
        summaryLine: "PR #1452 ready",
      },
      timestamp: Date.now(),
    };

    const rendered = renderComsResponseMessage(msg, makeOptions({ expanded: true }), theme).render(120).join("\n");
    assert.match(rendered, /\[coms response from peer-1449-snapshots → main \(1 more queued: m2\)\]/);
    assert.match(rendered, /Line two body/);
    assert.match(rendered, /Line three body/);
  });

  it("renders coms-inbound as one compact line when collapsed", () => {
    const content = '[from feature-manager @ /repo] Check TaskList and start.\n\nReply to me via coms_send(target="feature-manager")';
    const msg: CompactCustomMessage<ComsInboundDetails> = {
      role: "custom",
      customType: COMS_INBOUND_CUSTOM_TYPE,
      content,
      display: true,
      details: {
        msg_id: "m2",
        header: "from feature-manager → worker @ /repo",
        sender: "feature-manager",
        target: "worker",
        summaryLine: "Check TaskList and start.",
      },
      timestamp: Date.now(),
    };

    const lines = renderComsInboundMessage(msg, makeOptions({ expanded: false }), theme).render(120);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /📡 ← feature-manager: Check TaskList and start\./);
    assert.match(lines[0], /\(ctrl\+o to expand\)/);
    assert.equal(msg.content, content);
  });

  it("sanitizes ANSI escapes in untrusted peer inbound summaries", () => {
    const msg: CompactCustomMessage<ComsInboundDetails> = {
      role: "custom",
      customType: COMS_INBOUND_CUSTOM_TYPE,
      content: "[from rogue @ /repo] \x1b[2Jclear screen attempt",
      display: true,
      details: {
        msg_id: "m3",
        header: "from rogue → worker @ /repo",
        sender: "rogue",
        target: "worker",
        summaryLine: "\x1b[2Jclear screen attempt",
      },
      timestamp: Date.now(),
    };

    const lines = renderComsInboundMessage(msg, makeOptions({ expanded: false }), theme).render(100);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("\x1b"), false);
    assert.match(lines[0], /clear screen attempt/);
  });

  it("keeps collapsed coms-response within narrow terminal widths", () => {
    const msg: CompactCustomMessage<ComsResponseDetails> = {
      role: "custom",
      customType: COMS_RESPONSE_CUSTOM_TYPE,
      content: "x".repeat(200),
      display: true,
      details: {
        msg_id: "m4",
        header: "coms response from peer-long-name → self",
        sender: "peer-long-name",
        target: "self",
        error: null,
        queued_msg_ids: [],
        queuedMsgIds: [],
        summaryLine: "a very long peer response summary line that must truncate cleanly inside seventy columns",
      },
      timestamp: Date.now(),
    };

    const lines = renderComsResponseMessage(msg, makeOptions({ expanded: false }), theme).render(70);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= 70);
  });

  it("renders coms-inbound full header plus body when expanded", () => {
    const content = '[from USER (a human), via manager @ /repo] Ship it now.\n\nSecond paragraph.\n\nReply to me via coms_send(target="manager")';
    const msg: CompactCustomMessage<ComsInboundDetails> = {
      role: "custom",
      customType: COMS_INBOUND_CUSTOM_TYPE,
      content,
      display: true,
      details: {
        msg_id: "m5",
        header: "from manager → worker @ /repo (from the USER)",
        sender: "manager",
        target: "worker",
        origin: "user",
        summaryLine: "Ship it now.",
      },
      timestamp: Date.now(),
    };

    const rendered = renderComsInboundMessage(msg, makeOptions({ expanded: true }), theme).render(120).join("\n");
    assert.match(rendered, /\[from manager → worker @ \/repo \(from the USER\)\]/);
    assert.match(rendered, /Second paragraph\./);
  });
});

describe("live COMS runtime customType emission (#1454)", () => {
  const shutdowns: Array<() => Promise<void>> = [];
  let workspace: string | null = null;

  afterEach(async () => {
    while (shutdowns.length > 0) {
      await shutdowns.pop()!();
    }
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = null;
    }
  });

  async function startLivePeer(name: string, sessionId: string) {
    const tools = new Map<string, any>();
    const handlers = new Map<string, Function>();
    const renderers = new Map<string, Function>();
    const messages: any[] = [];
    const flags = new Map<string, any>([
      ["cname", name],
      ["project", "renderer-test"],
    ]);
    const pi: any = {
      registerFlag: () => {},
      getFlag: (k: string) => flags.get(k),
      registerTool: (t: any) => tools.set(t.name, t),
      registerCommand: () => {},
      registerMessageRenderer: (customType: string, renderer: Function) => renderers.set(customType, renderer),
      getActiveTools: () => [...tools.keys()],
      setActiveTools: () => {},
      appendEntry: () => {},
      on: (ev: string, fn: Function) => handlers.set(ev, fn),
      sendMessage: (msg: any) => messages.push(msg),
      events: { on: () => () => {}, emit: () => {} },
    };
    const runtime: ComsPeerRuntime = createComsPeerRuntime(pi, {
      deferred: true,
      allowSubagentChild: true,
      registerSignalHandlers: false,
      comsDir: join(workspace!, "coms"),
      sessionId,
      getFlag: (k) => flags.get(k),
    });
    const ctx: any = {
      cwd: workspace,
      hasUI: false,
      isIdle: () => true,
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      model: { id: "test-model" },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    };
    await runtime.start(ctx);
    shutdowns.push(async () => { await runtime.stop({ reason: "stop" }); });
    return { tools, handlers, renderers, messages, runtime };
  }

  it("emits fixed coms-inbound with structured details while preserving full LLM content", async () => {
    workspace = makeTempDir("coms-renderers-");
    mkdirSync(join(workspace, ".pi"));
    writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: join(workspace, "coms") }));
    const receiver = await startLivePeer("receiver", "recv-sess");
    const sender = await startLivePeer("sender", "send-sess");

    assert.equal(receiver.renderers.has(COMS_INBOUND_CUSTOM_TYPE), true);
    assert.equal(receiver.renderers.has(COMS_RESPONSE_CUSTOM_TYPE), true);

    await sender.tools.get("coms_send").execute("call-1", {
      target: "receiver",
      prompt: "First line summary\nDetailed second line",
    });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !receiver.messages.some((m) => m.customType === COMS_INBOUND_CUSTOM_TYPE)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const inbound = receiver.messages.find((m) => m.customType === COMS_INBOUND_CUSTOM_TYPE);
    assert.ok(inbound);
    assert.equal(inbound.details?.sender, "sender");
    assert.equal(inbound.details?.target, "receiver");
    assert.equal(inbound.details?.summaryLine, "First line summary");
    assert.match(String(inbound.details?.header), /^from sender → receiver @ /);
    assert.match(String(inbound.content), /^\[from sender @ /);
    assert.match(String(inbound.content), /Detailed second line/);
  });

  it("emits fixed coms-response with structured details while preserving full LLM content", async () => {
    workspace = makeTempDir("coms-renderers-resp-");
    mkdirSync(join(workspace, ".pi"));
    writeFileSync(join(workspace, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_dir: join(workspace, "coms") }));
    const receiver = await startLivePeer("receiver", "recv-sess-2");
    const sender = await startLivePeer("sender", "send-sess-2");

    await sender.tools.get("coms_send").execute("call-resp", {
      target: "receiver",
      prompt: "status check",
    });

    const inDeadline = Date.now() + 3_000;
    while (Date.now() < inDeadline && !receiver.messages.some((m) => m.customType === COMS_INBOUND_CUSTOM_TYPE)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const inbound = receiver.messages.find((m) => m.customType === COMS_INBOUND_CUSTOM_TYPE);
    assert.ok(inbound);
    await receiver.handlers.get("message_start")!({ message: { role: "custom", ...inbound } });
    const fullReply = "PR #1454 green\nLine 2 of full reply";
    await receiver.handlers.get("agent_end")!(
      { messages: [{ role: "assistant", content: [{ type: "text", text: fullReply }] }] },
      {
        cwd: workspace,
        hasUI: false,
        ui: { notify: () => {} },
        sessionManager: {
          getSessionId: () => "recv-sess-2",
          getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: fullReply }] } }],
        },
      },
    );

    const outDeadline = Date.now() + 3_000;
    while (Date.now() < outDeadline && !sender.messages.some((m) => m.customType === COMS_RESPONSE_CUSTOM_TYPE)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const response = sender.messages.find((m) => m.customType === COMS_RESPONSE_CUSTOM_TYPE);
    assert.ok(response);
    assert.equal(response.details?.sender, "receiver");
    assert.equal(response.details?.target, "sender");
    assert.equal(response.details?.summaryLine, "PR #1454 green");
    assert.match(String(response.details?.header), /^coms response from receiver → sender/);
    assert.equal(response.content, fullReply);
  });
});
