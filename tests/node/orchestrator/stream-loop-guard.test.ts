/**
 * Streaming repetition/degeneration loop abort guard tests (issue #1374).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCK_REPEAT_THRESHOLD,
  CONSECUTIVE_LINE_THRESHOLD,
  StreamLoopGuard,
  registerStreamLoopGuard,
} from "../../../extensions/orchestrator/stream-loop-guard.js";
import type { Logger } from "../../../extensions/shared/logger.js";
import {
  hasStreamLoopAborted,
  resetStreamLoopAbortBridgeForTests,
} from "../../../extensions/shared/stream-loop-abort-bridge.js";

afterEach(() => {
  resetStreamLoopAbortBridgeForTests();
});

type Handler = (...args: any[]) => any;

interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  args: any[];
}

function createFakeLogger(): { logger: Logger; entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const logger: Logger = {
    debug: (...args: any[]) => entries.push({ level: "debug", args }),
    info: (...args: any[]) => entries.push({ level: "info", args }),
    warn: (...args: any[]) => entries.push({ level: "warn", args }),
    error: (...args: any[]) => entries.push({ level: "error", args }),
    isDebugEnabled: () => true,
  };
  return { logger, entries };
}

function createHarness(logger?: Logger) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as any;

  registerStreamLoopGuard(pi, logger ? { logger } : undefined);

  function emit(event: string, payload: any, ctx?: any): void {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload, ctx);
    }
  }

  return { emit };
}

function makeLiveCtx(opts?: {
  hasUI?: boolean;
  sessionId?: string;
  abortImpl?: () => void;
  notifyImpl?: (text: string, level: string) => void;
}) {
  let abortCalls = 0;
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    mode: "interactive",
    hasUI: opts?.hasUI ?? true,
    ...(opts?.sessionId !== undefined
      ? { sessionManager: { getSessionId: () => opts.sessionId } }
      : {}),
    abort() {
      abortCalls += 1;
      opts?.abortImpl?.();
    },
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
        opts?.notifyImpl?.(text, level);
      },
    },
  };
  return {
    ctx,
    getAbortCalls: () => abortCalls,
    notifications,
  };
}

function makeStaleCtx() {
  let abortCalls = 0;
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    get mode(): string {
      throw new Error("Context is stale after session replacement or reload");
    },
    abort() {
      abortCalls += 1;
    },
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  };
  return {
    ctx,
    getAbortCalls: () => abortCalls,
    notifications,
  };
}

function deltaEvent(type: "text_delta" | "thinking_delta" | "toolcall_delta", delta: string) {
  return {
    type: "message_update",
    assistantMessageEvent: { type, delta },
  };
}

describe("StreamLoopGuard (pure detector)", () => {
  it("detects 12 consecutive dot lines in text stream", () => {
    const guard = new StreamLoopGuard();
    for (let i = 0; i < CONSECUTIVE_LINE_THRESHOLD - 1; i += 1) {
      assert.equal(guard.push("text", ".\n"), null);
    }
    const hit = guard.push("text", ".\n");
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
    assert.equal(hit.stream, "text");
    assert.equal(hit.runLength, CONSECUTIVE_LINE_THRESHOLD);
    assert.equal(hit.sampleLength, 1);
  });

  it("handles single-character streaming with CRLF line endings", () => {
    const guard = new StreamLoopGuard();
    const lines = Array.from({ length: CONSECUTIVE_LINE_THRESHOLD }, (_, idx) =>
      idx % 2 === 0 ? " . \r\n" : ".\r\n",
    ).join("");
    let detection = null;
    for (const ch of lines) {
      const hit = guard.push("text", ch);
      if (hit) {
        detection = hit;
        break;
      }
    }
    assert.ok(detection);
    assert.equal(detection.kind, "repeated_line");
    assert.equal(detection.sampleLength, 1);
  });

  it("detects 12 consecutive bare dash lines", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("text", "-\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
    assert.equal(hit.sampleLength, 1);
  });

  it("detects 12 consecutive identical sentences", () => {
    const guard = new StreamLoopGuard();
    const sentence = "I will check the deployment status now.";
    const hit = guard.push("text", `${sentence}\n`.repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
    assert.equal(hit.sampleLength, sentence.length);
  });

  it("does not trigger on 11 identical lines", () => {
    const guard = new StreamLoopGuard();
    assert.equal(guard.push("text", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD - 1)), null);
  });

  it("detects 5 consecutive repeats of 2-to-4 line blocks", () => {
    for (const block of [
      ["Checking status...", "Still waiting..."],
      ["Step 1", "Step 2", "Step 3"],
      ["Line A", "Line B", "Line C", "Line D"],
      [".", ""],
    ]) {
      const guard = new StreamLoopGuard();
      const unit = `${block.join("\n")}\n`;
      for (let i = 0; i < BLOCK_REPEAT_THRESHOLD - 1; i += 1) {
        assert.equal(guard.push("text", unit), null);
      }
      const hit = guard.push("text", unit);
      assert.ok(hit, `expected detection for block size ${block.length}`);
      assert.equal(hit.kind, "repeated_block");
      assert.equal(hit.runLength, BLOCK_REPEAT_THRESHOLD);
      assert.equal(hit.sampleLength, block.join("\n").length);
    }
  });

  it("redacts raw content from detection sample fingerprint", () => {
    const guard = new StreamLoopGuard();
    const privateLine = "confidential customer account note 12345";
    const hit = guard.push("text", `${privateLine}\n`.repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.ok(!hit.sample.includes("confidential"));
    assert.ok(!hit.sample.includes("12345"));
    assert.match(hit.sample, /^<redacted:len=\d+,sha256=[0-9a-f]{12}>$/);
    assert.equal(hit.sampleLength, privateLine.length);
  });

  it("detects flat-indentation repeated closing braces", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("text", "}\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("ignores dedenting nested closing braces", () => {
    const guard = new StreamLoopGuard();
    const closingBraces =
      Array.from({ length: 16 }, (_, i) => `${"  ".repeat(16 - i)}}`).join("\n") + "\n";
    assert.equal(guard.push("text", closingBraces), null);
  });

  it("ignores oversized lines sharing a long prefix", () => {
    const guard = new StreamLoopGuard();
    const prefix = "a".repeat(600);
    const lines = Array.from({ length: 15 }, (_, i) => `${prefix}-${i}\n`).join("");
    assert.equal(guard.push("text", lines), null);
  });

  it("isolates thinking stream fences from text stream detection", () => {
    const guard = new StreamLoopGuard();
    assert.equal(guard.push("thinking", "```ts\n"), null);
    const hit = guard.push("text", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.stream, "text");
  });

  it("detects loops in thinking stream", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("thinking", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.stream, "thinking");
  });
});

describe("StreamLoopGuard false-positive resistance", () => {
  it("ignores repeated lines inside backtick code fences", () => {
    const guard = new StreamLoopGuard();
    const backtickBlock = [
      "Here is an ASCII diagram:",
      "```text",
      ...".".repeat(20).split(""),
      "```",
      "Done.",
      "",
    ].join("\n");
    assert.equal(guard.push("text", backtickBlock), null);
  });

  it("ignores repeated blocks inside tilde code fences", () => {
    const guard = new StreamLoopGuard();
    const tildeBlock = [
      "~~~yaml",
      ...Array.from({ length: 10 }, () => "key: value\nother: value"),
      "~~~",
      "",
    ].join("\n");
    assert.equal(guard.push("text", tildeBlock), null);
  });

  it("keeps 4-backtick outer fence open across inner 3-backtick markers", () => {
    const guard = new StreamLoopGuard();
    const nestedFence = [
      "````markdown",
      "```",
      ...".".repeat(15).split(""),
      "```",
      ...".".repeat(15).split(""),
      "````",
      "",
    ].join("\n");
    assert.equal(guard.push("text", nestedFence), null);
  });

  it("does not treat 4-space indented backticks as a fence opener", () => {
    const guard = new StreamLoopGuard();
    const text = `    \`\`\`\n${".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)}`;
    const hit = guard.push("text", text);
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("does not treat tab-indented backticks as a fence opener", () => {
    const guard = new StreamLoopGuard();
    const text = `\t\`\`\`\n${".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)}`;
    const hit = guard.push("text", text);
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("does not merge repeated lines across a code fence boundary", () => {
    const guard = new StreamLoopGuard();
    const text = [
      ...".\n".repeat(8).trimEnd().split("\n"),
      "```",
      "code()",
      "```",
      ...".\n".repeat(8).trimEnd().split("\n"),
      "",
    ].join("\n");
    assert.equal(guard.push("text", text), null);
  });

  it("still detects degeneration after inline triple-backtick spans", () => {
    const guard = new StreamLoopGuard();
    const text = `Use \`\`\`inline\`\`\` here.\n${".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)}`;
    const hit = guard.push("text", text);
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("ignores GFM markdown tables with repeated identical rows", () => {
    const guard = new StreamLoopGuard();
    const identicalRowsTable = [
      "| Check | Result |",
      "| ----- | ------ |",
      ...Array.from({ length: 20 }, () => "| ok | — |"),
      "",
    ].join("\n");
    assert.equal(guard.push("text", identicalRowsTable), null);
  });

  it("detects standalone pipe-wrapped loops without table header context", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("text", "| retry |\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("ignores repeated addition pairs inside a bounded unified diff hunk", () => {
    const guard = new StreamLoopGuard();
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,14 @@",
      " const start = 1;",
      ...Array.from({ length: 6 }, () => "+alpha\n+beta"),
      " const end = 2;",
      "",
    ].join("\n");
    assert.equal(guard.push("text", diff), null);
  });

  it("detects degeneration after a bounded unified diff hunk ends", () => {
    const guard = new StreamLoopGuard();
    const diffThenLoop = [
      "@@ -1,1 +1,2 @@",
      " ctx",
      "+added",
      ...".".repeat(CONSECUTIVE_LINE_THRESHOLD).split(""),
      "",
    ].join("\n");
    const hit = guard.push("text", diffThenLoop);
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("rejects oversized diff hunk counts so repeated additions cannot hide loops", () => {
    const hugeHeader = `@@ -1,1 +1,${"9".repeat(400)} @@\n`;
    const hugeGuard = new StreamLoopGuard();
    const hugeHit = hugeGuard.push("text", `${hugeHeader}${"+.\n".repeat(CONSECUTIVE_LINE_THRESHOLD)}`);
    assert.ok(hugeHit);
    assert.equal(hugeHit.kind, "repeated_line");

    const cappedGuard = new StreamLoopGuard();
    const cappedHit = cappedGuard.push(
      "text",
      `@@ -1,1 +1,10001 @@\n${"+.\n".repeat(CONSECUTIVE_LINE_THRESHOLD)}`,
    );
    assert.ok(cappedHit);
    assert.equal(cappedHit.kind, "repeated_line");
  });

  it("ignores repeated scalar entries inside a pretty-printed JSON array", () => {
    const guard = new StreamLoopGuard();
    const jsonArray = `${JSON.stringify(Array.from({ length: 15 }, () => "ok"), null, 2)}\n`;
    assert.equal(guard.push("text", jsonArray), null);
  });

  it("detects standalone repeated JSON-like strings outside a JSON container", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("text", '"ok",\n'.repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("exits JSON mode on invalid lines after an unclosed opening bracket", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("text", `[\n${".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)}`);
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("exits JSON mode on malformed JSON property value loops", () => {
    const guard = new StreamLoopGuard();
    const hit = guard.push("text", `{\n${'"x": .\n'.repeat(CONSECUTIVE_LINE_THRESHOLD)}`);
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");
  });

  it("ignores repeated Markdown checklist items", () => {
    const guard = new StreamLoopGuard();
    const checklist = "- [ ] TODO\n".repeat(15);
    assert.equal(guard.push("text", checklist), null);
  });

  it("ignores numbered list items", () => {
    const guard = new StreamLoopGuard();
    const numberedList = Array.from({ length: 20 }, () => "1. Repeat step\n").join("");
    assert.equal(guard.push("text", numberedList), null);
  });

  it("ignores horizontal rules separating sections", () => {
    const guard = new StreamLoopGuard();
    const horizontalRules = [
      "Section 1",
      "---",
      "Section 2",
      "***",
      "Section 3",
      "___",
      "Section 4",
      "---",
      "",
    ].join("\n");
    assert.equal(guard.push("text", horizontalRules), null);
  });

  it("ignores consecutive blank lines", () => {
    const guard = new StreamLoopGuard();
    assert.equal(guard.push("text", "\n".repeat(20)), null);
  });

  it("ignores normal multi-paragraph prose", () => {
    const guard = new StreamLoopGuard();
    const prose = [
      "The orchestrator registers extension handlers at startup.",
      "Each handler observes streaming updates without blocking normal output.",
      "",
      "When a provider streams valid prose across many paragraphs,",
      "the sliding window remains bounded and never aborts the response.",
      "",
    ].join("\n");
    assert.equal(guard.push("text", prose), null);
  });
});

describe("registerStreamLoopGuard (extension hooks)", () => {
  it("calls ctx.abort at most once per assistant message on text_delta loop", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx({ hasUI: true });

    emit("turn_start", {}, ctx);
    emit("message_start", {}, ctx);
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    emit("message_update", deltaEvent("thinking_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    assert.equal(getAbortCalls(), 1);
  });

  it("notifies UI once with warning when hasUI is true", () => {
    const { emit } = createHarness();
    const { ctx, notifications } = makeLiveCtx({ hasUI: true });

    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    assert.deepEqual(notifications, [
      { text: "Aborted streaming repetition loop", level: "warning" },
    ]);
  });

  it("skips UI notification when hasUI is false", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls, notifications } = makeLiveCtx({ hasUI: false });

    emit("message_update", deltaEvent("thinking_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    assert.equal(getAbortCalls(), 1);
    assert.deepEqual(notifications, []);
  });

  it("aborts on multi-line block repeat in message_update", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx({ hasUI: true });

    const block = "Waiting for confirmation...\nRetrying check...\n";
    for (let i = 0; i < BLOCK_REPEAT_THRESHOLD; i += 1) {
      emit("message_update", deltaEvent("text_delta", block), ctx);
    }

    assert.equal(getAbortCalls(), 1);
  });

  it("clears partial runs across lifecycle boundaries", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx({ hasUI: true });

    for (const boundary of ["turn_start", "message_start", "session_start", "session_shutdown"] as const) {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD - 2)), ctx);
      emit(boundary, {}, ctx);
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD - 2)), ctx);
      assert.equal(getAbortCalls(), 0, `unexpected carry-over across ${boundary}`);
      emit(boundary, {}, ctx);
    }
  });

  it("re-arms one-shot abort across lifecycle boundaries", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx({ hasUI: true });

    let expectedAborts = 0;
    for (const boundary of ["turn_start", "message_start", "session_start", "session_shutdown"] as const) {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
      expectedAborts += 1;
      assert.equal(getAbortCalls(), expectedAborts);
      emit(boundary, {}, ctx);
    }
  });

  it("ignores toolcall_delta updates", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx({ hasUI: true });

    emit("message_update", deltaEvent("toolcall_delta", ".\n".repeat(20)), ctx);
    assert.equal(getAbortCalls(), 0);
  });

  it("preserves message-level one-shot abort across text_start", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx({ hasUI: true });

    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    emit("message_update", { type: "message_update", assistantMessageEvent: { type: "text_start" } }, ctx);
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    assert.equal(getAbortCalls(), 1);
  });

  it("ignores stale extension context without calling ctx.abort", () => {
    const { emit } = createHarness();
    const stale = makeStaleCtx();

    assert.doesNotThrow(() => {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), stale.ctx);
    });
    assert.equal(stale.getAbortCalls(), 0);
    assert.deepEqual(stale.notifications, []);
  });

  it("logs redacted metadata on loop detection without raw stream text", () => {
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness(logger);
    const { ctx } = makeLiveCtx({ hasUI: false });
    const privateLine = "confidential internal reasoning note 98765";

    emit("message_update", deltaEvent("thinking_delta", `${privateLine}\n`.repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    const warn = entries.find((e) => e.level === "warn" && e.args[0] === "stream_repetition_loop_aborted");
    assert.ok(warn);
    const serialized = JSON.stringify(warn.args[1]);
    assert.ok(!serialized.includes(privateLine));
    assert.equal(warn.args[1].kind, "repeated_line");
    assert.equal(warn.args[1].stream, "thinking");
    assert.equal(warn.args[1].runLength, CONSECUTIVE_LINE_THRESHOLD);
    assert.match(warn.args[1].sample, /^<redacted:len=\d+,sha256=[0-9a-f]{12}>$/);
  });

  it("logs ctx.abort failures at error level with Error stack trace", () => {
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness(logger);
    const boom = new Error("abort failed");
    const { ctx, getAbortCalls } = makeLiveCtx({
      hasUI: false,
      sessionId: "abort-err-session",
      abortImpl: () => {
        throw boom;
      },
    });

    assert.doesNotThrow(() => {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    });
    assert.equal(getAbortCalls(), 1);
    assert.equal(hasStreamLoopAborted("abort-err-session"), false);

    const errorEntry = entries.find(
      (e) => e.level === "error" && e.args[0] === "stream_repetition_loop_abort_failed",
    );
    assert.ok(errorEntry);
    assert.equal(errorEntry.args[1], boom);
  });

  it("logs UI notification failures at debug level", () => {
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness(logger);
    const { ctx } = makeLiveCtx({
      hasUI: true,
      notifyImpl: () => {
        throw new Error("ui closed");
      },
    });

    assert.doesNotThrow(() => {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    });

    const debugEntry = entries.find(
      (e) => e.level === "debug" && e.args[0] === "stream_repetition_loop_notify_failed",
    );
    assert.ok(debugEntry);
    assert.match(debugEntry.args[1].error, /ui closed/);
  });

  it("logs stream_loop_guard_reset at debug level when state exists", () => {
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness(logger);
    const { ctx } = makeLiveCtx({ hasUI: false });

    emit("turn_start", {}, ctx);
    assert.equal(
      entries.some((e) => e.level === "debug" && e.args[0] === "stream_loop_guard_reset"),
      false,
    );

    emit("message_update", deltaEvent("text_delta", "hello\n"), ctx);
    emit("turn_start", {}, ctx);
    const resetEntry = entries.find(
      (e) => e.level === "debug" && e.args[0] === "stream_loop_guard_reset",
    );
    assert.ok(resetEntry);
    assert.deepEqual(resetEntry.args[1], { reason: "turn_start" });
  });
});
