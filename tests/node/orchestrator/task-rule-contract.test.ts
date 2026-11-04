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
    // Literal phrases: `includes` has no escaping traps, unlike a regex.
    for (const phrase of [
      "2+ distinct actions",
      "more than one file to change",
      "05-issue-first-workflow.md",
      "20-code-review-loop.md",
    ]) {
      assert.ok(taskRule.includes(phrase), phrase);
    }
  });

  it("keeps single-step work exempt", () => {
    assert.ok(taskRule.includes("one-file/one-line change"));
    assert.ok(taskRule.includes("read-only investigation"));
  });

  it("resolves the tool-description conflict in the rule's favour", () => {
    assert.ok(taskRule.includes("this rule wins"), "the rule must claim precedence");
    assert.ok(
      taskRule.includes("one bulk call for the whole job"),
      "the override must still name the bulk call",
    );
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

  it("requires tasks for work an async result sets in motion (#1016)", () => {
    assert.ok(taskRule.includes("or work any step sets in motion"), "the trigger cannot be request-shaped only");
    assert.ok(taskRule.includes("an async result comes back with follow-up work"));
    assert.ok(coreRule.includes("set in motion by an async result"), "the injected summary must agree");
  });

  it("restricts taskId -1 to read-only one-offs (#1016)", () => {
    assert.match(taskRule, /`"-1"` is only for a single read-only\s+check/, "the exception must be narrow");
    assert.match(taskRule, /must carry a real\s+task id/);
    assert.doesNotMatch(taskRule, /"-1" when not/, "the blanket exception is the loophole this closes");
  });

  it("documents multi-issue stage granularity (#1016)", () => {
    assert.ok(taskRule.includes("one task per **stage** per issue"));
    assert.ok(taskRule.includes("`#<n>: <stage>`"));
    assert.ok(taskRule.includes("addBlockedBy"));
  });

  it("requires a result-to-board step (#1016)", () => {
    assert.ok(taskRule.includes("When an async result arrives, update the board in that same turn"));
  });

  it("keeps a failed agent from completing its task (#1016)", () => {
    assert.match(taskRule, /A\s+failed agent keeps its task open/);
    assert.match(taskRule, /on success complete the\s+owning task/, "completion must be success-gated");
  });

  it("requires TaskList-derived status (#1016)", () => {
    assert.ok(taskRule.includes("Status reports come from `TaskList`, not recollection"));
  });

  it("marks reconciliation mandatory (#1016)", () => {
    assert.match(taskRule, /Before dispatching new work, reconcile the board \(MANDATORY\)/);
  });

  it("names blockedBy for bulk-created stages (#1016)", () => {
    assert.ok(taskRule.includes("Later stages carry `blockedBy` in the bulk create"));
  });

  it("scopes auto-complete so a narrow agent task cannot close a stage (#1016)", () => {
    assert.ok(taskRule.includes("Stage tasks are yours to close"));
    assert.ok(taskRule.includes("**NEVER** let a narrow agent task stand in for a stage"));
    assert.doesNotMatch(taskRule, /Linked tasks auto-complete on agent success/, "that sentence let a poll close a stage");
  });

  it("requires board reconciliation before new dispatch (#1016)", () => {
    assert.ok(taskRule.includes("Before dispatching new work, reconcile the board"));
  });
});
