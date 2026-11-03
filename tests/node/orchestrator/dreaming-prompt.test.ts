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
});
