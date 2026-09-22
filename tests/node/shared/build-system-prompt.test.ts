/**
 * Tests for buildExternalSystemPrompt.
 * Run with: npx tsx --test tests/node/shared/build-system-prompt.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildExternalSystemPrompt } from "../../../extensions/shared/build-system-prompt.js";

describe("buildExternalSystemPrompt", () => {
  it("uses the system prompt from a normalized transcript", () => {
    const context = {
      messages: [{ role: "system", content: "Use transcript state", timestamp: 1 }],
    } as TranscriptContext;

    assert.match(buildExternalSystemPrompt(context)!, /Use transcript state/);
  });

  it("uses a mid-conversation system prompt update", () => {
    const context = {
      messages: [
        { role: "system", content: "Initial instructions", timestamp: 1 },
        { role: "user", content: "Continue", timestamp: 2 },
        { role: "system", content: "Updated instructions", timestamp: 3 },
      ],
    } as TranscriptContext;

    const result = buildExternalSystemPrompt(context);

    assert.match(result!, /Initial instructions[\s\S]*Updated instructions/);
  });

  it("returns undefined when no systemPrompt", () => {
    assert.equal(buildExternalSystemPrompt({ messages: [] } as TranscriptContext), undefined);
  });

  it("wraps systemPrompt with pi header", () => {
    const result = buildExternalSystemPrompt({
      messages: [{ role: "system", content: "Do stuff", timestamp: 1 }],
    } as TranscriptContext);
    assert.ok(result);
    assert.ok(result.includes("You are being used as a backend LLM through pi coding agent"));
    assert.ok(result.includes("Do stuff"));
  });

  it("includes systemPrompt content verbatim", () => {
    const prompt = "Rule 1: never delete files\nRule 2: always test";
    const result = buildExternalSystemPrompt({
      messages: [{ role: "system", content: prompt, timestamp: 1 }],
    } as TranscriptContext);
    assert.ok(result);
    assert.ok(result.includes("Rule 1: never delete files"));
    assert.ok(result.includes("Rule 2: always test"));
  });

  it("works without cwd (no enforcement injection)", () => {
    const result = buildExternalSystemPrompt({
      messages: [{ role: "system", content: "Hello", timestamp: 1 }],
    } as TranscriptContext);
    assert.ok(result);
    assert.ok(!result.includes("Enforced Rules"));
  });

  it("works with cwd that has no enforced entries", () => {
    // Use a temp dir guaranteed to have no .pi/memory
    const tmpDir = mkdtempSync(join(tmpdir(), "build-prompt-test-"));
    try {
      const result = buildExternalSystemPrompt({
        messages: [{ role: "system", content: "Hello", timestamp: 1 }],
      } as TranscriptContext, tmpDir);
      assert.ok(result);
      // Should not crash, should not include enforced rules section
      assert.ok(!result.includes("Enforced Rules"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
