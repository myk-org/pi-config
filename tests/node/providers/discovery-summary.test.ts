/**
 * Regression for #788.
 *
 * Durable contract: after CLI/ACPX discovery has completed, providers/index.ts
 * appends one custom `provider-discovery-summary` transcript entry containing
 * the discovered CLI/ACPX summary. This is deliberately independent of the
 * OpenAI-compatible discovery extension: a failed later LiteLLM request must
 * not suppress the already-discovered CLI/ACPX summary.
 *
 * The unified provider extension has no injectable discovery/registration seam
 * today, and this task must not alter production source to add one. Assert the
 * required extension API boundary directly until that seam exists.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const providersExtension = readFileSync(
  join(process.cwd(), "extensions/providers/index.ts"),
  "utf8",
);

describe("CLI/ACPX provider discovery summary (#788)", () => {
  it("persists the startup summary as a custom transcript entry", () => {
    assert.match(
      providersExtension,
      /pi\.appendEntry[\s\S]*?["']provider-discovery-summary["']/,
      "CLI/ACPX discovery must append a durable custom transcript entry rather than only notify",
    );
  });
});
