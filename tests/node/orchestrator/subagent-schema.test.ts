import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerAskUser } from "../../../extensions/orchestrator/ask-user.js";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

describe("subagent & ask_user tool schemas (#1160)", () => {
	it("preserves all schema keys, defaults, and concise prompt sizes", () => {
		let subagentTool: any;
		let askUserTool: any;
		const pi = {
			registerTool: (tool: any) => {
				if (tool.name === "subagent") subagentTool = tool;
				if (tool.name === "ask_user") askUserTool = tool;
			},
			on() {},
		};

		withSubagentChildEnv(undefined, () => {
			registerSubagentTool(
				pi as any,
				() => ({ id: "1" }),
				() => ({ killed: [], errors: [] }),
			);
			registerAskUser(pi as any, () => {});
		});

		assert.ok(subagentTool);
		assert.ok(askUserTool);

		// Subagent parameter keys and defaults must remain intact
		const subProps = subagentTool.parameters.properties;
		assert.deepEqual(Object.keys(subProps).sort(), [
			"agent",
			"agentScope",
			"async",
			"asyncKill",
			"chain",
			"confirmProjectAgents",
			"cwd",
			"estimatedSeconds",
			"fireAndForget",
			"model",
			"name",
			"persistSession",
			"task",
			"taskId",
			"tasks",
		]);
		assert.equal(subProps.agentScope.default, "both");
		assert.equal(subProps.confirmProjectAgents.default, true);
		assert.equal(subProps.async.default, false);
		assert.equal(subProps.fireAndForget.default, false);
		assert.equal(subProps.persistSession.default, undefined);
		assert.deepEqual(
			Object.keys(subProps.tasks.items.properties).sort(),
			["agent", "cwd", "estimatedSeconds", "model", "name", "task", "taskId"],
		);
		assert.deepEqual(
			Object.keys(subProps.chain.items.properties).sort(),
			["agent", "cwd", "estimatedSeconds", "task", "taskId"],
		);

		// Verify trimmed prose stays compact while preserving essential 30s and no-polling rules
		const subagentText = [
			subagentTool.description,
			...(subagentTool.promptGuidelines ?? []),
			...Object.values(subProps).map((p: any) => String(p.description ?? "")),
		].join("\n");
		assert.ok(subagentText.length < 1500, `Expected compact subagent schema text, got ${subagentText.length} chars`);
		assert.match(subagentText, /30s/);
		assert.match(subagentText, /sleep\/poll|poll/i);

		// ask_user keys and compact prose
		assert.deepEqual(Object.keys(askUserTool.parameters.properties), ["question", "options"]);
		const askText = [
			askUserTool.description,
			...(askUserTool.promptGuidelines ?? []),
		].join("\n");
		assert.ok(askText.length < 300, `Expected compact ask_user text, got ${askText.length} chars`);
	});
});
