import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supportsReasoning, THINKING_LEVELS } from "../../../extensions/pidash/pidash-ui/src/lib/model-capabilities.ts";
import { pidashModelInfo } from "../../../extensions/pidash/model-info.ts";

describe("pidash model capabilities", () => {
  it("shows thinking only for an explicitly reasoning-capable active model", () => {
    assert.equal(supportsReasoning({ reasoning: true }), true);
    assert.equal(supportsReasoning({ reasoning: false }), false);
    assert.equal(supportsReasoning({}), false);
  });

  it("publishes explicit reasoning capability for native model selection in both directions", () => {
    assert.deepEqual(pidashModelInfo({ name: "Reasoner", contextWindow: 10, reasoning: true }), { model: "Reasoner", contextWindow: 10, reasoning: true });
    assert.deepEqual(pidashModelInfo({ id: "plain", reasoning: false }), { model: "plain", contextWindow: 0, reasoning: false });
  });

  it("offers every persisted thinking level and retains xhigh and max as current values", () => {
    assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(THINKING_LEVELS.includes("xhigh"), true);
    assert.equal(THINKING_LEVELS.includes("max"), true);
  });
});
