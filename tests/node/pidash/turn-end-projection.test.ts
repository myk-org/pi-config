import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectTurnEndEvent } from "../../../extensions/pidash/event-projection.ts";

describe("pidash turn_end projection", () => {
  it("keeps UI metadata while omitting boundary payloads", () => {
    const usage = { input: 120, output: 34, cacheRead: 56, cacheWrite: 7, totalTokens: 217 };

    assert.deepEqual(projectTurnEndEvent({
      type: "turn_end",
      turnIndex: 4,
      outcome: "completed",
      messageEntryId: "message-4",
      toolResultEntryIds: ["tool-result-1"],
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage,
        content: [{ type: "text", text: "large assistant response" }],
      },
      context: { contextMessages: ["large boundary context"] },
      entries: [{ type: "custom", data: "large boundary entry" }],
      toolResults: [{ role: "toolResult", content: "large tool result" }],
      continue: false,
    }, 1_742_000_000_000), {
      type: "turn_end",
      turnIndex: 4,
      outcome: "completed",
      messageEntryId: "message-4",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage,
      },
      timestamp: 1_742_000_000_000,
    });
  });
});
