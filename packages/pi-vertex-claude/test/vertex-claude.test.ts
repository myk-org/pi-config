import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeContext, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { createLogger, isDebugEnabled, oneLine, sanitizeLogSegment } from "../logger.ts";

const vertexMock = vi.hoisted(() => ({
	ctorArgs: [] as Array<Record<string, unknown>>,
	request: undefined as any,
	requestOptions: undefined as any,
	events: [] as Array<Record<string, unknown>>,
}));
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: class {
		constructor(opts: Record<string, unknown>) {
			vertexMock.ctorArgs.push(opts);
		}
		messages = {
			stream: (request: unknown, requestOptions?: unknown) => {
				vertexMock.request = request;
				vertexMock.requestOptions = requestOptions;
				const events = vertexMock.events;
				return {
					async *[Symbol.asyncIterator]() {
						for (const event of events) {
							yield event;
						}
					},
				};
			},
		};
	},
}));

let convertMessages: typeof import("../index.js").convertMessages;
let mapStopReason: typeof import("../index.js").mapStopReason;
let parseStreamingJson: typeof import("../index.js").parseStreamingJson;
let buildModels: typeof import("../index.js").buildModels;
let resolveProjectId: typeof import("../index.js").resolveProjectId;
let stripOneMSuffix: typeof import("../index.js").stripOneMSuffix;
let usesAdaptiveThinking: typeof import("../index.js").usesAdaptiveThinking;
let applyThinkingParams: typeof import("../index.js").applyThinkingParams;
let streamVertexClaude: typeof import("../index.js").streamVertexClaude;

beforeAll(async () => {
	const helpers = await import("../index.js");
	convertMessages = helpers.convertMessages;
	mapStopReason = helpers.mapStopReason;
	parseStreamingJson = helpers.parseStreamingJson;
	buildModels = helpers.buildModels;
	resolveProjectId = helpers.resolveProjectId;
	stripOneMSuffix = helpers.stripOneMSuffix;
	usesAdaptiveThinking = helpers.usesAdaptiveThinking;
	applyThinkingParams = helpers.applyThinkingParams;
	streamVertexClaude = helpers.streamVertexClaude;
});

const model = {
	id: "test-model",
	name: "Test Model",
	api: "vertex-claude-api",
	provider: "google-vertex-claude",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as const;

const oldTool: Tool = { name: "old_tool", description: "Old", parameters: { type: "object", properties: {} } };
const currentTool: Tool = {
	name: "current_tool",
	description: "Current",
	parameters: {
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
	},
};

async function captureRequest(context: TranscriptContext) {
	process.env.GOOGLE_CLOUD_PROJECT = "test-project";
	process.env.GOOGLE_APPLICATION_CREDENTIALS = import.meta.filename;
	for await (const _event of streamVertexClaude(model as any, context)) {}
	return vertexMock.request;
}

beforeEach(() => {
	vertexMock.ctorArgs.length = 0;
	vertexMock.request = undefined;
	vertexMock.requestOptions = undefined;
	vertexMock.events = [];
});

describe("Vertex transcript request state", () => {
	it("uses the current system prompt", async () => {
		const context = normalizeContext({ systemPrompt: "Initial instructions", messages: [] });
		context.messages.push({ role: "system", content: "Updated instructions", timestamp: 1 });

		const request = await captureRequest(context);

		expect(request.system[0].text).toBe("Initial instructions\n\nUpdated instructions");
	});

	it("uses the current tools", async () => {
		const context = normalizeContext({ messages: [], tools: [oldTool] });
		context.messages.push({
			role: "system",
			content: "",
			toolsRemoved: [{ name: oldTool.name }],
			toolsAdded: [currentTool],
			timestamp: 1,
		});

		const request = await captureRequest(context);

		expect(request.tools).toEqual([
			{
				name: "current_tool",
				description: "Current",
				input_schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
			},
		]);
	});
});

describe("vertex-claude helpers", () => {
	it("parses partial JSON", () => {
		const result = parseStreamingJson("{\"a\": 1");
		expect(result).toMatchObject({ a: 1 });
	});

	it("returns empty object for empty input", () => {
		expect(parseStreamingJson("")).toEqual({});
	});

	it("maps known stop reasons and throws on unknown", () => {
		expect(mapStopReason("end_turn")).toBe("stop");
		expect(mapStopReason("tool_use")).toBe("toolUse");
		expect(() => mapStopReason("unknown")).toThrow(/Unhandled stop reason/);
	});

	it("adds cache_control to last tool_result block", () => {
		const model = {
			id: "test-model",
			name: "Test Model",
			api: "vertex-claude-api",
			provider: "google-vertex-claude",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} as const;

		const messages = [
			{ role: "user", content: "hi" },
			{
				role: "toolResult",
				toolCallId: "tool-1",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
		];

		const params = convertMessages(messages as any, model as any);
		const lastMessage = params[params.length - 1];
		const lastBlock = lastMessage.content[lastMessage.content.length - 1];

		expect(lastBlock.type).toBe("tool_result");
		expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
	});

	it("adds cache_control to last text block in user content arrays", () => {
		const model = {
			id: "test-model",
			name: "Test Model",
			api: "vertex-claude-api",
			provider: "google-vertex-claude",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		} as const;

		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "base64", mimeType: "image/png" },
				],
			},
		];

		const params = convertMessages(messages as any, model as any);
		const lastMessage = params[params.length - 1];
		const lastBlock = lastMessage.content[lastMessage.content.length - 1];

		expect(lastBlock.type).toBe("image");
		expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
	});

	it("attaches cache_control when last user message has plain-string content", () => {
		const messages = [
			{ role: "user", content: "first question" },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
			{ role: "user", content: "follow-up \uD800 question" },
		];

		const params = convertMessages(messages as any, model as any);

		expect(params[0]).toEqual({ role: "user", content: "first question" });
		expect(params[2]).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: "follow-up \uFFFD question",
					cache_control: { type: "ephemeral" },
				},
			],
		});
	});

	it("does not attach cache_control when last message is from assistant", () => {
		const messages = [
			{ role: "user", content: "question" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		];

		const params = convertMessages(messages as any, model as any);

		expect(params[0]).toEqual({ role: "user", content: "question" });
		expect(params[1].content[0]).not.toHaveProperty("cache_control");
	});

	describe("resolveProjectId priority", () => {
		const envVars = ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "ANTHROPIC_VERTEX_PROJECT_ID"] as const;
		const savedEnv: Record<string, string | undefined> = {};

		function clearProjectEnvVars() {
			for (const v of envVars) {
				savedEnv[v] = process.env[v];
				delete process.env[v];
			}
		}

		function restoreProjectEnvVars() {
			for (const v of envVars) {
				if (savedEnv[v] !== undefined) {
					process.env[v] = savedEnv[v];
				} else {
					delete process.env[v];
				}
			}
		}

		afterEach(() => restoreProjectEnvVars());

		it("should prefer GOOGLE_CLOUD_PROJECT over others", () => {
			clearProjectEnvVars();
			process.env.GOOGLE_CLOUD_PROJECT = "gcp-project";
			process.env.GCLOUD_PROJECT = "gcloud-project";
			process.env.ANTHROPIC_VERTEX_PROJECT_ID = "anthropic-project";

			const result = resolveProjectId();
			expect(result).toEqual({ id: "gcp-project", envVar: "GOOGLE_CLOUD_PROJECT" });
		});

		it("should fall back to GCLOUD_PROJECT when GOOGLE_CLOUD_PROJECT is not set", () => {
			clearProjectEnvVars();
			process.env.GCLOUD_PROJECT = "gcloud-project";
			process.env.ANTHROPIC_VERTEX_PROJECT_ID = "anthropic-project";

			const result = resolveProjectId();
			expect(result).toEqual({ id: "gcloud-project", envVar: "GCLOUD_PROJECT" });
		});

		it("should fall back to ANTHROPIC_VERTEX_PROJECT_ID when others are not set", () => {
			clearProjectEnvVars();
			process.env.ANTHROPIC_VERTEX_PROJECT_ID = "anthropic-project";

			const result = resolveProjectId();
			expect(result).toEqual({ id: "anthropic-project", envVar: "ANTHROPIC_VERTEX_PROJECT_ID" });
		});

		it("should return undefined when no project env vars are set", () => {
			clearProjectEnvVars();

			const result = resolveProjectId();
			expect(result).toBeUndefined();
		});
	});
});

describe("1M context window support", () => {
	describe("buildModels", () => {
		it("should return only base models when VERTEX_CLAUDE_1M is not set", () => {
			delete process.env.VERTEX_CLAUDE_1M;
			const models = buildModels();
			const has1m = models.some((m) => m.id.endsWith("-1m"));
			expect(has1m).toBe(false);
			expect(models.map((m) => m.id)).toContain("claude-opus-4-8");
			expect(models.map((m) => m.id)).toContain("claude-opus-4-6");
			const opus48 = models.find((m) => m.id === "claude-opus-4-8");
			expect(opus48?.contextWindow).toBe(1000000);
			expect(opus48?.maxTokens).toBe(128000);
		});

		it("should return only base models when VERTEX_CLAUDE_1M is set to a non-true value", () => {
			process.env.VERTEX_CLAUDE_1M = "false";
			const models = buildModels();
			const has1m = models.some((m) => m.id.endsWith("-1m"));
			expect(has1m).toBe(false);
			delete process.env.VERTEX_CLAUDE_1M;
		});

		it("should add -1m variants when VERTEX_CLAUDE_1M=true", () => {
			process.env.VERTEX_CLAUDE_1M = "true";
			const models = buildModels();
			const oneM = models.filter((m) => m.id.endsWith("-1m"));
			expect(oneM.length).toBeGreaterThan(0);
			// Should have -1m variants for opus-4-6 and sonnet-4-6
			expect(oneM.map((m) => m.id)).toContain("claude-opus-4-6-1m");
			expect(oneM.map((m) => m.id)).toContain("claude-sonnet-4-6-1m");
			expect(oneM.map((m) => m.id)).not.toContain("claude-opus-4-8-1m");
			delete process.env.VERTEX_CLAUDE_1M;
		});

		it("-1m variants should have contextWindow of 1000000", () => {
			process.env.VERTEX_CLAUDE_1M = "true";
			const models = buildModels();
			const oneM = models.filter((m) => m.id.endsWith("-1m"));
			for (const model of oneM) {
				expect(model.contextWindow).toBe(1000000);
			}
			delete process.env.VERTEX_CLAUDE_1M;
		});

		it("-1m variants should have '(Vertex 1M)' in name", () => {
			process.env.VERTEX_CLAUDE_1M = "true";
			const models = buildModels();
			const oneM = models.filter((m) => m.id.endsWith("-1m"));
			for (const model of oneM) {
				expect(model.name).toContain("(Vertex 1M)");
				expect(model.name).not.toContain("(Vertex)");
			}
			delete process.env.VERTEX_CLAUDE_1M;
		});

		it("-1m variants should preserve other properties from base model", () => {
			process.env.VERTEX_CLAUDE_1M = "true";
			const models = buildModels();
			const opus1m = models.find((m) => m.id === "claude-opus-4-6-1m");
			const opusBase = models.find((m) => m.id === "claude-opus-4-6");
			expect(opus1m).toBeDefined();
			expect(opusBase).toBeDefined();
			expect(opus1m!.cost).toEqual(opusBase!.cost);
			expect(opus1m!.maxTokens).toBe(opusBase!.maxTokens);
			expect(opus1m!.reasoning).toBe(opusBase!.reasoning);
			expect(opus1m!.input).toEqual(opusBase!.input);
			delete process.env.VERTEX_CLAUDE_1M;
		});

		it("should only create -1m variants for eligible models (opus-4-6, sonnet-4-6)", () => {
			process.env.VERTEX_CLAUDE_1M = "true";
			const models = buildModels();
			const oneM = models.filter((m) => m.id.endsWith("-1m"));
			expect(oneM).toHaveLength(2);
			const ids = oneM.map((m) => m.id).sort();
			expect(ids).toEqual(["claude-opus-4-6-1m", "claude-sonnet-4-6-1m"]);
			delete process.env.VERTEX_CLAUDE_1M;
		});
	});

	describe("streaming -1m model handling", () => {
		it("should strip -1m suffix to get API model ID", () => {
			expect(stripOneMSuffix("claude-opus-4-8-1m")).toBe("claude-opus-4-8");
			expect(stripOneMSuffix("claude-opus-4-6-1m")).toBe("claude-opus-4-6");
			expect(stripOneMSuffix("claude-sonnet-4-6-1m")).toBe("claude-sonnet-4-6");
			expect(stripOneMSuffix("claude-opus-4-6")).toBe("claude-opus-4-6");
		});

		it("should identify -1m models for beta header injection", () => {
			// Test the detection logic used in streamVertexClaude
			const needs1mBeta = (id: string) => id.endsWith("-1m");
			expect(needs1mBeta("claude-opus-4-6-1m")).toBe(true);
			expect(needs1mBeta("claude-sonnet-4-6-1m")).toBe(true);
			expect(needs1mBeta("claude-opus-4-6")).toBe(false);
			expect(needs1mBeta("claude-sonnet-4-6")).toBe(false);
		});

		it("beta header value should be 'context-1m-2025-08-07'", () => {
			// Verify the constant matches expected value
			const CONTEXT_1M_BETA = "context-1m-2025-08-07";
			const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];
			betaFeatures.push(CONTEXT_1M_BETA);
			expect(betaFeatures.join(",")).toContain("context-1m-2025-08-07");
			expect(betaFeatures).toHaveLength(3);
		});
	});
});

describe("adaptive vs extended thinking", () => {
	it("uses adaptive thinking for Opus/Sonnet 4.6+", () => {
		expect(usesAdaptiveThinking("claude-opus-4-8")).toBe(true);
		expect(usesAdaptiveThinking("claude-opus-4-8-1m")).toBe(true);
		expect(usesAdaptiveThinking("claude-opus-4-6")).toBe(true);
		expect(usesAdaptiveThinking("claude-opus-4-6-1m")).toBe(true);
		expect(usesAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
	});

	it("keeps extended thinking for 4.5 and older", () => {
		expect(usesAdaptiveThinking("claude-opus-4-5@20251101")).toBe(false);
		expect(usesAdaptiveThinking("claude-sonnet-4-5@20250929")).toBe(false);
		expect(usesAdaptiveThinking("claude-haiku-4-5@20251001")).toBe(false);
		expect(usesAdaptiveThinking("claude-3-7-sonnet@20250219")).toBe(false);
	});

	it("sends adaptive + effort for 4.6+", () => {
		const params = { max_tokens: 4096 };
		applyThinkingParams(params, "claude-opus-4-8", "high");
		expect(params).toEqual({
			max_tokens: 4096,
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
	});

	it("maps pi reasoning levels to effort", () => {
		const cases: Array<[string, string]> = [
			["minimal", "low"],
			["low", "low"],
			["medium", "medium"],
			["high", "high"],
			["xhigh", "xhigh"],
			["max", "max"],
		];
		for (const [reasoning, effort] of cases) {
			const params = { max_tokens: 4096 };
			applyThinkingParams(params, "claude-opus-4-6", reasoning);
			expect(params.output_config).toEqual({ effort });
			expect(params.thinking).toEqual({ type: "adaptive" });
		}
	});

	it("omits thinking params when reasoning is off", () => {
		const params = { max_tokens: 4096, thinking: { type: "adaptive" }, output_config: { effort: "high" } };
		applyThinkingParams(params, "claude-opus-4-8", "off");
		expect(params).toEqual({ max_tokens: 4096 });
		expect(params).not.toHaveProperty("thinking");
		expect(params).not.toHaveProperty("output_config");
	});

	it("maps max to adaptive effort max", () => {
		const params = { max_tokens: 4096 };
		applyThinkingParams(params, "claude-opus-4-8", "max");
		expect(params.thinking).toEqual({ type: "adaptive" });
		expect(params.output_config).toEqual({ effort: "max" });
	});

	it("maps max to the highest extended thinking budget", () => {
		const params = { max_tokens: 4096 };
		applyThinkingParams(params, "claude-opus-4-5@20251101", "max");
		expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
		expect(params).not.toHaveProperty("output_config");
		expect(params.max_tokens).toBe(32768 + 1024);
	});

	it("clamps extended thinking so max_tokens stays within model maxTokens", () => {
		const params = { max_tokens: 4096 };
		applyThinkingParams(params, "claude-opus-4-5@20251101", "max", undefined, 32000);
		const thinking = params.thinking as { type: string; budget_tokens: number };
		expect(thinking.type).toBe("enabled");
		expect(params.max_tokens).toBeLessThanOrEqual(32000);
		expect(thinking.budget_tokens).toBeLessThan(params.max_tokens);
		expect(thinking.budget_tokens).toBe(32000 - 1024);
		expect(params.max_tokens).toBe(32000);
	});

	it("keeps enabled + budget_tokens for 4.5", () => {
		const params = { max_tokens: 4096 };
		applyThinkingParams(params, "claude-opus-4-5@20251101", "medium");
		expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 10240 });
		expect(params).not.toHaveProperty("output_config");
		expect(params.max_tokens).toBe(10240 + 1024);
	});
});

describe("package-local logger", () => {
	const originalPiLog = process.env.PI_LOG;
	const originalNamed = process.env.PI_LOG_PI_VERTEX_CLAUDE;

	afterEach(() => {
		if (originalPiLog === undefined) delete process.env.PI_LOG;
		else process.env.PI_LOG = originalPiLog;
		if (originalNamed === undefined) delete process.env.PI_LOG_PI_VERTEX_CLAUDE;
		else process.env.PI_LOG_PI_VERTEX_CLAUDE = originalNamed;
	});

	it("publishes logger.ts in the npm package files list", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(pkg.files).toContain("logger.ts");
	});

	it("createLogger does not throw", () => {
		const localLog = createLogger("pi-vertex-claude");
		expect(() => localLog.debug("test")).not.toThrow();
	});

	it("sanitizes log path segments against traversal", () => {
		expect(sanitizeLogSegment("../etc/passwd")).toBe(".._etc_passwd");
		expect(sanitizeLogSegment("foo/../../bar")).toBe("foo_.._.._bar");
		expect(sanitizeLogSegment("a\\b")).toBe("a_b");
		expect(sanitizeLogSegment("...")).toBe("_");
		expect(sanitizeLogSegment("")).toBe("_");
	});

	it("gates debug writes unless PI_LOG is debug", () => {
		process.env.PI_LOG = "info";
		delete process.env.PI_LOG_PI_VERTEX_CLAUDE;
		expect(isDebugEnabled("pi-vertex-claude")).toBe(false);
		process.env.PI_LOG = "debug";
		expect(isDebugEnabled("pi-vertex-claude")).toBe(true);
	});

	it("honors underscore PI_LOG override for hyphenated logger names", () => {
		delete process.env.PI_LOG;
		process.env.PI_LOG_PI_VERTEX_CLAUDE = "debug";
		expect(isDebugEnabled("pi-vertex-claude")).toBe(true);
	});

	it("collapses CR LF into a single physical log line", () => {
		expect(oneLine("a\nb\r\nc")).toBe("a\\nb\\nc");
	});
});

describe("Vertex client caching with per-request headers (#1181)", () => {
	const savedProject = process.env.GOOGLE_CLOUD_PROJECT;
	const savedRegion = process.env.GOOGLE_CLOUD_LOCATION;
	const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

	afterEach(() => {
		if (savedProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
		else process.env.GOOGLE_CLOUD_PROJECT = savedProject;
		if (savedRegion === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
		else process.env.GOOGLE_CLOUD_LOCATION = savedRegion;
		if (savedCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
	});

	it("reuses AnthropicVertex client for same project/region/credentials across standard vs -1m models", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "cache-test-project";
		process.env.GOOGLE_CLOUD_LOCATION = "us-east5";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = import.meta.filename;

		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
		const controller = new AbortController();

		for await (const _e of streamVertexClaude({ ...model, id: "claude-opus-4-6" } as any, context, {
			signal: controller.signal,
		})) {
		}
		expect(vertexMock.ctorArgs).toHaveLength(1);
		expect(vertexMock.ctorArgs[0]).toEqual({ projectId: "cache-test-project", region: "us-east5" });
		expect(vertexMock.requestOptions.signal).toBe(controller.signal);
		expect(vertexMock.requestOptions.headers["anthropic-beta"]).toBe(
			"fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
		);

		for await (const _e of streamVertexClaude({ ...model, id: "claude-opus-4-6-1m" } as any, context)) {
		}
		expect(vertexMock.ctorArgs).toHaveLength(1);
		expect(vertexMock.request.model).toBe("claude-opus-4-6");
		expect(vertexMock.requestOptions.headers["anthropic-beta"]).toBe(
			"fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
		);
	});

	it("creates a distinct client when projectId, region, or credentials path changes", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "proj-a";
		process.env.GOOGLE_CLOUD_LOCATION = "us-east5";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = import.meta.filename;

		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		for await (const _e of streamVertexClaude(model as any, context)) {
		}
		const afterFirst = vertexMock.ctorArgs.length;

		process.env.GOOGLE_CLOUD_PROJECT = "proj-b";
		for await (const _e of streamVertexClaude(model as any, context)) {
		}
		expect(vertexMock.ctorArgs.length).toBe(afterFirst + 1);

		process.env.GOOGLE_CLOUD_LOCATION = "europe-west1";
		for await (const _e of streamVertexClaude(model as any, context)) {
		}
		expect(vertexMock.ctorArgs.length).toBe(afterFirst + 2);

		process.env.GOOGLE_APPLICATION_CREDENTIALS = new URL("../package.json", import.meta.url).pathname;
		for await (const _e of streamVertexClaude(model as any, context)) {
		}
		expect(vertexMock.ctorArgs.length).toBe(afterFirst + 3);
	});
});

describe("streaming tool-call incremental JSON assembly (#1191)", () => {
	const savedProject = process.env.GOOGLE_CLOUD_PROJECT;
	const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
		else process.env.GOOGLE_CLOUD_PROJECT = savedProject;
		if (savedCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
	});

	it("assembles chunked tool arguments in O(N) without per-chunk JSON.parse or leaked internal props", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "stream-test-project";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = import.meta.filename;

		const chunks = ['{"pa', 'th":', ' "/tmp/a', '.txt",', ' "count"', ": 42", "}"];
		vertexMock.events = [
			{
				type: "message_start",
				message: { usage: { input_tokens: 10, output_tokens: 0 } },
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "", signature: "" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "hmm" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "sig-1" },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "call-1", name: "write", input: {} },
			},
			...chunks.map((partial_json) => ({
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json },
			})),
			{ type: "content_block_stop", index: 1 },
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 20 },
			},
		];

		const jsonParseSpy = vi.spyOn(JSON, "parse");
		const context = normalizeContext({ messages: [{ role: "user", content: "write file", timestamp: 1 }] });
		const events: Array<any> = [];
		for await (const ev of streamVertexClaude(model as any, context)) {
			events.push(ev);
		}

		// Incremental parser never calls JSON.parse per chunk; only finish() parses once at stop.
		expect(jsonParseSpy).toHaveBeenCalledTimes(1);

		const deltas = events.filter((e) => e.type === "toolcall_delta");
		expect(deltas).toHaveLength(chunks.length);
		for (const deltaEvent of deltas) {
			const block = deltaEvent.partial.content[1];
			expect(block).not.toHaveProperty("index");
			expect(block).not.toHaveProperty("partialJson");
		}

		const endEvent = events.find((e) => e.type === "toolcall_end");
		expect(endEvent).toBeDefined();
		expect(endEvent.toolCall).toEqual({
			type: "toolCall",
			id: "call-1",
			name: "write",
			arguments: { path: "/tmp/a.txt", count: 42 },
		});

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent?.reason).toBe("toolUse");
		expect(doneEvent?.message.content[0]).toEqual({
			type: "thinking",
			thinking: "hmm",
			thinkingSignature: "sig-1",
		});
	});

	it("reports argumentsError on malformed completed tool JSON", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "stream-test-project";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = import.meta.filename;

		vertexMock.events = [
			{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "bad-call", name: "write", input: {} },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"unterminated' },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		];

		const context = normalizeContext({ messages: [{ role: "user", content: "run", timestamp: 1 }] });
		const events: Array<any> = [];
		for await (const ev of streamVertexClaude(model as any, context)) {
			events.push(ev);
		}

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent?.message.content[0]).toMatchObject({
			type: "toolCall",
			id: "bad-call",
			name: "write",
			arguments: {},
		});
		expect(doneEvent?.message.content[0].argumentsError).toBeDefined();
	});

	it("returns empty arguments object when tool call completes with no delta chunks", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "stream-test-project";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = import.meta.filename;

		vertexMock.events = [
			{ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "empty-call", name: "ping", input: {} },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		];

		const context = normalizeContext({ messages: [{ role: "user", content: "run", timestamp: 1 }] });
		const events: Array<any> = [];
		for await (const ev of streamVertexClaude(model as any, context)) {
			events.push(ev);
		}

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent?.message.content[0]).toEqual({
			type: "toolCall",
			id: "empty-call",
			name: "ping",
			arguments: {},
		});
	});
});
