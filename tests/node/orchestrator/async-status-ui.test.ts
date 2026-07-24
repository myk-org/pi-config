import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAsyncOutputLine } from "../../../extensions/orchestrator/async-status-parse.ts";

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
