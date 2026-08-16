import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { djb2Hash, isPiMetaInvocation, isPiOneshotInvocation } from "../../../extensions/orchestrator/utils.js";

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

describe("isPiMetaInvocation", () => {
	it("detects --help", () => {
		assert.equal(isPiMetaInvocation(["node", "pi", "--help"]), true);
	});

	it("detects -h", () => {
		assert.equal(isPiMetaInvocation(["node", "pi", "-h"]), true);
	});

	it("detects --version", () => {
		assert.equal(isPiMetaInvocation(["node", "pi", "--version"]), true);
	});

	it("detects -v", () => {
		assert.equal(isPiMetaInvocation(["node", "pi", "-v"]), true);
	});

	it("ignores bare pi with no args", () => {
		assert.equal(isPiMetaInvocation(["node", "pi"]), false);
	});

	it("ignores json mode prompt invocations", () => {
		assert.equal(
			isPiMetaInvocation(["node", "pi", "--mode", "json", "-p", "hi"]),
			false,
		);
	});

	it("ignores -h when used as prompt value", () => {
		assert.equal(
			isPiMetaInvocation(["node", "pi", "--mode", "json", "-p", "-h"]),
			false,
		);
	});

	it("ignores --help when used as prompt value", () => {
		assert.equal(isPiMetaInvocation(["node", "pi", "-p", "--help"]), false);
	});

	it("stops at -- so later help-like tokens are ignored", () => {
		assert.equal(isPiMetaInvocation(["node", "pi", "--", "--help"]), false);
	});
});

describe("isPiOneshotInvocation", () => {
	it("detects -p", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "-p", "say hi"]), true);
	});

	it("detects --print", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--print", "say hi"]), true);
	});

	it("detects --mode json", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--mode", "json", "hi"]), true);
	});

	it("detects --mode=json", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--mode=json", "hi"]), true);
	});

	it("detects -p mixed with --model", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--model", "litellm/claude-opus-4-6-1m", "-p", "say hi"]),
			true,
		);
	});

	it("ignores interactive session", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi"]), false);
	});

	it("ignores --mode rpc", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--mode", "rpc"]), false);
	});

	it("ignores --mode=rpc", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--mode=rpc"]), false);
	});

	it("stops at -- so later -p in prompt is ignored", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--", "-p", "hi"]), false);
	});
});
