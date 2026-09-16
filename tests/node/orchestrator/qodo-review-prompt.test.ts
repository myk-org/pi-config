import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { qodoReviewArgumentCompletions } from "../../../extensions/orchestrator/extended-autocomplete.js";

const prompt = readFileSync(new URL("../../../prompts/qodo-review.md", import.meta.url), "utf8");

describe("qodo-review prompt", () => {
  it("keeps the bug-report policy immediately after raw arguments", () => {
    assert.match(prompt, /## Raw Arguments\n\n```text\n\$ARGUMENTS\n```\n\n> \*\*Bug Reporting Policy:/);
  });

  it("documents the safe prerequisite stop", () => {
    assert.match(prompt, /curl -fsSL https:\/\/get\.qodo\.ai \| sh/);
    assert.match(prompt, /NEVER execute it/);
    assert.match(prompt, /run `qodo` to finish setup, then rerun `\/qodo-review`/);
  });

  it("documents review authority boundaries", () => {
    assert.match(prompt, /call\n  `ask_user` once/);
    assert.match(prompt, /`--autofix`: skip `ask_user` and fix every finding/);
    assert.match(prompt, /Tests are mandatory and every test must pass/);
    assert.match(prompt, /Never commit, push, create a PR/);
  });
});

describe("qodo-review autocomplete", () => {
  it("offers all constrained flags", () => {
    assert.deepEqual(
      qodoReviewArgumentCompletions("")?.map(({ label }) => label),
      ["--autofix", "--fast", "--deep", "--ticket"],
    );
  });

  it("enforces exclusive depth suggestions", () => {
    assert.deepEqual(
      qodoReviewArgumentCompletions("--fast ")?.map(({ label }) => label),
      ["--autofix", "--ticket"],
    );
  });

  it("does not complete a free-text ticket URL", () => {
    assert.equal(qodoReviewArgumentCompletions("--ticket "), null);
    assert.equal(qodoReviewArgumentCompletions("--ticket https://example.test/T-1"), null);
  });
});
