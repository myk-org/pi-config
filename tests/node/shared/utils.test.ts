import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { djb2Hash, isPiMetaInvocation, isPiOneshotInvocation, shouldSkipOneshotShutdownDream, shouldSkipOneshotRegister } from "../../../extensions/orchestrator/utils.js";

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

	it("ignores --mode=json (pi parseArgs treats equals as unknown flag)", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--mode=json", "hi"]), false);
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

	it("rpc wins over -p before print flag", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--mode", "rpc", "-p", "hi"]),
			false,
		);
	});

	it("rpc wins over -p after print flag", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "-p", "--mode", "rpc"]),
			false,
		);
	});

	it("ignores --mode=rpc so -p stays oneshot", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--print", "hi", "--mode=rpc"]),
			true,
		);
	});

	it("last --mode json wins over earlier rpc", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--mode", "rpc", "--mode", "json"]),
			true,
		);
	});

	it("last --mode text wins over earlier json", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--mode", "json", "--mode", "text"]),
			false,
		);
	});

	it("print flag is oneshot when last mode is text", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--mode", "json", "--mode", "text", "-p"]),
			true,
		);
	});

	it("treats -p after -- as print (parseArgs has no end-of-options)", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--", "-p", "hi"]), true);
	});

	it("ignores -p when it is the --name value", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--name", "-p"]), false);
	});

	it("ignores --print when it is the --api-key value", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--api-key", "--print"]),
			false,
		);
	});

	it("ignores -p when it is the --mode value", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--mode", "-p"]), false);
	});

	it("ignores -p when it is the --model value", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--model", "-p"]), false);
	});

	it("ignores -p when it is the --provider value", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--provider", "-p"]), false);
	});

	it("ignores -p when it is the --session-id value", () => {
		assert.equal(isPiOneshotInvocation(["node", "pi", "--session-id", "-p"]), false);
	});

	it("still detects -p after a consumed --model value", () => {
		assert.equal(
			isPiOneshotInvocation(["node", "pi", "--model", "litellm/x", "-p", "hi"]),
			true,
		);
	});
});

describe("shouldSkipOneshotShutdownDream", () => {
	it("skips when argv is oneshot even if mode is interactive", () => {
		assert.equal(
			shouldSkipOneshotShutdownDream("interactive", ["node", "pi", "-p", "hi"]),
			true,
		);
	});

	it("skips when session mode is print", () => {
		assert.equal(
			shouldSkipOneshotShutdownDream("print", ["node", "pi"]),
			true,
		);
	});

	it("skips when session mode is json", () => {
		assert.equal(
			shouldSkipOneshotShutdownDream("json", ["node", "pi"]),
			true,
		);
	});

	it("does not skip rpc even with -p", () => {
		assert.equal(
			shouldSkipOneshotShutdownDream("rpc", ["node", "pi", "-p", "--mode", "rpc"]),
			false,
		);
	});

	it("does not skip interactive session", () => {
		assert.equal(
			shouldSkipOneshotShutdownDream(undefined, ["node", "pi"]),
			false,
		);
	});
});

describe("shouldSkipOneshotRegister", () => {
	it("returns true on -p", () => {
		assert.equal(
			shouldSkipOneshotRegister({ info() {} }, ["node", "pi", "-p", "hi"]),
			true,
		);
	});

	it("logs skip register on -p", () => {
		const messages: string[] = [];
		shouldSkipOneshotRegister({ info: (m) => messages.push(m) }, ["node", "pi", "-p", "hi"]);
		assert.deepEqual(messages, ["skip register: oneshot print/json"]);
	});

	it("returns false for interactive argv", () => {
		assert.equal(
			shouldSkipOneshotRegister({ info() {} }, ["node", "pi"]),
			false,
		);
	});

	it("does not log skip for interactive argv", () => {
		const messages: string[] = [];
		shouldSkipOneshotRegister({ info: (m) => messages.push(m) }, ["node", "pi"]);
		assert.deepEqual(messages, []);
	});
});
