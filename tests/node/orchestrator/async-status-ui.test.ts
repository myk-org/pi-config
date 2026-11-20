import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseAsyncOutputLine } from "../../../extensions/orchestrator/async-status-parse.ts";
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

describe("createIncrementalLogReader (#1209)", () => {
  it("reads only newly appended bytes across polls and handles partial lines + split UTF-8", () => {
    const dir = makeTempDir("inc-log-");
    tempDirs.push(dir);
    const logPath = join(dir, "output.log");
    const lines: string[] = [];
    const readNew = createIncrementalLogReader(logPath, lines);

    // Missing file returns false without throwing
    assert.equal(readNew(), false);
    assert.deepEqual(lines, []);

    // First write: complete line + partial UTF-8 sequence split mid-character
    const fullWithEmoji = `${textDeltaLine("hi 🚀")}\n`;
    const emojiBuf = Buffer.from(fullWithEmoji, "utf8");
    const splitPoint = emojiBuf.indexOf(0xf0) + 2; // middle of 4-byte UTF-8 rocket
    writeFileSync(logPath, `${textDeltaLine("first")}\n`);
    appendFileSync(logPath, emojiBuf.subarray(0, splitPoint));

    assert.equal(readNew(), true);
    assert.deepEqual(lines, ["first"]);

    // Unchanged size returns false
    assert.equal(readNew(), false);

    // Append remaining UTF-8 bytes
    appendFileSync(logPath, emojiBuf.subarray(splitPoint));
    assert.equal(readNew(), true);
    assert.deepEqual(lines, ["first", "hi 🚀"]);

    // Truncation/replacement resets byte offset cleanly
    writeFileSync(logPath, `${textDeltaLine("reset")}\n`);
    assert.equal(readNew(), true);
    assert.deepEqual(lines, ["reset"]);
  });
});
