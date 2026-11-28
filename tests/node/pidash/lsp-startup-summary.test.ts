/**
 * #1492 — PiDash parity tests for `lsp-startup-summary` custom session entries:
 * - History replay (`replaySessionHistory`) converts `lsp-startup-summary` custom entries
 * - Transcript reducer preserves `className: "lsp-startup-summary"`
 * - Live `pidash:custom-entry` forwarding + `/new` session switch without duplicates
 * - `MessageItem` renders muted summary row with visible one-click Copy button
 */
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path, { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import * as rootReact from "react";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import type { Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPidash, replaySessionHistory } from "../../../extensions/pidash/pidash.ts";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import {
  applyTranscriptEvent,
  type TranscriptRefs,
  type TranscriptSink,
} from "../../../extensions/shared/pidash-transcript-reducer.ts";
import type { ChatMessage } from "../../../extensions/shared/types.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

function makeReducerHarness() {
  const messages: ChatMessage[] = [];
  let seq = 0;
  const refs: TranscriptRefs = {
    think: { id: "", text: "", startTs: 0 },
    assist: { id: "", text: "" },
    tool: { id: "", name: "", startTs: 0, callId: "" },
    asyncMsgs: new Map(),
    lastUserText: "",
  };
  const sink: TranscriptSink = {
    add(role, text, className, meta, options) {
      const id = options?.explicitId ?? `m-${++seq}`;
      messages.push({ id, role, text, className, meta, timestamp: options?.timestamp ?? 1000 });
      return id;
    },
    patch(id, fn) {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx !== -1) messages[idx] = fn(messages[idx]);
    },
    findLast(pred) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (pred(messages[i])) return messages[i];
      }
      return undefined;
    },
    dismissAsk() {},
    nextId: () => `id-${++seq}`,
  };
  return { messages, refs, sink };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve();
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 5);
    timer.unref();
  });
}

describe("replaySessionHistory lsp-startup-summary (#1492)", () => {
  it("replays lsp-startup-summary custom entries into displayable custom messages", () => {
    const buffered: string[] = [];
    const sent: string[] = [];
    const entries = [
      {
        type: "custom",
        customType: "lsp-startup-summary",
        timestamp: "2026-11-28T01:00:00.000Z",
        data: {
          summary: "LSP: typescript-language-server, basedpyright, gopls",
          enabled: true,
          available: ["typescript-language-server", "basedpyright", "gopls"],
          missing: [],
        },
      },
    ];

    replaySessionHistory(
      { send: (frame: string) => sent.push(frame) },
      { sessionManager: { getEntries: () => entries } },
      (frame) => buffered.push(frame),
    );

    const { messages, refs, sink } = makeReducerHarness();
    for (const raw of buffered) {
      applyTranscriptEvent(JSON.parse(raw), refs, sink);
    }

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].className, "lsp-startup-summary");
    assert.equal(messages[0].text, "LSP: typescript-language-server, basedpyright, gopls");
    assert.equal(sent.some((f) => JSON.parse(f).type === "replay_complete"), true);
  });

  it("ignores non-summary custom state entries during history replay", () => {
    const buffered: string[] = [];
    const entries = [
      {
        type: "custom",
        customType: "coms-state",
        timestamp: "2026-11-28T01:00:00.000Z",
        data: { active: true, summary: "should not appear" },
      },
      {
        type: "custom",
        customType: "lsp-startup-summary",
        timestamp: "2026-11-28T01:00:01.000Z",
        data: { summary: "   " },
      },
    ];

    replaySessionHistory(
      { send: () => {} },
      { sessionManager: { getEntries: () => entries } },
      (frame) => buffered.push(frame),
    );

    const { messages, refs, sink } = makeReducerHarness();
    for (const raw of buffered) {
      applyTranscriptEvent(JSON.parse(raw), refs, sink);
    }
    assert.equal(messages.length, 0);
  });
});

describe("pidash live lsp-startup-summary forwarding (#1492)", () => {
  async function withPidashWs(
    run: (h: {
      events: EventEmitter;
      emitPi: (name: string, event: unknown, ctx?: unknown) => void;
      frames: Array<Record<string, unknown>>;
      setSession: (file: string, entries: unknown[]) => void;
      ctx: Record<string, unknown>;
    }) => Promise<void>,
  ): Promise<void> {
    const dir = makeTempDir("pidash-lsp-summary-");
    const server = createServer((_req, res) => {
      res.end(JSON.stringify({ status: "ok" }));
    });
    const sockets = new WebSocketServer({ server, path: "/ws/pi" });
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
    const events = new EventEmitter();
    const frames: Array<Record<string, unknown>> = [];
    let sessionFile = "/tmp/session-1.jsonl";
    let sessionEntries: unknown[] = [];

    const pi = {
      events,
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerCommand: () => {},
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI;

    const ctx = {
      mode: "tui",
      cwd: process.cwd(),
      model: null,
      sessionManager: {
        getEntries: () => sessionEntries,
        getSessionFile: () => sessionFile,
      },
    };
    const emitPi = (name: string, event: unknown, overrideCtx: unknown = ctx) => {
      for (const h of handlers.get(name) ?? []) h(event, overrideCtx);
    };
    const setSession = (file: string, entries: unknown[]) => {
      sessionFile = file;
      sessionEntries = entries;
    };

    sockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      assert.ok(addr && typeof addr !== "string");
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ pidash_enable: true, pidash_port: addr.port }));
      setGlobalSettingsPath(settingsPath);
      delete process.env.PI_SUBAGENT_CHILD;

      registerPidash(pi, {
        fetchGitStatus: async () => ({ branch: "main", dirty: false, changes: 0 }),
        fetchWorktreeSummary: async () => ({ worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false }),
      });

      emitPi("session_start", { reason: "startup" }, ctx);
      await waitFor(() => frames.some((f) => f.type === "replay_complete"), "initial replay_complete");

      await run({ events, emitPi, frames, setSession, ctx });
    } finally {
      emitPi("session_shutdown", { reason: "exit" }, ctx);
      setGlobalSettingsPath(null);
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChild;
      await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("forwards live pidash:custom-entry events for the active session", async () => {
    await withPidashWs(async ({ events, frames }) => {
      events.emit("pidash:custom-entry", {
        customType: "lsp-startup-summary",
        content: "LSP (off): gopls, rust-analyzer",
        timestamp: 12345,
        sessionFile: "/tmp/session-1.jsonl",
      });

      await waitFor(
        () =>
          frames.some(
            (f) =>
              f.type === "message_start" &&
              (f.message as any)?.customType === "lsp-startup-summary",
          ),
        "live lsp-startup-summary frame",
      );

      const frame = frames.find(
        (f) => f.type === "message_start" && (f.message as any)?.customType === "lsp-startup-summary",
      );
      assert.equal((frame?.message as any)?.content, "LSP (off): gopls, rust-analyzer");
      assert.equal(frame?.timestamp, 12345);
    });
  });

  it("emits exactly one lsp-startup-summary after session_switch on /new when emitted before pidash session_start", async () => {
    await withPidashWs(async ({ events, emitPi, frames, setSession, ctx }) => {
      const beforeNew = frames.length;
      setSession("/tmp/session-2.jsonl", [
        {
          type: "custom",
          customType: "lsp-startup-summary",
          timestamp: "2026-11-28T01:05:00.000Z",
          data: { summary: "LSP: gopls", enabled: true, available: ["gopls"], missing: [] },
        },
      ]);

      // Simulate orchestrator/lsp running before pidash on /new
      events.emit("pidash:custom-entry", {
        customType: "lsp-startup-summary",
        content: "LSP: gopls",
        timestamp: 20000,
        sessionFile: "/tmp/session-2.jsonl",
      });
      emitPi("session_start", { reason: "new" }, ctx);

      await waitFor(
        () =>
          frames
            .slice(beforeNew)
            .some(
              (f) =>
                f.type === "message_start" &&
                (f.message as any)?.customType === "lsp-startup-summary",
            ),
        "post-switch lsp-startup-summary",
      );

      const postFrames = frames.slice(beforeNew);
      const switchIdx = postFrames.findIndex((f) => f.type === "session_switch");
      const summaryIdxs = postFrames
        .map((f, idx) =>
          f.type === "message_start" && (f.message as any)?.customType === "lsp-startup-summary" ? idx : -1,
        )
        .filter((idx) => idx !== -1);

      assert.notEqual(switchIdx, -1);
      assert.equal(summaryIdxs.length, 1);
      assert.ok(summaryIdxs[0] > switchIdx);
    });
  });
});

let vite: ViteDevServer;
let createRoot: (container: Element) => Root;
let MessageItem: any;

const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
for (const key of ["H", "A", "T"]) {
  Object.defineProperty(rootInternals, key, {
    configurable: true,
    get: () => pidashInternals[key],
    set: (value) => {
      pidashInternals[key] = value;
    },
  });
}

describe("MessageItem lsp-startup-summary rendering (#1492)", () => {
  const mounted: Root[] = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "clipboard");

  before(async () => {
    installReactDomShim();
    ({ createRoot } = await import("../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js"));
    vite = await createViteServer({
      root: path.resolve("extensions/pidash/pidash-ui"),
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    ({ MessageItem } = await vite.ssrLoadModule("/src/components/MessageList.tsx"));
  });

  after(() => vite?.close());

  afterEach(async () => {
    while (mounted.length) await act(async () => mounted.pop()!.unmount());
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    }
  });

  it("renders lsp-startup-summary as a muted row with summary text", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const msg: ChatMessage = {
      id: "lsp-1",
      role: "system",
      className: "lsp-startup-summary",
      text: "LSP: typescript-language-server, basedpyright, gopls",
      timestamp: Date.UTC(2026, 10, 28, 1, 0, 0),
    };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const row = elements(container, "div").find((el) => el.getAttribute("data-testid") === "lsp-startup-summary");
    assert.ok(row);
    assert.equal((row.textContent ?? "").includes("LSP: typescript-language-server, basedpyright, gopls"), true);
    assert.equal((row.getAttribute("class") ?? "").includes("text-muted-foreground"), true);
  });

  it("copies full lsp-startup-summary text when Copy LSP summary button is clicked", async () => {
    const { container } = installReactDomShim();
    const root = createRoot(container);
    mounted.push(root);

    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: async (txt: string) => {
          copied.push(txt);
        },
      },
      configurable: true,
    });

    const summary = "LSP (off): gopls, rust-analyzer";
    const msg: ChatMessage = {
      id: "lsp-2",
      role: "system",
      className: "lsp-startup-summary",
      text: summary,
    };
    await act(async () => root.render(createElement(MessageItem, { msg })));

    const copyBtn = elements(container, "button").find((b) => b.getAttribute("aria-label") === "Copy LSP summary");
    assert.ok(copyBtn);

    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(copied, [summary]);
  });
});
