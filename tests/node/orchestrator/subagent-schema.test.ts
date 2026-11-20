import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerAskUser } from "../../../extensions/orchestrator/ask-user.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import { checkSyncLimit, registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

function registerTools() {
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

	return { subagentTool, askUserTool };
}

describe("subagent & ask_user tool schemas (#1160)", () => {
	it("preserves all schema keys, defaults, and concise prompt sizes", () => {
		const expectedLimit = checkSyncLimit(0, process.cwd()).limit;
		const { subagentTool, askUserTool } = registerTools();

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

		// Verify trimmed prose stays compact while reflecting configured sync limit and no-polling rule
		const subagentText = [
			subagentTool.description,
			...(subagentTool.promptGuidelines ?? []),
			...Object.values(subProps).map((p: any) => String(p.description ?? "")),
		].join("\n");
		assert.ok(subagentText.length < 1500, `Expected compact subagent schema text, got ${subagentText.length} chars`);
		assert.match(subagentTool.promptGuidelines.join("\n"), new RegExp(`>=\\s*${expectedLimit}s\\b`));
		assert.match(subProps.estimatedSeconds.description, new RegExp(`>=\\s*${expectedLimit}s\\b`));
		assert.match(subagentText, /sleep\/poll|poll/i);

		// ask_user keys and compact prose
		assert.deepEqual(Object.keys(askUserTool.parameters.properties), ["question", "options"]);
		const askText = [
			askUserTool.description,
			...(askUserTool.promptGuidelines ?? []),
		].join("\n");
		assert.ok(askText.length < 300, `Expected compact ask_user text, got ${askText.length} chars`);
	});

	it("reflects custom sync_agent_max_seconds setting in schema and guidelines", () => {
		const prev = process.env.PI_SYNC_AGENT_MAX_SECONDS;
		process.env.PI_SYNC_AGENT_MAX_SECONDS = "45";
		clearSettingsCache();
		try {
			const { subagentTool } = registerTools();
			assert.ok(subagentTool);
			assert.match(subagentTool.promptGuidelines.join("\n"), />=\s*45s\b/);
			assert.match(subagentTool.parameters.properties.estimatedSeconds.description, />=\s*45s\b/);
		} finally {
			if (prev === undefined) delete process.env.PI_SYNC_AGENT_MAX_SECONDS;
			else process.env.PI_SYNC_AGENT_MAX_SECONDS = prev;
			clearSettingsCache();
		}
	});
});
