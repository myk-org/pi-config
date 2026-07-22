/**
 * Placeholder substitution for rules prompt injection (review_loop_max_cycles).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { substituteRulePlaceholders } from "../../../extensions/orchestrator/rule-placeholders.js";

describe("substituteRulePlaceholders", () => {
	it("replaces a single placeholder occurrence", () => {
		const result = substituteRulePlaceholders("Max cycles: {{REVIEW_LOOP_MAX_CYCLES}}", { reviewLoopMaxCycles: 3 });
		assert.equal(result, "Max cycles: 3");
	});

	it("replaces all occurrences", () => {
		const text = "{{REVIEW_LOOP_MAX_CYCLES}} cycles max. Stop after {{REVIEW_LOOP_MAX_CYCLES}} cycles.";
		const result = substituteRulePlaceholders(text, { reviewLoopMaxCycles: 5 });
		assert.equal(result, "5 cycles max. Stop after 5 cycles.");
	});

	it("supports boundary numeric values", () => {
		assert.equal(
			substituteRulePlaceholders("{{REVIEW_LOOP_MAX_CYCLES}}", { reviewLoopMaxCycles: 1 }),
			"1",
		);
		assert.equal(
			substituteRulePlaceholders("{{REVIEW_LOOP_MAX_CYCLES}}", { reviewLoopMaxCycles: 10 }),
			"10",
		);
	});

	it("leaves text unchanged when placeholder is absent", () => {
		const result = substituteRulePlaceholders("No placeholders here.", { reviewLoopMaxCycles: 3 });
		assert.equal(result, "No placeholders here.");
	});
});
