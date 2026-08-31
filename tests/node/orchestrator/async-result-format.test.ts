import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { formatAsyncResultOutput, reviewerOutputArchivePath } from "../../../extensions/orchestrator/async-result-format.js";

const outputPath = "/project/.pi/tmp/code-reviewer-docs-1/output.log";
const oversizedReviewerJson = JSON.stringify({
  findings: Array.from({ length: 100 }, (_, index) => ({
    file: `src/file-${index}.ts`, line: index + 1, description: "Sensitive finding detail ".repeat(10),
  })),
});

describe("formatAsyncResultOutput (issue #801)", () => {
  it("uses an opaque cleanup-safe archive path for reviewer output", () => {
    const jobId = "code-reviewer-docs-1";
    const digest = createHash("sha256").update(jobId).digest("hex");
    assert.equal(
      reviewerOutputArchivePath("/project/.pi/tmp", jobId),
      `/project/.pi/tmp/reviewer-results/${digest}.json`,
    );
  });

  it("contains traversal-shaped job identifiers below the archive root", () => {
    const archivePath = reviewerOutputArchivePath(
      "/project/.pi/tmp",
      "code-reviewer-x/../../../../target/file",
    );

    assert.match(archivePath, /^\/project\/\.pi\/tmp\/reviewer-results\/[a-f0-9]{64}\.json$/);
  });

  it("replaces oversized reviewer JSON with valid, content-free metadata", () => {
    const delivered = formatAsyncResultOutput("code-reviewer-docs", oversizedReviewerJson, outputPath);

    assert.ok(delivered.length <= 3000);
    assert.deepEqual(JSON.parse(delivered), {
      truncated: true,
      format: "json",
      outputBytes: Buffer.byteLength(oversizedReviewerJson, "utf8"),
      outputPath,
    });
    assert.ok(!delivered.includes("Sensitive finding detail"));
  });

  it("retains the existing bounded-text behavior for ordinary agents", () => {
    const output = "x".repeat(3001);
    assert.equal(formatAsyncResultOutput("test-runner", output, outputPath), output.slice(0, 3000));
  });

  it("delivers small reviewer JSON intact", () => {
    const output = JSON.stringify({ findings: [] });
    assert.equal(formatAsyncResultOutput("code-reviewer-docs", output, outputPath), output);
  });

  it("retains bounded text for schema-invalid reviewer JSON", () => {
    const output = JSON.stringify({ error: "diagnostic detail ".repeat(400) });
    assert.equal(formatAsyncResultOutput("code-reviewer-docs", output, outputPath), output.slice(0, 3000));
  });

  it("keeps reviewer metadata valid and within a custom delivery budget", () => {
    const longOutputPath = `/${"project/".repeat(200)}output.log`;
    const delivered = formatAsyncResultOutput(
      "code-reviewer-docs",
      oversizedReviewerJson,
      longOutputPath,
      500,
    );

    assert.ok(delivered.length <= 500);
    assert.doesNotThrow(() => JSON.parse(delivered));
    assert.ok(!delivered.includes("Sensitive finding detail"));
  });
});
