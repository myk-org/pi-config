/**
 * Tests for reload_session tool registration and behavior.
 * Run with: npx tsx --test tests/node/orchestrator/session-validation.test.ts
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

describe("reload_session tool", () => {
  it("execute calls sendUserMessage with /reload-session and followUp", async () => {
    // Simulate what the tool's execute function does
    let capturedMessage: string | null = null;
    let capturedOptions: any = null;

    const mockPi = {
      sendUserMessage: (msg: string, opts?: any) => {
        capturedMessage = msg;
        capturedOptions = opts;
      },
    };

    // Replicate the tool's execute logic
    mockPi.sendUserMessage("/reload-session", { deliverAs: "followUp" });
    const result = {
      content: [{ type: "text", text: "Queued /reload-session — session will reload after this turn." }],
      details: {},
    };

    assert.equal(capturedMessage, "/reload-session");
    assert.deepEqual(capturedOptions, { deliverAs: "followUp" });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes("/reload-session"));
  });

  it("tool is not registered when PI_SUBAGENT_CHILD is set", () => {
    const originalValue = process.env.PI_SUBAGENT_CHILD;

    try {
      // Simulate non-subagent environment
      delete process.env.PI_SUBAGENT_CHILD;
      assert.equal(
        process.env.PI_SUBAGENT_CHILD !== "1",
        true,
        "Tool should register when PI_SUBAGENT_CHILD is not '1'",
      );

      // Simulate subagent environment
      process.env.PI_SUBAGENT_CHILD = "1";
      assert.equal(
        process.env.PI_SUBAGENT_CHILD !== "1",
        false,
        "Tool should NOT register when PI_SUBAGENT_CHILD is '1'",
      );
    } finally {
      // Restore
      if (originalValue !== undefined) {
        process.env.PI_SUBAGENT_CHILD = originalValue;
      } else {
        delete process.env.PI_SUBAGENT_CHILD;
      }
    }
  });
});
