import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDreamPrompt } from "../../../extensions/orchestrator/dreaming.js";

const topicsDir = "/repo/.pi/memory/topics";
const prompt = buildDreamPrompt(undefined, topicsDir);

describe("dream prompt", () => {
  it("narrows [done] to non-derivable outcome knowledge", () => {
    assert.ok(prompt.includes("ONLY non-derivable outcome knowledge"));
    assert.ok(prompt.includes("NEVER store a PR/issue number list"));
  });

  it("stops extracting merged-PR lists", () => {
    assert.ok(!prompt.includes("Completed features/PRs merged"));
  });

  it("prunes git/GitHub/Jira history from topic files", () => {
    assert.ok(prompt.includes("Remove entries that restate git/GitHub/Jira history"));
  });

  it("keeps the pinned and enforced guards verbatim", () => {
    assert.ok(prompt.includes("NEVER remove or modify entries marked with *(pinned)*"));
    assert.ok(prompt.includes("NEVER remove or modify entries marked with *(enforced)*"));
  });

  it("interpolates the topics dir and the session file", () => {
    assert.ok(prompt.includes(`Topics directory: ${topicsDir}`));
    assert.ok(prompt.includes(`Read all existing topic files in ${topicsDir}/`));
    assert.ok(prompt.includes("Session file: none"));
    assert.ok(buildDreamPrompt("/sessions/abc.jsonl", topicsDir).includes(
      "Session file: /sessions/abc.jsonl",
    ));
  });

  it("deduplicates shared constraint rules into one top-level Rules block (#1268)", () => {
    assert.ok(prompt.includes("Rules (apply to all steps):"));
    assert.ok(prompt.length < 5000, `expected compact prompt (<5000 chars), got ${prompt.length}`);
    // Immutability rules stated once instead of repeated across steps
    assert.equal(prompt.split("*(pinned)*").length - 1, 3, "pinned mentioned in Rules + Step 6 format only");
    assert.ok(prompt.includes("skill-maintenance: auto"));
    assert.ok(prompt.includes("NEVER write rules/ or .pi/rules/"));
  });
});
