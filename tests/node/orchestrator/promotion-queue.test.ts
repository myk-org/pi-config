/**
 * Tests for promotion-queue parser/formatter.
 * Run with: npx tsx --test tests/node/orchestrator/promotion-queue.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendPromotions,
  formatPromotionBlock,
  formatPromotionsForReport,
  loadPromotions,
  parsePromotionsMarkdown,
  promotionId,
  updatePromotionCandidates,
  updatePromotionStatus,
  type PromotionCandidate,
} from "../../../extensions/orchestrator/promotion-queue.js";

function makeCandidate(
  overrides: Partial<PromotionCandidate> = {},
): PromotionCandidate {
  const text = overrides.text ?? "Never use git add .";
  const category = overrides.category ?? "lesson";
  const destination = overrides.destination ?? "enforcement";
  return {
    id: overrides.id ?? promotionId(destination, category, text),
    destination,
    status: overrides.status ?? "proposed",
    category,
    text,
    reason: overrides.reason ?? "test reason",
    createdAt: overrides.createdAt ?? "2026-07-17T00:00:00.000Z",
    evidenceCount: overrides.evidenceCount,
    trigger: overrides.trigger,
    action: overrides.action,
    verifier: overrides.verifier,
    skillName: overrides.skillName,
    skillCreated: overrides.skillCreated,
  };
}

describe("promotionId", () => {
  it("is stable for the same inputs", () => {
    assert.equal(
      promotionId("enforcement", "lesson", "Never use git add ."),
      promotionId("enforcement", "lesson", "Never use git add ."),
    );
  });

  it("differs across destinations", () => {
    assert.notEqual(
      promotionId("enforcement", "lesson", "x"),
      promotionId("skill", "lesson", "x"),
    );
  });
});

describe("format/parse round-trip", () => {
  it("round-trips a full candidate block", () => {
    const c = makeCandidate({
      trigger: "bash_contains git add .",
      action: "block",
      evidenceCount: 3,
      skillName: "unused",
      skillCreated: false,
    });
    const md = "# Memory Promotion Queue\n\n" + formatPromotionBlock(c);
    const parsed = parsePromotionsMarkdown(md);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], c);
  });

  it("skips malformed blocks", () => {
    const md = "### abc\n- destination: nope\n- status: proposed\n";
    assert.equal(parsePromotionsMarkdown(md).length, 0);
  });
});

describe("appendPromotions with updatePromotionStatus", () => {
  it("dedups by id then updates status", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "promo-q-"));
    try {
      const a = makeCandidate();
      const b = makeCandidate({ text: "Always ask_user before gh pr merge" });
      assert.equal(appendPromotions(cwd, [a, a, b]), 2);
      assert.equal(loadPromotions(cwd).length, 2);
      assert.equal(appendPromotions(cwd, [a]), 0);

      assert.equal(updatePromotionStatus(cwd, a.id, "applied"), true);
      const loaded = loadPromotions(cwd);
      assert.equal(loaded.find((x) => x.id === a.id)?.status, "applied");
      assert.equal(updatePromotionStatus(cwd, "missing", "rejected"), false);

      const report = formatPromotionsForReport(cwd, 5);
      assert.match(report, /Promotion Candidates/);
      assert.match(report, /Always ask_user/);
      assert.doesNotMatch(report, /Never use git add/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("updatePromotionCandidates", () => {
  it("ignores immutable identity fields in patches", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "promo-patch-"));
    try {
      const a = makeCandidate({
        createdAt: "2026-07-01T00:00:00.000Z",
        reason: "original",
      });
      appendPromotions(cwd, [a]);
      updatePromotionCandidates(cwd, [
        {
          id: a.id,
          patch: {
            status: "applied",
            reason: "updated",
            // @ts-expect-error identity fields must be ignored at runtime
            id: "mutated-id",
            // @ts-expect-error
            createdAt: "2099-01-01T00:00:00.000Z",
            // @ts-expect-error
            destination: "discard",
          },
        },
      ]);
      const loaded = loadPromotions(cwd);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]!.id, a.id);
      assert.equal(loaded[0]!.status, "applied");
      assert.equal(loaded[0]!.reason, "updated");
      assert.equal(loaded[0]!.createdAt, "2026-07-01T00:00:00.000Z");
      assert.equal(loaded[0]!.destination, "enforcement");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
