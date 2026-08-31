import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAsyncResultOutput } from "../../../extensions/orchestrator/async-result-format.js";

const outputPath = "/project/.pi/tmp/code-reviewer-docs-1/output.log";
const oversizedReviewerJson = JSON.stringify({
  findings: Array.from({ length: 100 }, (_, index) => ({
    file: `src/file-${index}.ts`, line: index + 1, description: "Sensitive finding detail ".repeat(10),
  })),
});

describe("formatAsyncResultOutput (issue #801)", () => {
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

  it("retains bounded text for invalid reviewer output", () => {
    const output = "not JSON ".repeat(400);
    assert.equal(formatAsyncResultOutput("code-reviewer-docs", output, outputPath), output.slice(0, 3000));
  });
});
