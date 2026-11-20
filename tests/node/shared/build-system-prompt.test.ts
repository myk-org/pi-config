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
import { buildExternalSystemPrompt, createEmptyTranscriptContext, messageText } from "../../../extensions/shared/build-system-prompt.js";
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

  it("preserves enforced triggers/commands when only entry text is in project_memory and skips exact duplicates (#1242)", () => {
    const tmpDir = makeTempDir("build-prompt-dedup-");
    const now = new Date().toISOString();
    const ruleAlreadyInMemoryText = "never use git add dot";
    const runAfterText = "run typecheck after ts edit";
    const lineA = `- [lesson] ${ruleAlreadyInMemoryText}`;
    const lineB = `- [lesson] ${runAfterText}`;
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

      // Entry text in <project_memory> lacks trigger/action/command — both rules MUST remain injected
      const withMemoryTextOnly = buildExternalSystemPrompt({
        messages: [{
          role: "system",
          content: `<project_memory>\n- [lesson] ${ruleAlreadyInMemoryText}\n- [lesson] ${runAfterText}\n</project_memory>`,
          timestamp: 1,
        }],
      } as TranscriptContext, tmpDir)!;
      assert.ok(withMemoryTextOnly.includes("## Enforced Rules (MANDATORY)"));
      assert.ok(withMemoryTextOnly.includes(`- NEVER: git add . — ${ruleAlreadyInMemoryText}`));
      assert.ok(withMemoryTextOnly.includes("- AFTER `*.ts`, run: `npm run typecheck`"));

      // Exact rendered rule lines already in systemPrompt are skipped; when all match, section is omitted
      const exactBlockLine = `- NEVER: git add . — ${ruleAlreadyInMemoryText}`;
      const exactAfterLine = "- AFTER `*.ts`, run: `npm run typecheck`";
      const partialDedup = buildExternalSystemPrompt({
        messages: [{ role: "system", content: exactBlockLine, timestamp: 1 }],
      } as TranscriptContext, tmpDir)!;
      assert.ok(partialDedup.includes("## Enforced Rules (MANDATORY)"));
      assert.ok(!partialDedup.includes(`\n${exactBlockLine}`, partialDedup.indexOf("## Enforced Rules (MANDATORY)")));
      assert.ok(partialDedup.includes(exactAfterLine));

      const fullDedup = buildExternalSystemPrompt({
        messages: [{ role: "system", content: `${exactBlockLine}\n${exactAfterLine}`, timestamp: 1 }],
      } as TranscriptContext, tmpDir)!;
      assert.ok(!fullDedup.includes("## Enforced Rules (MANDATORY)"));
    } finally {
      clearEnforcementRulesCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("messageText", () => {
  it("extracts string, array text blocks (ignoring null/non-text), and returns empty string for non-array", () => {
    assert.equal(messageText({ role: "user", content: "plain string" }), "plain string");
    assert.equal(
      messageText({
        role: "assistant",
        content: [null, { type: "thinking", thinking: "ignored" }, { type: "text", text: "first" }, { type: "text", text: "second" }],
      }),
      "first\nsecond",
    );
    assert.equal(messageText({ role: "user", content: null }), "");
    assert.equal(messageText({ role: "user", content: 42 }), "");
  });
});
