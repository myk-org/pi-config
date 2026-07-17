/**
 * Tests for query-class classification.
 * Run with: npx tsx --test tests/node/orchestrator/memory-query-class.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyQueryClass,
  getQueryClassBias,
  sectionPriorityBoost,
} from "../../../extensions/orchestrator/memory-query-class.js";

describe("classifyQueryClass", () => {
  it("detects pr_review", () => {
    assert.equal(classifyQueryClass("Please review this PR"), "pr_review");
    assert.equal(classifyQueryClass("gh pr create"), "pr_review");
  });

  it("detects git_release", () => {
    assert.equal(classifyQueryClass("git commit and push"), "git_release");
    assert.equal(classifyQueryClass("prepare the release"), "git_release");
  });

  it("detects debug", () => {
    assert.equal(classifyQueryClass("fix this stack trace error"), "debug");
    assert.equal(classifyQueryClass("the build failed"), "debug");
  });

  it("defaults to general", () => {
    assert.equal(classifyQueryClass("add a button to the form"), "general");
    assert.equal(classifyQueryClass(""), "general");
  });
});

describe("sectionPriorityBoost", () => {
  it("boosts mistakes for debug class below unboosted preferences", () => {
    const mistakes = sectionPriorityBoost("Vetoes & Mistakes", 3, "debug");
    const prefs = sectionPriorityBoost("Active Preferences", 1, "debug");
    assert.ok(mistakes < prefs);
  });

  it("leaves general unchanged", () => {
    assert.equal(
      sectionPriorityBoost("Active Lessons", 2, "general"),
      2,
    );
  });
});

describe("getQueryClassBias", () => {
  it("raises vectorTopK for pr_review", () => {
    assert.ok(getQueryClassBias("pr_review").vectorTopK > getQueryClassBias("general").vectorTopK);
  });
});
