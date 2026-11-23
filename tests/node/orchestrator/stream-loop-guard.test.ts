/**
 * Streaming repetition/degeneration loop abort guard tests (issue #1374).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCK_REPEAT_THRESHOLD,
  CONSECUTIVE_LINE_THRESHOLD,
  StreamLoopGuard,
  registerStreamLoopGuard,
} from "../../../extensions/orchestrator/stream-loop-guard.js";

type Handler = (...args: any[]) => any;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as any;

  registerStreamLoopGuard(pi);

  function emit(event: string, payload: any, ctx?: any): void {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload, ctx);
    }
  }

  return { emit };
}

function makeLiveCtx(hasUI = true, abortImpl?: () => void) {
  let abortCalls = 0;
  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    mode: "interactive",
    hasUI,
    abort() {
      abortCalls += 1;
      abortImpl?.();
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
  it("detects >= 12 consecutive identical dot lines in text stream", () => {
    const guard = new StreamLoopGuard();
    for (let i = 0; i < CONSECUTIVE_LINE_THRESHOLD - 1; i += 1) {
      assert.equal(guard.push("text", ".\n"), null);
    }
    const hit = guard.push("text", ".\n");
    assert.deepEqual(hit, {
      kind: "repeated_line",
      stream: "text",
      runLength: CONSECUTIVE_LINE_THRESHOLD,
      sample: ".",
    });
  });

  it("handles 1-char chunking, CRLF split across deltas, and whitespace padding", () => {
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
    assert.equal(detection.sample, ".");
  });

  it("detects >= 12 consecutive bare dash lines and repeated sentences", () => {
    const dashGuard = new StreamLoopGuard();
    const dashHit = dashGuard.push("text", "-\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(dashHit);
    assert.equal(dashHit.kind, "repeated_line");
    assert.equal(dashHit.sample, "-");

    const sentenceGuard = new StreamLoopGuard();
    const sentence = "I will check the deployment status now.";
    const sentenceHit = sentenceGuard.push(
      "text",
      `${sentence}\n`.repeat(CONSECUTIVE_LINE_THRESHOLD),
    );
    assert.ok(sentenceHit);
    assert.equal(sentenceHit.kind, "repeated_line");
    assert.equal(sentenceHit.sample, sentence);
  });

  it("does not trigger on 11 identical lines or prematurely via 2-line block rule at 10 lines", () => {
    const guard = new StreamLoopGuard();
    assert.equal(guard.push("text", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD - 1)), null);
  });

  it("detects >= 5 consecutive repeats of 2-, 3-, and 4-line blocks", () => {
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
      assert.equal(hit.sample, block.join("\\n"));
    }
  });

  it("truncates long samples to 120 characters", () => {
    const guard = new StreamLoopGuard();
    const longLine = `repeat-${"x".repeat(200)}`;
    const hit = guard.push("text", `${longLine}\n`.repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.sample.length, 120);
    assert.ok(hit.sample.endsWith("…"));
  });

  it("detects degenerate flat-indentation closing braces while ignoring dedenting nested JSON", () => {
    const degenerate = new StreamLoopGuard();
    const hit = degenerate.push("text", "}\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.kind, "repeated_line");

    const nestedJson = new StreamLoopGuard();
    const closingBraces = Array.from({ length: 16 }, (_, i) => `${"  ".repeat(16 - i)}}`).join("\n") + "\n";
    assert.equal(nestedJson.push("text", closingBraces), null);
  });

  it("does not false-positive on oversized lines sharing a long prefix", () => {
    const guard = new StreamLoopGuard();
    const prefix = "a".repeat(600);
    const lines = Array.from({ length: 15 }, (_, i) => `${prefix}-${i}\n`).join("");
    assert.equal(guard.push("text", lines), null);
  });

  it("detects loops inside thinking stream independently of text stream", () => {
    const guard = new StreamLoopGuard();
    // Open fence in thinking should not suppress text detection.
    assert.equal(guard.push("thinking", "```ts\n"), null);
    const hit = guard.push("text", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(hit);
    assert.equal(hit.stream, "text");

    guard.reset();
    const thinkingHit = guard.push("thinking", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(thinkingHit);
    assert.equal(thinkingHit.stream, "thinking");
  });
});

describe("StreamLoopGuard false-positive resistance", () => {
  it("ignores repeated lines and blocks inside backtick and tilde code fences", () => {
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

    const tildeBlock = [
      "~~~yaml",
      ...Array.from({ length: 10 }, () => "key: value\nother: value"),
      "~~~",
      "",
    ].join("\n");
    assert.equal(guard.push("text", tildeBlock), null);

    // 4-backtick outer fence containing a 3-backtick inner fence must remain fenced.
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

  it("ignores markdown tables including repeated identical table rows", () => {
    const guard = new StreamLoopGuard();
    const normalTable = [
      "| Service | Status | Notes |",
      "| ------- | ------ | ----- |",
      ...Array.from({ length: 20 }, (_, i) => `| svc-${i} | ok | ready |`),
      "",
    ].join("\n");
    assert.equal(guard.push("text", normalTable), null);

    const identicalRowsTable = [
      "| Check | Result |",
      "| ----- | ------ |",
      ...Array.from({ length: 20 }, () => "| ok | — |"),
      "",
    ].join("\n");
    assert.equal(guard.push("text", identicalRowsTable), null);

    // Pure pipe degeneration (no cell text) must still be caught.
    const pipeDegeneration = new StreamLoopGuard();
    const pipeHit = pipeDegeneration.push("text", "|||\n".repeat(CONSECUTIVE_LINE_THRESHOLD));
    assert.ok(pipeHit);
    assert.equal(pipeHit.kind, "repeated_line");
  });

  it("ignores horizontal rules, bullet lists, numbered lists, diffs, JSON, blank lines, and prose", () => {
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

    const bulletList = Array.from({ length: 20 }, (_, i) => `- Bullet item ${i + 1}\n`).join("");
    assert.equal(guard.push("text", bulletList), null);

    const numberedList = Array.from({ length: 20 }, (_, i) => `${i + 1}. Numbered step ${i + 1}\n`).join("");
    assert.equal(guard.push("text", numberedList), null);

    const diffHunk = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,6 +1,6 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      "@@ -20,4 +20,4 @@",
      "-return oldVal;",
      "+return newVal;",
      "",
    ].join("\n");
    assert.equal(guard.push("text", diffHunk), null);

    const jsonArray = `${JSON.stringify(
      Array.from({ length: 15 }, (_, i) => ({ id: i, ok: true, label: `item-${i}` })),
      null,
      2,
    )}\n`;
    assert.equal(guard.push("text", jsonArray), null);

    // 20 consecutive blank lines should never trigger either rule.
    assert.equal(guard.push("text", "\n".repeat(20)), null);

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
  it("aborts once per assistant message on text_delta loop and notifies UI", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls, notifications } = makeLiveCtx(true);

    emit("turn_start", {}, ctx);
    emit("message_start", {}, ctx);
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    // Additional deltas after abort must not trigger a second abort or notification.
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    emit("message_update", deltaEvent("thinking_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    assert.equal(getAbortCalls(), 1);
    assert.deepEqual(notifications, [
      { text: "Aborted streaming repetition loop", level: "warning" },
    ]);
  });

  it("aborts on thinking_delta loop and skips UI notification when hasUI is false", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls, notifications } = makeLiveCtx(false);

    emit("message_update", deltaEvent("thinking_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);

    assert.equal(getAbortCalls(), 1);
    assert.deepEqual(notifications, []);
  });

  it("aborts on multi-line block repeat in message_update", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls, notifications } = makeLiveCtx(true);

    const block = "Waiting for confirmation...\nRetrying check...\n";
    for (let i = 0; i < BLOCK_REPEAT_THRESHOLD; i += 1) {
      emit("message_update", deltaEvent("text_delta", block), ctx);
    }

    assert.equal(getAbortCalls(), 1);
    assert.equal(notifications.length, 1);
  });

  it("resets one-shot and sliding buffer across turn_start, message_start, session_start, and session_shutdown", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx(true);

    for (const boundary of ["turn_start", "message_start", "session_start", "session_shutdown"] as const) {
      // Partial run below threshold before boundary must not carry across boundary.
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD - 2)), ctx);
      emit(boundary, {}, ctx);
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD - 2)), ctx);
      assert.equal(getAbortCalls(), 0, `unexpected carry-over across ${boundary}`);
      emit(boundary, {}, ctx);
    }

    // Trigger abort, then verify every lifecycle boundary re-arms the guard.
    let expectedAborts = 0;
    for (const boundary of ["turn_start", "message_start", "session_start", "session_shutdown"] as const) {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
      expectedAborts += 1;
      assert.equal(getAbortCalls(), expectedAborts);
      emit(boundary, {}, ctx);
    }
  });

  it("ignores toolcall_delta and keeps message-level one-shot guard across text_start", () => {
    const { emit } = createHarness();
    const { ctx, getAbortCalls } = makeLiveCtx(true);

    emit("message_update", deltaEvent("toolcall_delta", ".\n".repeat(20)), ctx);
    assert.equal(getAbortCalls(), 0);

    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    assert.equal(getAbortCalls(), 1);

    // text_start resets only the stream buffer, not the message-level aborted flag.
    emit("message_update", { type: "message_update", assistantMessageEvent: { type: "text_start" } }, ctx);
    emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), ctx);
    assert.equal(getAbortCalls(), 1);
  });

  it("handles stale ctx and throwing ctx.abort gracefully", () => {
    const { emit } = createHarness();
    const stale = makeStaleCtx();
    assert.doesNotThrow(() => {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), stale.ctx);
    });
    assert.equal(stale.getAbortCalls(), 0);
    assert.deepEqual(stale.notifications, []);

    emit("message_start", {}, stale.ctx);
    const throwing = makeLiveCtx(true, () => {
      throw new Error("abort failed");
    });
    assert.doesNotThrow(() => {
      emit("message_update", deltaEvent("text_delta", ".\n".repeat(CONSECUTIVE_LINE_THRESHOLD)), throwing.ctx);
    });
    assert.equal(throwing.getAbortCalls(), 1);
    assert.equal(throwing.notifications.length, 1);
  });
});
