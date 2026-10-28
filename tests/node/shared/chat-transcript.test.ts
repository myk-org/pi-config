/** `/last` asks the transcript: what counts as the last reply. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastAssistantText, messageText } from "../../../extensions/shared/chat/chat-transcript.ts";

const assistant = (content: unknown) => ({ type: "message", message: { role: "assistant", content } });

describe("last assistant text", () => {
  it("returns nothing for an empty transcript", () => {
    assert.equal(lastAssistantText([]), "");
  });

  it("picks the newest assistant message", () => {
    const entries = [
      assistant("first"),
      { type: "message", message: { role: "user", content: "question" } },
      assistant("second"),
      { type: "tool_call", name: "bash" },
    ];
    assert.equal(lastAssistantText(entries), "second");
  });

  it("joins text blocks and ignores thinking/tool blocks", () => {
    const text = messageText({
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "part one" },
        { type: "tool_use", name: "bash" },
        { type: "text", text: "part two" },
      ],
    });
    assert.equal(text, "part one\npart two");
  });

  it("skips a trailing assistant message with no text", () => {
    const entries = [assistant("real reply"), assistant([{ type: "tool_use", name: "bash" }])];
    assert.equal(lastAssistantText(entries), "real reply", "a tool-only turn must not blank the answer");
  });

  it("ignores non-message entries", () => {
    assert.equal(lastAssistantText([{ type: "summary", text: "x" }]), "");
  });
});
