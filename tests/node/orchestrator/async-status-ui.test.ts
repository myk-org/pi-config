import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { extractAsyncFallbackOutput, parseAsyncOutputLine } from "../../../extensions/orchestrator/async-status-parse.ts";
import { createIncrementalLogReader } from "../../../extensions/orchestrator/async-status-ui.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function textDeltaLine(delta: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  });
}

describe("parseAsyncOutputLine", () => {
  it("extracts text_delta", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    assert.equal(parseAsyncOutputLine(line), "hello");
  });

  it("formats tool_execution_start", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "ls" },
    });
    assert.equal(parseAsyncOutputLine(line), "\n→ bash ls");
  });

  it("returns null for junk", () => {
    assert.equal(parseAsyncOutputLine("not-json"), null);
  });
});

describe("extractAsyncFallbackOutput (#1274)", () => {
  it("extracts readable text and tool events from JSONL tail without raw JSON envelopes", () => {
    const tail = [
      '{"truncated_leading_line":',
      JSON.stringify({ type: "turn_start" }),
      textDeltaLine("Partial "),
      textDeltaLine("answer"),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "git status" } }),
      JSON.stringify({ type: "tool_execution_end", isError: false, result: { content: [{ text: "clean" }] } }),
    ].join("\n");

    const out = extractAsyncFallbackOutput(tail);
    assert.equal(out, "Partial answer\n→ bash git status\n✓ clean");
    assert.doesNotMatch(out, /assistantMessageEvent/);
  });

  it("falls back to raw stdoutTail slice for non-JSON crash output", () => {
    const crash = "Fatal: out of memory\nstack line 1\nstack line 2";
    assert.equal(extractAsyncFallbackOutput(crash), crash);
    assert.equal(extractAsyncFallbackOutput(crash, 12), crash.slice(-12));
  });

  it("truncates long extracted output to maxChars keeping the newest tail", () => {
    const tail = [textDeltaLine("A".repeat(80)), textDeltaLine("B".repeat(40))].join("\n");
    const out = extractAsyncFallbackOutput(tail, 50);
    assert.equal(out.length, 50);
    assert.equal(out, "A".repeat(10) + "B".repeat(40));
  });
});

describe("createIncrementalLogReader (#1209)", () => {
  it("reads only newly appended bytes across polls and swaps array reference on truncation/rewrite", () => {
    const dir = makeTempDir("inc-log-");
    tempDirs.push(dir);
    const logPath = join(dir, "output.log");
    const reader = createIncrementalLogReader(logPath);

    // Missing file returns false without throwing
    assert.equal(reader.readNewContent(), false);
    assert.deepEqual(reader.getLines(), []);

    // First write: complete line + partial UTF-8 sequence split mid-character
    const fullWithEmoji = `${textDeltaLine("hi 🚀")}\n`;
    const emojiBuf = Buffer.from(fullWithEmoji, "utf8");
    const splitPoint = emojiBuf.indexOf(0xf0) + 2; // middle of 4-byte UTF-8 rocket
    writeFileSync(logPath, `${textDeltaLine("first")}\n`);
    appendFileSync(logPath, emojiBuf.subarray(0, splitPoint));

    assert.equal(reader.readNewContent(), true);
    const beforeResetRef = reader.getLines();
    assert.deepEqual(beforeResetRef, ["first"]);

    // Unchanged size returns false
    assert.equal(reader.readNewContent(), false);

    // Append remaining UTF-8 bytes
    appendFileSync(logPath, emojiBuf.subarray(splitPoint));
    assert.equal(reader.readNewContent(), true);
    assert.deepEqual(reader.getLines(), ["first", "hi 🚀"]);
    assert.equal(reader.getLines(), beforeResetRef);

    // Truncation/rewrite with >= as many lines swaps in a new array reference
    writeFileSync(logPath, `${textDeltaLine("a")}\n${textDeltaLine("b")}\n`);
    assert.equal(reader.readNewContent(), true);
    assert.deepEqual(reader.getLines(), ["a", "b"]);
    assert.notEqual(reader.getLines(), beforeResetRef);
  });
});
