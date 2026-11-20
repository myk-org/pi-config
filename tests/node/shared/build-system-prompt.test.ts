/**
 * Tests for buildExternalSystemPrompt.
 * Run with: npx tsx --test tests/node/shared/build-system-prompt.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { entryHash } from "../../../extensions/orchestrator/memory-scoring.js";
import { clearEnforcementRulesCache } from "../../../extensions/orchestrator/enforcement-rules.js";
import { buildExternalSystemPrompt, createEmptyTranscriptContext } from "../../../extensions/shared/build-system-prompt.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


describe("buildExternalSystemPrompt", () => {
  it("creates an empty transcript context", () => {
    assert.deepEqual(createEmptyTranscriptContext(), { messages: [] });
  });

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
    assert.equal(buildExternalSystemPrompt({ messages: [] } as unknown as TranscriptContext), undefined);
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
    const tmpDir = makeTempDir("build-prompt-test-");
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

  it("skips enforced rules already present verbatim in systemPrompt (#1242)", () => {
    const tmpDir = makeTempDir("build-prompt-dedup-");
    const now = new Date().toISOString();
    const ruleAlreadyInPrompt = "never use git add dot";
    const ruleMissingFromPrompt = "run typecheck after ts edit";
    const lineA = `- [lesson] ${ruleAlreadyInPrompt}`;
    const lineB = `- [lesson] ${ruleMissingFromPrompt}`;
    try {
      mkdirSync(join(tmpDir, ".pi", "memory", "topics"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".pi", "memory", "memory-scores.jsonl"),
        JSON.stringify({
          entries: {
            [entryHash(lineA)]: {
              class: "lesson",
              score: 1.0,
              evidenceCount: 1,
              cue: "explicit",
              firstSeen: now,
              lastReinforced: now,
              userState: "auto",
              lifecycle: "active",
              trigger: "bash_contains git add .",
              action: "block",
            },
            [entryHash(lineB)]: {
              class: "lesson",
              score: 1.0,
              evidenceCount: 1,
              cue: "explicit",
              firstSeen: now,
              lastReinforced: now,
              userState: "auto",
              lifecycle: "active",
              trigger: "file_modified *.ts",
              action: "run_after npm run typecheck",
            },
          },
          lastRebuild: now,
        }) + "\n",
      );
      writeFileSync(
        join(tmpDir, ".pi", "memory", "topics", "lessons.md"),
        `# Lessons\n${lineA}\n${lineB}\n`,
      );
      clearEnforcementRulesCache();

      // When only ruleAlreadyInPrompt is in systemPrompt, only ruleMissingFromPrompt is appended
      const partial = buildExternalSystemPrompt({
        messages: [{ role: "system", content: `<project_memory>\n${ruleAlreadyInPrompt}\n</project_memory>`, timestamp: 1 }],
      } as TranscriptContext, tmpDir)!;
      assert.ok(partial.includes("## Enforced Rules (MANDATORY)"));
      assert.ok(!partial.includes("bash_contains git add .") && !partial.includes("- NEVER: git add ."));
      assert.ok(partial.includes(ruleMissingFromPrompt) || partial.includes("npm run typecheck"));

      // When BOTH rules are already in systemPrompt, the Enforced Rules section is omitted entirely
      const full = buildExternalSystemPrompt({
        messages: [{ role: "system", content: `<project_memory>\n${ruleAlreadyInPrompt}\n${ruleMissingFromPrompt}\n</project_memory>`, timestamp: 1 }],
      } as TranscriptContext, tmpDir)!;
      assert.ok(!full.includes("## Enforced Rules (MANDATORY)"));
    } finally {
      clearEnforcementRulesCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
