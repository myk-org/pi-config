/**
 * Google Vertex AI Claude Provider Extension
 *
 * Provides access to Anthropic Claude models via Google Vertex AI.
 * Uses Google Cloud Application Default Credentials (ADC) for authentication.
 *
 * Prerequisites:
 *   1. Install dependencies: cd ~/.pi/agent/extensions/vertex-claude && npm install
 *   2. Authenticate with Google Cloud: gcloud auth application-default login
 *   3. Set environment variables:
 *      - GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or ANTHROPIC_VERTEX_PROJECT_ID: Your GCP project ID
 *      - GOOGLE_CLOUD_LOCATION: Region (optional, defaults to us-east5)
 *
 * Usage:
 *   pi --provider google-vertex-claude --model claude-sonnet-4@20250514
 *
 * Or add to your shell config:
 *   function piv
 *     set -x GOOGLE_CLOUD_PROJECT your-project-id
 *     set -x GOOGLE_CLOUD_LOCATION us-east5
 *     pi --provider google-vertex-claude --model claude-opus-4-5@20251101 $argv
 *   end
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as partialParse } from "partial-json";

// =============================================================================
// Models from models.dev google-vertex-anthropic
// Pricing from: https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models
// =============================================================================

const VERTEX_CLAUDE_MODELS = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-5@20251101",
		name: "Claude Opus 4.5 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-opus-4-1@20250805",
		name: "Claude Opus 4.1 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-opus-4@20250514",
		name: "Claude Opus 4 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-sonnet-4-5@20250929",
		name: "Claude Sonnet 4.5 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4@20250514",
		name: "Claude Sonnet 4 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-3-7-sonnet@20250219",
		name: "Claude 3.7 Sonnet (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-haiku-4-5@20251001",
		name: "Claude Haiku 4.5 (Vertex)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-3-5-sonnet-v2@20241022",
		name: "Claude 3.5 Sonnet v2 (Vertex)",
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "claude-3-5-haiku@20241022",
		name: "Claude 3.5 Haiku (Vertex)",
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
];

// Model IDs that support 1M context window via the anthropic-beta header
const CONTEXT_1M_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6"]);
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

export function buildModels(): typeof VERTEX_CLAUDE_MODELS {
	const models = [...VERTEX_CLAUDE_MODELS];

	if (process.env.VERTEX_CLAUDE_1M === "true") {
		for (const model of VERTEX_CLAUDE_MODELS) {
			if (CONTEXT_1M_MODEL_IDS.has(model.id)) {
				models.push({
					...model,
					id: `${model.id}-1m`,
					name: model.name.replace("(Vertex)", "(Vertex 1M)"),
					contextWindow: 1000000,
				});
			}
		}
	}

	return models;
}

// =============================================================================
// Helper Functions
// =============================================================================

type ProjectEnvVar = "GOOGLE_CLOUD_PROJECT" | "GCLOUD_PROJECT" | "ANTHROPIC_VERTEX_PROJECT_ID";

const DEFAULT_ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
let cachedAdcExists: boolean | null = null;

function hasAdcCredentials(): boolean {
	if (cachedAdcExists !== null) return cachedAdcExists;
	const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_ADC_PATH;
	cachedAdcExists = existsSync(adcPath);
	return cachedAdcExists;
}

export function resolveProjectId(): { id: string; envVar: ProjectEnvVar } | undefined {
	if (process.env.GOOGLE_CLOUD_PROJECT) {
		return { id: process.env.GOOGLE_CLOUD_PROJECT, envVar: "GOOGLE_CLOUD_PROJECT" };
	}
	if (process.env.GCLOUD_PROJECT) {
		return { id: process.env.GCLOUD_PROJECT, envVar: "GCLOUD_PROJECT" };
	}
	if (process.env.ANTHROPIC_VERTEX_PROJECT_ID) {
		return { id: process.env.ANTHROPIC_VERTEX_PROJECT_ID, envVar: "ANTHROPIC_VERTEX_PROJECT_ID" };
	}
	return undefined;
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertContentBlocks(
	content: (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> {
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType,
				data: block.data,
			},
		};
	});

	if (!blocks.some((b) => b.type === "text")) {
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}

	return blocks;
}

export function convertMessages(messages: Message[], model: Model<Api>): any[] {
	const params: any[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) =>
					item.type === "text"
						? { type: "text" as const, text: sanitizeSurrogates(item.text) }
						: {
								type: "image" as const,
								source: { type: "base64" as const, media_type: item.mimeType, data: item.data },
							},
				);
				// Filter out images if model doesn't support them
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length > 0) {
					params.push({ role: "user", content: filteredBlocks });
				}
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking" && block.thinking.trim()) {
					// If thinking signature is missing/empty, convert to plain text
					if ((block as ThinkingContent).thinkingSignature?.trim()) {
						blocks.push({
							type: "thinking" as any,
							thinking: sanitizeSurrogates(block.thinking),
							signature: (block as ThinkingContent).thinkingSignature!,
						});
					} else {
						blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments,
					});
				}
			}
			if (blocks.length > 0) {
				params.push({ role: "assistant", content: blocks });
			}
		} else if (msg.role === "toolResult") {
			const toolResults: any[] = [];
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Collect consecutive tool results
			let j = i + 1;
			while (j < messages.length && messages[j].role === "toolResult") {
				const nextMsg = messages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}
			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}

	// Add cache control to last user message
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user" && Array.isArray(last.content)) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
				lastBlock.cache_control = { type: "ephemeral" };
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[]): any[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			properties: (tool.parameters as any).properties || {},
			required: (tool.parameters as any).required || [],
		},
	}));
}

export function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		default: {
			throw new Error(`Unhandled stop reason: ${reason}`);
		}
	}
}

// Streaming JSON parser for tool arguments
export function parseStreamingJson(partialJson: string): Record<string, any> {
	if (!partialJson || partialJson.trim() === "") {
		return {};
	}
	try {
		return JSON.parse(partialJson);
	} catch {
		try {
			return partialParse(partialJson) ?? {};
		} catch {
			return {};
		}
	}
}

// =============================================================================
// Streaming Implementation
// =============================================================================

export function streamVertexClaude(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			// Get project and region from environment
			const projectInfo = resolveProjectId();
			const region = process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION || "us-east5";

			if (!projectInfo) {
				throw new Error(
					"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or ANTHROPIC_VERTEX_PROJECT_ID.\n" +
						"Also ensure you've run: gcloud auth application-default login",
				);
			}

			if (!hasAdcCredentials()) {
				throw new Error(
					"Vertex AI requires Application Default Credentials. Run: gcloud auth application-default login\n" +
						"or set GOOGLE_APPLICATION_CREDENTIALS to a service account key file.",
				);
			}

			// Configure beta features for thinking and fine-grained streaming
			const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];

			// Add 1M context beta header for -1m model variants
			if (model.id.endsWith("-1m")) {
				betaFeatures.push(CONTEXT_1M_BETA);
			}

			// Create AnthropicVertex client - uses Google ADC automatically
			const client = new AnthropicVertex({
				projectId: projectInfo.id,
				region: region,
				defaultHeaders: {
					"anthropic-beta": betaFeatures.join(","),
				},
			});

			// Build request params — strip -1m suffix for the actual API model ID
			const apiModelId = model.id.endsWith("-1m") ? model.id.slice(0, -3) : model.id;
			const params: MessageCreateParamsStreaming = {
				model: apiModelId,
				messages: convertMessages(context.messages, model),
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};

			// Add system prompt with cache control
			if (context.systemPrompt) {
				params.system = [
					{
						type: "text",
						text: sanitizeSurrogates(context.systemPrompt),
						cache_control: { type: "ephemeral" },
					},
				];
			}

			// Add temperature if specified
			if (options?.temperature !== undefined) {
				params.temperature = options.temperature;
			}

			// Add tools if provided
			if (context.tools && context.tools.length > 0) {
				params.tools = convertTools(context.tools);
			}

			// Handle thinking/reasoning
			if (options?.reasoning && model.reasoning) {
				const defaultBudgets: Record<string, number> = {
					minimal: 1024,
					low: 4096,
					medium: 10240,
					high: 20480,
					xhigh: 32768,
				};
				const budgetKey = options.reasoning === "xhigh" ? "high" : options.reasoning;
				const customBudget = options.thinkingBudgets?.[budgetKey as keyof typeof options.thinkingBudgets];
				const thinkingBudget = customBudget ?? defaultBudgets[options.reasoning] ?? 10240;

				// Ensure max_tokens > thinking budget
				const minOutputTokens = 1024;
				if (params.max_tokens <= thinkingBudget) {
					params.max_tokens = thinkingBudget + minOutputTokens;
				}

				params.thinking = {
					type: "enabled",
					budget_tokens: thinkingBudget,
				};
			}

			// Start streaming
			const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.message.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = { type: "text", text: "", index: event.index };
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: event.content_block.name,
							arguments: event.content_block.input as Record<string, any>,
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta.thinking,
							partial: output,
						});
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
						(block as any).partialJson += event.delta.partial_json;
						block.arguments = parseStreamingJson((block as any).partialJson);
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta.partial_json,
							partial: output,
						});
					} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + (event.delta as any).signature;
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					delete (block as any).index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						block.arguments = parseStreamingJson((block as any).partialJson);
						delete (block as any).partialJson;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if ((event.delta as any).stop_reason) {
						output.stopReason = mapStopReason((event.delta as any).stop_reason);
					}
					// Update usage from message_delta
					if ((event.usage as any).input_tokens != null) {
						output.usage.input = (event.usage as any).input_tokens;
					}
					if ((event.usage as any).output_tokens != null) {
						output.usage.output = (event.usage as any).output_tokens;
					}
					if ((event.usage as any).cache_read_input_tokens != null) {
						output.usage.cacheRead = (event.usage as any).cache_read_input_tokens;
					}
					if ((event.usage as any).cache_creation_input_tokens != null) {
						output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens;
					}
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			// Clean up any index properties
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	const projectInfo = resolveProjectId();
	if (!projectInfo || !hasAdcCredentials()) {
		return;
	}

	// Get region from environment for baseUrl (used for display, SDK handles actual endpoint)
	const region = process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION || "us-east5";

	pi.registerProvider("google-vertex-claude", {
		baseUrl: `https://${region}-aiplatform.googleapis.com`, // Display URL, SDK handles actual endpoint
		apiKey: "$" + projectInfo.envVar, // Env var requires $ prefix for pi 0.77.0+
		api: "vertex-claude-api", // Custom API identifier

		models: buildModels(),

		streamSimple: streamVertexClaude,
	});
}
