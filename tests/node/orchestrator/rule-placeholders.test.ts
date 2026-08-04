/**
 * Placeholder substitution for rules prompt injection (review_loop_max_cycles).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { substituteRulePlaceholders, substituteSettingsPlaceholders } from "../../../extensions/orchestrator/rule-placeholders.js";

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

describe("substituteSettingsPlaceholders", () => {
	const resolve = (key: string): unknown => {
		const values: Record<string, unknown> = {
			dco: true,
			commit_trailer: "Assisted-by",
			use_worktrees: false,
			comment_signature: true,
		};
		return values[key] ?? false;
	};
	const allKeys = ["dco", "commit_trailer", "use_worktrees", "comment_signature"];

	it("replaces {{SETTINGS:key1,key2}} with resolved JSON", () => {
		const result = substituteSettingsPlaceholders("Config: {{SETTINGS:dco,commit_trailer}}", resolve, allKeys);
		assert.equal(result, 'Config: {"dco":true,"commit_trailer":"Assisted-by"}');
	});

	it("replaces {{SETTINGS}} (no keys) with all keys", () => {
		const result = substituteSettingsPlaceholders("All: {{SETTINGS}}", resolve, allKeys);
		assert.equal(result, 'All: {"dco":true,"commit_trailer":"Assisted-by","use_worktrees":false,"comment_signature":true}');
	});

	it("handles multiple placeholders", () => {
		const text = "A: {{SETTINGS:dco}} B: {{SETTINGS:commit_trailer,use_worktrees}}";
		const result = substituteSettingsPlaceholders(text, resolve, allKeys);
		assert.equal(result, 'A: {"dco":true} B: {"commit_trailer":"Assisted-by","use_worktrees":false}');
	});

	it("leaves text unchanged when no placeholders", () => {
		const result = substituteSettingsPlaceholders("No placeholders here.", resolve, allKeys);
		assert.equal(result, "No placeholders here.");
	});

	it("skips unknown keys", () => {
		const result = substituteSettingsPlaceholders("{{SETTINGS:unknown_key}}", resolve, allKeys);
		assert.equal(result, '{}');
	});

	it("skips unknown keys but keeps valid ones", () => {
		const result = substituteSettingsPlaceholders("{{SETTINGS:dco,bad_key,commit_trailer}}", resolve, allKeys);
		assert.equal(result, '{"dco":true,"commit_trailer":"Assisted-by"}');
	});
});
