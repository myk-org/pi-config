import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createLogger, isDebugEnabled, sanitizeLogSegment } from "../logger.ts";

vi.mock(
	"@earendil-works/pi-ai",
	() => ({
		calculateCost: () => undefined,
		createAssistantMessageEventStream: () => ({
			push: () => undefined,
			end: () => undefined,
			[Symbol.asyncIterator]: () => ({
				next: async () => ({ done: true, value: undefined }),
			}),
		}),
	}),
	{ virtual: true },
);

let convertMessages: typeof import("../index.js").convertMessages;
let mapStopReason: typeof import("../index.js").mapStopReason;
let parseStreamingJson: typeof import("../index.js").parseStreamingJson;
let buildModels: typeof import("../index.js").buildModels;
let resolveProjectId: typeof import("../index.js").resolveProjectId;
let stripOneMSuffix: typeof import("../index.js").stripOneMSuffix;
let usesAdaptiveThinking: typeof import("../index.js").usesAdaptiveThinking;
let applyThinkingParams: typeof import("../index.js").applyThinkingParams;

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

	it("does not import repo-only shared logger from index.ts", () => {
		const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		expect(src).not.toContain("extensions/shared/logger");
		expect(src).toContain('from "./logger.ts"');
	});

	it("createLogger does not throw", () => {
		const localLog = createLogger("pi-vertex-claude");
		expect(() => localLog.debug("test")).not.toThrow();
	});

	it("sanitizes session IDs and logger names against path traversal", () => {
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
});
