import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelOverride, mergeModelOverride } from "../../../extensions/orchestrator/parse-model-override.js";

describe("parseModelOverride", () => {
  it("returns undefined for undefined input", () => {
    assert.strictEqual(parseModelOverride(undefined), undefined);
  });

  it("returns undefined for empty string", () => {
    assert.strictEqual(parseModelOverride(""), undefined);
  });

  it("returns model only for plain model id", () => {
    const result = parseModelOverride("claude-opus-4");
    assert.deepStrictEqual(result, { model: "claude-opus-4" });
  });

  it("splits provider/model on first slash", () => {
    const result = parseModelOverride("litellm/claude-opus-4");
    assert.deepStrictEqual(result, { provider: "litellm", model: "claude-opus-4" });
  });

  it("handles model ids with multiple slashes (splits on first)", () => {
    const result = parseModelOverride("litellm/org/model-name");
    assert.deepStrictEqual(result, { provider: "litellm", model: "org/model-name" });
  });

  it("treats leading slash as model only (slashIdx === 0)", () => {
    const result = parseModelOverride("/model");
    assert.deepStrictEqual(result, { model: "/model" });
  });
});

describe("mergeModelOverride", () => {
  it("returns explicit when task model is undefined", () => {
    const explicit = { model: "claude", provider: "litellm" };
    assert.deepStrictEqual(mergeModelOverride(undefined, explicit), explicit);
  });

  it("returns undefined when both are undefined", () => {
    assert.strictEqual(mergeModelOverride(undefined, undefined), undefined);
  });

  it("task model overrides explicit model, keeps explicit provider", () => {
    const explicit = { model: "claude", provider: "litellm" };
    const result = mergeModelOverride("gpt-5", explicit);
    assert.deepStrictEqual(result, { model: "gpt-5", provider: "litellm" });
  });

  it("task provider/model overrides both", () => {
    const explicit = { model: "claude", provider: "litellm" };
    const result = mergeModelOverride("openai/gpt-5", explicit);
    assert.deepStrictEqual(result, { model: "gpt-5", provider: "openai" });
  });

  it("task model only, no explicit", () => {
    const result = mergeModelOverride("gpt-5", undefined);
    assert.deepStrictEqual(result, { model: "gpt-5", provider: undefined });
  });
});
