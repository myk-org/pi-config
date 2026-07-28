/**
 * Tests for buildExternalSystemPrompt.
 * Run with: npx tsx --test tests/node/shared/build-system-prompt.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildExternalSystemPrompt } from "../../../extensions/shared/build-system-prompt.js";

describe("buildExternalSystemPrompt", () => {
  it("returns undefined when no systemPrompt", () => {
    assert.equal(buildExternalSystemPrompt({}), undefined);
    assert.equal(buildExternalSystemPrompt({ systemPrompt: undefined }), undefined);
  });

  it("wraps systemPrompt with pi header", () => {
    const result = buildExternalSystemPrompt({ systemPrompt: "Do stuff" });
    assert.ok(result);
    assert.ok(result.includes("You are being used as a backend LLM through pi coding agent"));
    assert.ok(result.includes("Do stuff"));
  });

  it("includes systemPrompt content verbatim", () => {
    const prompt = "Rule 1: never delete files\nRule 2: always test";
    const result = buildExternalSystemPrompt({ systemPrompt: prompt });
    assert.ok(result);
    assert.ok(result.includes("Rule 1: never delete files"));
    assert.ok(result.includes("Rule 2: always test"));
  });

  it("works without cwd (no enforcement injection)", () => {
    const result = buildExternalSystemPrompt({ systemPrompt: "Hello" });
    assert.ok(result);
    assert.ok(!result.includes("Enforced Rules"));
  });

  it("works with cwd that has no enforced entries", () => {
    // Use a temp dir guaranteed to have no .pi/memory
    const tmpDir = mkdtempSync(join(tmpdir(), "build-prompt-test-"));
    try {
      const result = buildExternalSystemPrompt({ systemPrompt: "Hello" }, tmpDir);
      assert.ok(result);
      // Should not crash, should not include enforced rules section
      assert.ok(!result.includes("Enforced Rules"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
