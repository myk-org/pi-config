/**
 * Tests for shared utility functions.
 * Run with: npx tsx --test tests/node/shared/utils.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { djb2Hash } from "../../../extensions/orchestrator/utils.js";

describe("djb2Hash", () => {
	it("returns same value for same input (deterministic)", () => {
		assert.equal(djb2Hash("hello"), djb2Hash("hello"));
	});

	it("returns non-negative number", () => {
		assert.ok(djb2Hash("test") >= 0);
		assert.ok(djb2Hash("") >= 0);
		assert.ok(djb2Hash("a very long string with lots of characters") >= 0);
	});

	it("returns different values for different inputs", () => {
		const h1 = djb2Hash("code-reviewer-quality:/home/user/project");
		const h2 = djb2Hash("code-reviewer-security:/home/user/project");
		assert.notEqual(h1, h2);
	});

	it("handles empty string", () => {
		assert.equal(djb2Hash(""), 0);
	});

	it("returns a number", () => {
		assert.equal(typeof djb2Hash("test"), "number");
	});
});
