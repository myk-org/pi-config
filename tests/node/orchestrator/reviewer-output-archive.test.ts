import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveReviewerOutput,
  cleanupReviewerOutputArchives,
} from "../../../extensions/orchestrator/reviewer-output-archive.js";

function mode(filePath: string): number {
  return lstatSync(filePath).mode & 0o777;
}

function archive(dir: string, name: string, bytes: number, ageMs = 0): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, "x".repeat(bytes), { mode: 0o644 });
  const time = new Date(Date.now() - ageMs);
  utimesSync(filePath, time, time);
  return filePath;
}

describe("reviewer output archives (issue #803)", () => {
  it("creates owner-only worker output and durable archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-output-"));
    const outputPath = join(dir, "output.log");
    const archivePath = join(dir, "reviewer-results", "job.json");
    writeFileSync(outputPath, "sensitive reviewer output", { mode: 0o644 });
    chmodSync(outputPath, 0o644);

    archiveReviewerOutput(outputPath, archivePath);

    assert.equal(mode(outputPath), 0o600);
    assert.equal(mode(archivePath), 0o600);
    assert.equal(readFileSync(archivePath, "utf8"), "sensitive reviewer output");
  });

  it("applies retention when a new archive is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-retention-"));
    const expired = archive(dir, "expired.json", 1, 8 * 24 * 60 * 60 * 1000);
    const outputPath = join(dir, "output.log");
    writeFileSync(outputPath, "current output", { mode: 0o600 });

    archiveReviewerOutput(outputPath, join(dir, "current.json"));

    assert.throws(() => lstatSync(expired));
    assert.equal(readFileSync(join(dir, "current.json"), "utf8"), "current output");
  });

  it("removes expired archives without following symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-retention-"));
    const outside = archive(dir, "outside.json", 1);
    const expired = archive(dir, "expired.json", 1, 2_000);
    const link = join(dir, "linked.json");
    symlinkSync(outside, link);

    cleanupReviewerOutputArchives(dir, { maxAgeMs: 1_000, maxFiles: 10, maxBytes: 100 });

    assert.throws(() => lstatSync(expired));
    assert.equal(readFileSync(outside, "utf8"), "x");
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  it("keeps newest archives within count and aggregate-size limits", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-retention-"));
    const oldest = archive(dir, "oldest.json", 4, 3_000);
    const middle = archive(dir, "middle.json", 4, 2_000);
    const newest = archive(dir, "newest.json", 4, 1_000);

    cleanupReviewerOutputArchives(dir, { maxAgeMs: 10_000, maxFiles: 2, maxBytes: 8 });

    assert.throws(() => lstatSync(oldest));
    assert.equal(readFileSync(middle, "utf8"), "xxxx");
    assert.equal(readFileSync(newest, "utf8"), "xxxx");
  });
});
