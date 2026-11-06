/**
 * A tool call rejected for invalid arguments never runs: pi skips `tool_call`
 * and `tool_result` for it, so nothing told the model to retry and a turn could
 * end with the intended action silently not performed. The guard watches the
 * one event that always fires — `tool_execution_end` without `durationMs` — and
 * forces a follow-up turn.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isArgumentRejection, registerToolArgGuard, rejectionReason, resultText } from "../../../extensions/orchestrator/tool-arg-guard.js";

function fakePi() {
  const notes: Array<{ content: string; customType?: string }> = [];
  const options: any[] = [];
  const handlers: Record<string, Array<(event: any) => any>> = {};
  const pi: any = {
    on(name: string, handler: (event: any) => any) {
      (handlers[name] ??= []).push(handler);
    },
    async sendMessage(message: any, opts?: any) {
      notes.push(message);
      options.push(opts);
    },
  };
  return {
    pi,
    notes,
    options,
    fire: async (name: string, event: any) => {
      for (const h of handlers[name] ?? []) await h(event);
    },
  };
}

const validationError = {
  toolName: "bash",
  toolCallId: "call-1",
  isError: true,
  result: 'Validation failed for tool "bash":\n  - command: missing\n\nReceived arguments:\n{\n  "path": "/tmp/x"\n}',
  // durationMs absent → the tool never ran
};

describe("tool-arg-guard", () => {
  it("forces a retry when a call is rejected for invalid arguments", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", validationError);

    assert.equal(h.notes.length, 1, "one system note");
    assert.equal(h.notes[0].customType, "tool-arg-rejected");
    assert.match(h.notes[0].content, /bash/);
    assert.match(h.notes[0].content, /command: missing/);
    assert.match(h.notes[0].content, /Retry now/);
    assert.equal(h.options[0]?.triggerTurn, true, "must start a turn so the agent retries");
  });

  it("says the intended action did not happen", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", validationError);
    assert.match(h.notes[0].content, /did NOT execute/);
  });

  it("stays quiet when the tool ran and failed — other hooks own that", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", {
      toolName: "bash",
      isError: true,
      durationMs: 42,
      result: "Error: exit code 1",
    });
    assert.equal(h.notes.length, 0);
  });

  it("stays quiet for a policy block that never ran (our own block message)", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", {
      toolName: "bash",
      isError: true,
      result: "⛔ Remote script execution is forbidden. Download the script first.",
    });
    assert.equal(h.notes.length, 0);
  });

  it("stays quiet on success", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", { toolName: "bash", isError: false, durationMs: 5, result: "ok" });
    assert.equal(h.notes.length, 0);
  });
});

describe("tool-arg-guard helpers", () => {
  it("resultText flattens strings, part arrays and objects", () => {
    assert.equal(resultText("plain"), "plain");
    assert.equal(resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
    assert.equal(resultText({ text: "obj" }), "obj");
    assert.equal(resultText(null), "");
  });

  it("isArgumentRejection keys on pi's wording, not on durationMs", () => {
    assert.equal(isArgumentRejection(true, 'Validation failed for tool "bash":\n  - command: missing'), true);
    assert.equal(isArgumentRejection(true, "Unknown tool: nope"), true);
    assert.equal(isArgumentRejection(false, 'Validation failed for tool "bash":'), false);
    assert.equal(isArgumentRejection(true, "⛔ Remote script execution is forbidden"), false);
  });

  it("detects a bash rejection that still carries durationMs", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", {
      toolName: "bash",
      isError: true,
      durationMs: 0,
      result: { content: [{ type: "text", text: 'Validation failed for tool "bash":\n  - command: missing' }], details: {} },
    });
    assert.equal(h.notes.length, 1, "a rejection must be caught even when durationMs is present");
    assert.match(h.notes[0].content, /command: missing/, "the note carries the plain text, not JSON");
  });
});


describe("tool-arg-guard hardening", () => {
  it("ignores an executed tool that merely prints the rejection phrase", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", {
      toolName: "bash",
      isError: true,
      durationMs: 120,
      result: { content: [{ type: "text", text: "cat: foo: No such file\nUnknown tool: was printed by the command I ran" }] },
    });
    assert.equal(h.notes.length, 0, "executed output must never be treated as a rejection");
  });

  it("never leaks received argument values into the note", async () => {
    const h = fakePi();
    registerToolArgGuard(h.pi);
    await h.fire("tool_execution_end", {
      toolName: "bash",
      isError: true,
      result: 'Validation failed for tool "bash":\n  - command: missing\n\nReceived arguments:\n{\n  "path": "/tmp/x",\n  "token": "ghp_SECRETVALUE"\n}',
    });
    assert.equal(h.notes.length, 1);
    assert.doesNotMatch(h.notes[0].content, /ghp_SECRETVALUE/, "credential must not reach the model");
    assert.doesNotMatch(h.notes[0].content, /Received arguments/, "raw argument block must be dropped");
    assert.match(h.notes[0].content, /command: missing/, "the parameter diagnostic is kept");
  });

  it("rejectionReason keeps diagnostics and drops the argument block", () => {
    const text = 'Validation failed for tool "bash":\n  - command: missing\n\nReceived arguments:\n{"path":"/tmp/x"}';
    const reason = rejectionReason(text);
    assert.match(reason, /command: missing/);
    assert.doesNotMatch(reason, /tmp\/x/);
  });

  it("does not fire when the phrase appears mid-text of a failed run", () => {
    assert.equal(isArgumentRejection(true, "some log\nValidation failed for tool \"x\":"), false);
    assert.equal(isArgumentRejection(true, 'Validation failed for tool "x":\n  - a: missing'), true);
  });
});
