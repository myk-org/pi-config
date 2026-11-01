/**
 * Task-rule contract tests (issue #1003).
 * Run: npx tsx --test tests/node/orchestrator/task-rule-contract.test.ts
 *
 * The task rule is markdown, so nothing else guards its wording. The skipped-task
 * bug came from the rule saying "use tasks" as advice and never naming
 * `TaskBulkCreate`; these assertions fail if that contract is weakened again.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const taskRule = read("rules/60-task-tracking.md");
const coreRule = read("rules/00-orchestrator-core.md");

describe("task rule contract (#1003)", () => {
  it("makes one TaskBulkCreate the first action for multi-action work", () => {
    assert.match(taskRule, /Plan the whole job in \*\*one `TaskBulkCreate` call\*\*/);
    assert.match(taskRule, /not one `TaskCreate` per step/);
    assert.match(coreRule, /first action is one `TaskBulkCreate` listing every step/);
  });

  it("states the multi-action trigger", () => {
    assert.match(taskRule, /2\+ distinct actions/);
    assert.match(taskRule, /more than one file to change/);
    assert.match(taskRule, /05-issue-first-workflow\.md/);
    assert.match(taskRule, /20-code-review-loop\.md/);
  });

  it("keeps single-step work exempt", () => {
    assert.match(taskRule, /one-file\/one-line change/);
    assert.match(taskRule, /read-only investigation/);
  });

  it("keeps the taskId enforcement section, which really is code-enforced", () => {
    assert.match(taskRule, /^## Async Agent taskId \(MANDATORY — code-enforced\)$/m);
    assert.match(taskRule, /omit `taskId` — the call will fail/);
  });

  it("does not claim the rule itself is code-enforced by reminders", () => {
    // The old text said "Tasks are code-enforced (reminders after 4+ ignored
    // turns)"; those reminders only fire when tasks already exist.
    assert.doesNotMatch(taskRule, /code-enforced \(reminders/i);
    assert.doesNotMatch(taskRule, /ignored turns/i);
  });
});
