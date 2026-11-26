/**
 * Unit tests for mechanical pre-compaction elision of old bulky tool results (issue #1421).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  clearSettingsCache,
  SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  estimateMessagesTokens,
  findProtectedTurnStartIndex,
  registerPreCompactionElision,
} from "../../../extensions/orchestrator/pre-compaction-elision.js";
import {
  formatSpillPreview,
  writeSessionSpill,
} from "../../../extensions/orchestrator/session-spill.js";
import type { Logger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

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

  registerPreCompactionElision(pi, logger ? { log: logger } : undefined);

  function emit(event: string, payload: any, ctx?: any): any {
    let last: any;
    for (const handler of handlers.get(event) ?? []) {
      last = handler(payload, ctx);
    }
    return last;
  }

  return { emit };
}

function writeProjectSettings(cwd: string, settings: Record<string, unknown>): void {
  const piDir = path.join(cwd, ".pi");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "pi-config-settings.json"), JSON.stringify(settings), "utf-8");
  clearSettingsCache();
}

function makeUser(text: string): any {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function makeAssistant(opts: { text?: string; thinking?: string; toolCallId?: string; toolName?: string }): any {
  const content: any[] = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking, thinkingSignature: "sig" });
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.toolCallId) {
    content.push({
      type: "toolCall",
      id: opts.toolCallId,
      name: opts.toolName ?? "bash",
      arguments: { command: "echo hi" },
    });
  }
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: opts.toolCallId ? "toolUse" : "stop",
    timestamp: 2,
  };
}

function makeToolResult(opts: {
  toolCallId: string;
  toolName?: string;
  text?: string;
  image?: boolean;
  details?: unknown;
  isError?: boolean;
}): any {
  const content: any[] = [];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  if (opts.image) content.push({ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
  return {
    role: "toolResult",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName ?? "bash",
    content,
    details: opts.details,
    isError: opts.isError ?? false,
    timestamp: 3,
  };
}

/** Assert every toolCall in assistant messages has its matching toolResult in order. */
function assertToolCallPairing(messages: any[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const callIds = (msg.content ?? [])
      .filter((b: any) => b.type === "toolCall")
      .map((b: any) => b.id);
    if (callIds.length === 0) continue;
    const followingResults = messages.slice(i + 1, i + 1 + callIds.length);
    assert.equal(followingResults.length, callIds.length, "each toolCall must have a following toolResult");
    for (let k = 0; k < callIds.length; k++) {
      assert.equal(followingResults[k].role, "toolResult");
      assert.equal(followingResults[k].toolCallId, callIds[k]);
      assert.ok(Array.isArray(followingResults[k].content) && followingResults[k].content.length > 0);
    }
  }
}

const ENV_VARS = [
  "PI_PRE_COMPACTION_ELISION",
  "PI_PRE_COMPACTION_ELISION_THRESHOLD_PCT",
  "PI_PRE_COMPACTION_ELISION_KEEP_TURNS",
  "PI_PRE_COMPACTION_ELISION_MIN_CHARS",
];
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_VARS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_VARS) {
    const val = savedEnv.get(key);
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  clearSettingsCache();
});

describe("pre-compaction-elision (#1421)", () => {
  it("declares pre-compaction elision settings in settings-keys.json with expected defaults", () => {
    assert.equal(SETTINGS_KEYS.pre_compaction_elision?.default, true);
    assert.equal(SETTINGS_KEYS.pre_compaction_elision_threshold_pct?.default, 70);
    assert.equal(SETTINGS_KEYS.pre_compaction_elision_keep_turns?.default, 6);
    assert.equal(SETTINGS_KEYS.pre_compaction_elision_min_chars?.default, 2000);
    assert.equal(SETTINGS_KEYS.pre_compaction_elision?.group, "Session");
  });

  it("is a complete no-op below the high-water threshold so prompt caches stay untouched", () => {
    const cwd = makeTempDir("elide-noop-");
    const sessionFile = path.join(cwd, "s1.jsonl");
    writeProjectSettings(cwd, {
      pre_compaction_elision: true,
      pre_compaction_elision_threshold_pct: 70,
      pre_compaction_elision_keep_turns: 1,
      pre_compaction_elision_min_chars: 500,
    });
    const { emit } = createHarness();
    const messages = [
      makeUser("start"),
      makeAssistant({ toolCallId: "tc-1" }),
      makeToolResult({ toolCallId: "tc-1", text: "A".repeat(4000) }),
      makeAssistant({ text: "recent turn" }),
    ];
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s1", getSessionFile: () => sessionFile },
      getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: 50 }),
    };

    const result = emit("context", { type: "context", messages }, ctx);
    assert.equal(result, undefined, "below threshold must return undefined (zero mutation)");
    assert.equal(fs.existsSync(path.join(cwd, "s1", "local")), false, "no spill files should be created");
  });

  it("elides only older bulky toolResult text blocks, preserves recent turns/non-toolResult/images/pairing, and backs every elision with a spill file", () => {
    const cwd = makeTempDir("elide-core-");
    const sessionFile = path.join(cwd, "s2.jsonl");
    writeProjectSettings(cwd, {
      pre_compaction_elision: true,
      pre_compaction_elision_threshold_pct: 70,
      pre_compaction_elision_keep_turns: 2,
      pre_compaction_elision_min_chars: 500,
    });
    const { logger } = createFakeLogger();
    const { emit } = createHarness(logger);

    const bigUserText = "U".repeat(5000);
    const bigAssistantProse = "P".repeat(5000);
    const bigThinking = "T".repeat(5000);
    const oldBulkyText = Array.from({ length: 100 }, (_, i) => `old-log-line-${i} ${"x".repeat(20)}`).join("\n");
    const oldSmallText = "tiny tool output";
    const recentBulkyText = "R".repeat(5000);

    const messages = [
      makeUser(bigUserText),                                                                      // 0: user (never elide)
      makeAssistant({ thinking: bigThinking, text: bigAssistantProse, toolCallId: "tc-old-big" }), // 1: assistant turn 1
      makeToolResult({ toolCallId: "tc-old-big", toolName: "bash", text: oldBulkyText, image: true }), // 2: old bulky + image
      makeAssistant({ toolCallId: "tc-old-small" }),                                              // 3: assistant turn 2
      makeToolResult({ toolCallId: "tc-old-small", toolName: "read", text: oldSmallText }),       // 4: old small (< minChars)
      makeAssistant({ toolCallId: "tc-recent-1" }),                                               // 5: assistant turn 3 (PROTECTED)
      makeToolResult({ toolCallId: "tc-recent-1", toolName: "bash", text: recentBulkyText }),     // 6: recent bulky (PROTECTED)
      makeAssistant({ text: "final answer" }),                                                    // 7: assistant turn 4 (PROTECTED)
    ];

    assert.equal(findProtectedTurnStartIndex(messages, 2), 5);

    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s2", getSessionFile: () => sessionFile },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
    };

    const res = emit("context", { type: "context", messages }, ctx);
    assert.ok(res?.messages, "expected elided messages when >= threshold");
    assert.equal(res.messages.length, messages.length);

    // Input array was NOT mutated in place.
    assert.equal(messages[2].content[0].text, oldBulkyText);

    // User message, assistant prose, and thinking block are untouched.
    assert.equal(res.messages[0].content[0].text, bigUserText);
    assert.equal(res.messages[1].content[0].thinking, bigThinking);
    assert.equal(res.messages[1].content[1].text, bigAssistantProse);

    // Old bulky toolResult text block was elided; its sibling image block is preserved verbatim!
    const elidedText: string = res.messages[2].content[0].text;
    assert.match(elidedText, /^\[toolResult elided: tool=bash /);
    assert.equal(res.messages[2].content[1].type, "image", "image block inside toolResult must never be elided");
    const spillMatch = /full output saved to: ([^\n\]]+?) —/.exec(elidedText);
    assert.ok(spillMatch, "elided placeholder must include spill file path");
    assert.equal(fs.readFileSync(spillMatch[1], "utf-8"), oldBulkyText, "spill file must hold exact original text");

    // Old small toolResult and recent bulky toolResult are untouched.
    assert.equal(res.messages[4].content[0].text, oldSmallText);
    assert.equal(res.messages[6].content[0].text, recentBulkyText);

    // Tool-call / tool-result pairing is strictly preserved.
    assertToolCallPairing(res.messages);
  });

  it("reuses existing #1420 spill file path instead of writing a duplicate spill file", () => {
    const cwd = makeTempDir("elide-reuse-");
    const sessionFile = path.join(cwd, "s3.jsonl");
    const spillDir = path.join(cwd, "s3", "local");
    writeProjectSettings(cwd, {
      pre_compaction_elision: true,
      pre_compaction_elision_threshold_pct: 70,
      pre_compaction_elision_keep_turns: 1,
      pre_compaction_elision_min_chars: 300,
    });

    // Simulate #1420 having already spilled a 6000-char payload into 1.log with a preview.
    const fullOriginal = Array.from({ length: 150 }, (_, i) => `full-line-${i} ${"Q".repeat(25)}`).join("\n");
    const written = writeSessionSpill(fullOriginal, spillDir);
    const preview = formatSpillPreview(fullOriginal, written.path, 2000);
    assert.ok(preview.length >= 300, "preview itself is above minChars to test reuse");

    const messages = [
      makeUser("go"),
      makeAssistant({ toolCallId: "tc-spilled" }),
      makeToolResult({
        toolCallId: "tc-spilled",
        toolName: "bash",
        text: preview,
        details: {
          __piSpills: [{ blockIndex: 0, path: written.path, originalChars: written.chars, originalBytes: written.bytes, originalLines: written.lines }],
        },
      }),
      makeAssistant({ text: "done" }),
    ];

    const { emit } = createHarness();
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s3", getSessionFile: () => sessionFile },
      getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
    };

    const res = emit("context", { type: "context", messages }, ctx);
    assert.ok(res?.messages);
    const placeholder: string = res.messages[2].content[0].text;
    assert.ok(placeholder.includes(written.path), "must reuse exact existing spill path");
    assert.ok(placeholder.includes(`${fullOriginal.length} chars, 150 lines`), "must preserve original full counts");

    // Still only 1.log in spillDir — no duplicate 2.log created!
    assert.deepEqual(fs.readdirSync(spillDir), ["1.log"]);
  });

  it("replays prior elisions bit-for-bit on subsequent lower-usage turns for prompt-cache stability and clears on session_compact", () => {
    const cwd = makeTempDir("elide-cache-");
    const sessionFile = path.join(cwd, "s4.jsonl");
    writeProjectSettings(cwd, {
      pre_compaction_elision: true,
      pre_compaction_elision_threshold_pct: 70,
      pre_compaction_elision_keep_turns: 1,
      pre_compaction_elision_min_chars: 500,
    });
    const { emit } = createHarness();

    const old1 = "1".repeat(3000);
    const old2 = "2".repeat(3000);
    let usagePct = 75;
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s4", getSessionFile: () => sessionFile },
      getContextUsage: () => ({ tokens: usagePct * 1000, contextWindow: 100_000, percent: usagePct }),
    };

    // Turn 1: usage 75% (>= 70%) -> elides tc-1; tc-2 is inside keepTurns=1 so protected.
    const turn1Messages = [
      makeUser("start"),
      makeAssistant({ toolCallId: "tc-1" }),
      makeToolResult({ toolCallId: "tc-1", text: old1 }),
      makeAssistant({ toolCallId: "tc-2" }),
      makeToolResult({ toolCallId: "tc-2", text: old2 }),
    ];
    const res1 = emit("context", { type: "context", messages: turn1Messages }, ctx);
    assert.ok(res1?.messages);
    const firstPlaceholder = res1.messages[2].content[0].text;
    assert.match(firstPlaceholder, /^\[toolResult elided:/);
    assert.equal(res1.messages[4].content[0].text, old2, "tc-2 is protected in turn 1");

    // Turn 2: after elision, provider reports 55% (< 70%) and a new turn 3 arrives (so tc-2 is now older).
    // Must replay exact placeholder for tc-1 (prompt-cache stable) and NOT elide tc-2 yet!
    usagePct = 55;
    const turn2Messages = [...turn1Messages, makeAssistant({ text: "turn 3" })];
    const res2 = emit("context", { type: "context", messages: turn2Messages }, ctx);
    assert.ok(res2?.messages);
    assert.equal(res2.messages[2].content[0].text, firstPlaceholder, "tc-1 placeholder must replay bit-for-bit");
    assert.equal(res2.messages[4].content[0].text, old2, "must not trigger new elision while below threshold");

    // After session_compact, cached elisions are cleared so below-threshold returns undefined again.
    emit("session_compact", { reason: "threshold" }, ctx);
    const resAfterCompact = emit("context", { type: "context", messages: turn2Messages }, ctx);
    assert.equal(resAfterCompact, undefined);
  });

  it("falls back to message token estimation when getContextUsage returns null tokens and skips elision if spill write fails", () => {
    const cwd = makeTempDir("elide-fallback-");
    // Block spill dir creation with a regular file to verify failure safety.
    const blockingFile = path.join(cwd, "blocked");
    fs.writeFileSync(blockingFile, "not a dir", "utf-8");
    writeProjectSettings(cwd, {
      pre_compaction_elision: true,
      pre_compaction_elision_threshold_pct: 70,
      pre_compaction_elision_keep_turns: 1,
      pre_compaction_elision_min_chars: 500,
    });
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness(logger);

    const messages = [
      makeUser("u"),
      makeAssistant({ toolCallId: "tc-fb" }),
      makeToolResult({ toolCallId: "tc-fb", text: "Z".repeat(4000) }), // ~1000 tokens
      makeAssistant({ text: "ok" }),
    ];
    assert.ok(estimateMessagesTokens(messages) >= 1000);

    // contextWindow = 1000 with null tokens -> fallback estimates ~1000/1000 = 100% >= 70%.
    const ctx = {
      cwd,
      model: { contextWindow: 1000 },
      sessionManager: { getSessionId: () => "s-fb", getSessionFile: () => `${blockingFile}.jsonl` },
      getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
    };

    const res = emit("context", { type: "context", messages }, ctx);
    assert.equal(res, undefined, "must skip elision and keep data intact when spill write fails");
    assert.ok(entries.some((e) => e.level === "warn" && e.args[0] === "pre_compaction_elision_spill_failed"));
  });

  it("respects pre_compaction_elision=false setting", () => {
    const cwd = makeTempDir("elide-off-");
    writeProjectSettings(cwd, {
      pre_compaction_elision: false,
      pre_compaction_elision_threshold_pct: 30,
      pre_compaction_elision_keep_turns: 1,
      pre_compaction_elision_min_chars: 200,
    });
    const { emit } = createHarness();
    const messages = [
      makeUser("go"),
      makeAssistant({ toolCallId: "tc-1" }),
      makeToolResult({ toolCallId: "tc-1", text: "X".repeat(5000) }),
      makeAssistant({ text: "recent" }),
    ];
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "s-off", getSessionFile: () => undefined },
      getContextUsage: () => ({ tokens: 95_000, contextWindow: 100_000, percent: 95 }),
    };

    assert.equal(emit("context", { type: "context", messages }, ctx), undefined);
  });
});
