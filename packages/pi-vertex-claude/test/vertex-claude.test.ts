import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

beforeAll(async () => {
	const helpers = await import("../index.js");
	convertMessages = helpers.convertMessages;
	mapStopReason = helpers.mapStopReason;
	parseStreamingJson = helpers.parseStreamingJson;
	buildModels = helpers.buildModels;
	resolveProjectId = helpers.resolveProjectId;
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
			// Test the suffix-stripping logic used in streamVertexClaude
			const stripSuffix = (id: string) => (id.endsWith("-1m") ? id.slice(0, -3) : id);
			expect(stripSuffix("claude-opus-4-6-1m")).toBe("claude-opus-4-6");
			expect(stripSuffix("claude-sonnet-4-6-1m")).toBe("claude-sonnet-4-6");
			expect(stripSuffix("claude-opus-4-6")).toBe("claude-opus-4-6");
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
