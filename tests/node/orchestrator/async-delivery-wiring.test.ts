import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../../../extensions/orchestrator/async-agents.ts", import.meta.url));

describe("async delivery formatter wiring (issue #803)", () => {
  it("routes every delivery and persisted-status output through the shared formatter", () => {
    const source = readFileSync(sourcePath, "utf8");
    const formatterCalls = [...source.matchAll(/formatAsyncResultOutput\(/g)];

    assert.equal(formatterCalls.length, 5);
    assert.match(source, /existing\.output = formatAsyncResultOutput\(/);
    assert.match(source, /const maxOutput = Math\.max\(3000 - autoCompleteError\.length, 500\);/);
    assert.match(source, /function deliverGroupResults[\s\S]*?formatAsyncResultOutput\(/);
    assert.match(source, /const output = formatAsyncResultOutput\([\s\S]*?const killContent/);
  });
});
