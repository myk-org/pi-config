import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { withSubagentChildEnv } from "./subagent-env.js";

const ambient = process.env.PI_SUBAGENT_CHILD;

afterEach(() => {
	if (ambient === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = ambient;
});

describe("withSubagentChildEnv", () => {
	for (const previous of [undefined, "1", "sentinel"]) {
		for (const value of [undefined, "1"]) {
			it(`restores ${String(previous)} after successful setup with ${String(value)}`, () => {
				if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
				else process.env.PI_SUBAGENT_CHILD = previous;

				withSubagentChildEnv(value, () => {
					assert.equal(process.env.PI_SUBAGENT_CHILD, value);
				});

				assert.equal(process.env.PI_SUBAGENT_CHILD, previous);
			});

			it(`preserves the thrown error with ${String(previous)} overridden by ${String(value)}`, () => {
				if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
				else process.env.PI_SUBAGENT_CHILD = previous;
				const error = new Error("setup failed");

				assert.throws(() => withSubagentChildEnv(value, () => {
					assert.equal(process.env.PI_SUBAGENT_CHILD, value);
					throw error;
				}), (caught) => caught === error);

				assert.equal(process.env.PI_SUBAGENT_CHILD, previous);
			});
		}
	}

	it("restores the outer synchronous scope after nested setup", () => {
		withSubagentChildEnv("outer", () => {
			withSubagentChildEnv(undefined, () => {
				assert.equal(process.env.PI_SUBAGENT_CHILD, undefined);
			});
			assert.equal(process.env.PI_SUBAGENT_CHILD, "outer");
		});
		assert.equal(process.env.PI_SUBAGENT_CHILD, ambient);
	});

	it("does not return a callback value", () => {
		// @ts-expect-error Setup callbacks must return undefined, not a result.
		const result = withSubagentChildEnv(undefined, () => "unused");
		assert.equal(result, undefined);
		assert.equal(process.env.PI_SUBAGENT_CHILD, ambient);
	});
});

it("semantically checks the helper callback contract", () => {
	// Compile only this helper suite, not the currently untyped registration callers.
	const result = spawnSync(process.execPath, [
		// Use the workspace that declares TypeScript, even when npm does not hoist it.
		createRequire(new URL("../../../packages/pi-sidecar/package.json", import.meta.url)).resolve("typescript/bin/tsc"),
		"--noEmit", "--strict", "--skipLibCheck",
		"--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
		fileURLToPath(import.meta.url),
	], { encoding: "utf8" });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

// Compile-time contract only: never start asynchronous work in an env scope.
if (false) {
	// @ts-expect-error Async callbacks are unsupported, even without a result.
	withSubagentChildEnv(undefined, async () => {});
}
