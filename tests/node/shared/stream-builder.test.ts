/**
 * Unit tests for StreamAssembler — maps DriverStreamEvents into pi stream events.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  StreamAssembler,
  createAssistantMessageOutput,
} from "../../../extensions/shared/stream-builder.js";

function createMockStream() {
  const events: any[] = [];
  let ended = false;
  return {
    events,
    get ended() {
      return ended;
    },
    push(event: any) {
      events.push(event);
    },
    end() {
      ended = true;
    },
  };
}

function createAssembler() {
  const output = createAssistantMessageOutput({
    api: "cli",
    provider: "cli-test",
    id: "test-model",
  });
  const stream = createMockStream();
  const assembler = new StreamAssembler(output as any, stream as any);
  return { assembler, output, stream };
}

describe("StreamAssembler", () => {
  it("handleEvent with thinking_delta events (start, delta, end)", () => {
    const { assembler, output, stream } = createAssembler();

    assembler.handleEvent({ kind: "thinking_delta", text: "think" });
    assert.equal(stream.events[0].type, "thinking_start");
    assert.equal(stream.events[0].contentIndex, 0);
    assert.equal(stream.events[1].type, "thinking_delta");
    assert.equal(stream.events[1].delta, "think");
    assert.equal((output.content[0] as any).thinking, "think");

    assembler.handleEvent({ kind: "thinking_delta", text: " more" });
    assert.equal(stream.events[2].type, "thinking_delta");
    assert.equal(stream.events[2].delta, " more");
    assert.equal((output.content[0] as any).thinking, "think more");

    // First text_delta closes the thinking block
    assembler.handleEvent({ kind: "text_delta", text: "hi" });
    assert.equal(stream.events[3].type, "thinking_end");
    assert.equal(stream.events[3].content, "think more");
  });

  it("handleEvent with text_delta events (start, delta, end)", () => {
    const { assembler, output, stream } = createAssembler();

    assembler.handleEvent({ kind: "text_delta", text: "Hel" });
    assert.equal(stream.events[0].type, "text_start");
    assert.equal(stream.events[0].contentIndex, 0);
    assert.equal(stream.events[1].type, "text_delta");
    assert.equal(stream.events[1].delta, "Hel");
    assert.equal((output.content[0] as any).text, "Hel");

    assembler.handleEvent({ kind: "text_delta", text: "lo" });
    assert.equal(stream.events[2].type, "text_delta");
    assert.equal(stream.events[2].delta, "lo");
    assert.equal((output.content[0] as any).text, "Hello");

    assembler.finalize();
    const textEnd = stream.events.find((e) => e.type === "text_end");
    assert.ok(textEnd);
    assert.equal(textEnd.content, "Hello");
  });

  it("finalize with finalText, finalThinking, usage, stopReason", () => {
    const { assembler, output, stream } = createAssembler();

    // Empty thinking block so finalize can apply authoritative finalThinking
    assembler.handleEvent({ kind: "thinking_delta", text: "" });
    assembler.finalize({
      finalText: "final answer",
      finalThinking: "deep thought",
      stopReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 2,
        cachedWriteTokens: 1,
        totalTokens: 15,
        costUsd: 0.01,
      },
    });

    assert.equal((output.content[0] as any).type, "thinking");
    assert.equal((output.content[0] as any).thinking, "deep thought");
    assert.equal((output.content[1] as any).type, "text");
    assert.equal((output.content[1] as any).text, "final answer");
    assert.equal(output.usage.input, 10);
    assert.equal(output.usage.output, 5);
    assert.equal(output.usage.cacheRead, 2);
    assert.equal(output.usage.cacheWrite, 1);
    assert.equal(output.usage.totalTokens, 15);
    assert.equal(output.usage.cost.total, 0.01);
    assert.equal(output.stopReason, "stop");

    const done = stream.events.find((e) => e.type === "done");
    assert.ok(done);
    assert.equal(done.reason, "stop");
    assert.equal(stream.ended, true);
  });

  it('finalize with stopReason "aborted" → done event reason is "aborted"', () => {
    const { assembler, output, stream } = createAssembler();

    assembler.handleEvent({ kind: "text_delta", text: "partial" });
    assembler.finalize({ stopReason: "aborted" });

    assert.equal(output.stopReason, "aborted");
    const done = stream.events.find((e) => e.type === "done");
    assert.ok(done);
    assert.equal(done.reason, "aborted");
    assert.equal(stream.ended, true);
  });

  it("emitError aborted vs non-aborted", () => {
    const aborted = createAssembler();
    aborted.assembler.emitError(new Error("cancelled"), true);
    assert.equal(aborted.output.stopReason, "aborted");
    assert.equal(aborted.output.errorMessage, "cancelled");
    assert.equal(aborted.stream.events[0].type, "error");
    assert.equal(aborted.stream.events[0].reason, "aborted");
    assert.equal(aborted.stream.ended, true);

    const errored = createAssembler();
    errored.assembler.emitError("boom", false);
    assert.equal(errored.output.stopReason, "error");
    assert.equal(errored.output.errorMessage, "boom");
    assert.equal(errored.stream.events[0].type, "error");
    assert.equal(errored.stream.events[0].reason, "error");
    assert.equal(errored.stream.ended, true);
  });

  it("event ordering: start → thinking → text → done", () => {
    const { assembler, stream } = createAssembler();

    assembler.handleEvent({ kind: "thinking_delta", text: "reason" });
    assembler.handleEvent({ kind: "text_delta", text: "answer" });
    assembler.finalize({ stopReason: "stop" });

    const types = stream.events.map((e) => e.type);
    assert.deepEqual(types, [
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    assert.equal(stream.ended, true);
  });
});
