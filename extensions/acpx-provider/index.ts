/**
 * ACPX Provider Extension for pi
 *
 * Routes pi LLM requests through acpx CLI using persistent sessions.
 * This lets you use models only available through specific agents (e.g., Cursor's
 * Composer 2, GPT-5.4, etc.) as native pi models.
 *
 * How it works:
 * 1. On session_start, creates a named acpx session per agent
 * 2. On each LLM request, sends only the latest user message via `acpx <agent> prompt`
 *    (the acpx session maintains full conversation history on the agent side)
 * 3. On model switch, calls `acpx <agent> set model` on the session
 * 4. On session_shutdown, closes the acpx session
 *
 * Configuration:
 *   ACPX_AGENTS - Comma-separated list of agents (default: "cursor")
 *                 e.g., "cursor,claude,gemini,copilot"
 *
 * Auto-discovered from: ~/.pi/agent/extensions/acpx-provider/
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, execSync } from "child_process";

// =============================================================================
// Types
// =============================================================================

interface AcpxModelInfo {
	modelId: string;
	name: string;
}

interface JsonRpcMessage {
	jsonrpc: string;
	id?: number;
	method?: string;
	result?: any;
	params?: any;
	error?: any;
}

interface AgentSession {
	name: string;
	agent: string;
	/** Whether the system prompt has been sent to this session */
	systemPromptSent: boolean;
}

// =============================================================================
// Session Management
// =============================================================================

/** Active acpx sessions keyed by agent name */
const sessions = new Map<string, AgentSession>();

/**
 * The working directory captured at extension initialization time.
 * acpx searches for session markers starting from cwd, but pi's process
 * may run from /tmp where no markers exist. We capture the real project
 * cwd at init and pass it to all child processes.
 */
let projectCwd: string | undefined;

/** List of registered acpx agent names, used to reject non-acpx models */
let registeredAgents: string[] = [];

function sessionName(agent: string): string {
	return `pi-${agent}-${process.pid}`;
}

function createSession(agent: string, cwd?: string): void {
	const name = sessionName(agent);
	const effectiveCwd = cwd || process.cwd();
	// Try ensure first (idempotent), then new as fallback
	try {
		execSync(`acpx ${agent} sessions ensure --name "${name}"`, {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
			cwd: effectiveCwd,
		});
	} catch {
		try {
			execSync(`acpx ${agent} sessions new --name "${name}"`, {
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 15000,
				cwd: effectiveCwd,
			});
		} catch {
			// Fall back to no named session
			sessions.set(agent, { name: "", agent, systemPromptSent: false });
			return;
		}
	}

	sessions.set(agent, { name, agent, systemPromptSent: false });
}

function closeSession(agent: string, cwd?: string): void {
	const session = sessions.get(agent);
	if (!session || !session.name) return;
	try {
		execSync(`acpx ${agent} sessions close "${session.name}"`, {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
			cwd,
		});
	} catch {
		// Best effort cleanup
	}
	sessions.delete(agent);
}

// =============================================================================
// Model Discovery
// =============================================================================

function discoverModels(_agent: string): Promise<AcpxModelInfo[]> {
	return new Promise((resolve) => {
		const models: AcpxModelInfo[] = [];
		let stdout = "";
		let resolved = false;

		const proc = spawn("agent", ["models"], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill("SIGTERM");
				resolve(models);
			}
		}, 30000);

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		proc.on("close", () => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timeout);

			// Parse lines matching "<id> - <name>" pattern
			const lines = stdout.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				// Skip empty lines, header lines, and tip lines
				if (!trimmed) continue;
				if (trimmed.startsWith("Loading")) continue;
				if (trimmed === "Available models") continue;
				if (trimmed.startsWith("Tip:")) continue;

				const match = trimmed.match(/^(\S+)\s+-\s+(.+)$/);
				if (match) {
					const modelId = match[1];
					// Strip (default), (current), or similar markers from the name
					const name = match[2].replace(/\s*\((?:default|current)\)\s*$/i, "").trim();
					models.push({ modelId, name });
				}
			}

			resolve(models);
		});

		proc.on("error", () => {
			if (!resolved) { resolved = true; clearTimeout(timeout); resolve(models); }
		});
	});
}

// =============================================================================
// Context Helpers
// =============================================================================

/**
 * Extract the latest user message from pi's context.
 * Since the acpx session maintains its own conversation history,
 * we only send the newest user message.
 *
 * On the first prompt of a session, we prepend pi's system prompt
 * so the remote agent has the right instructions.
 */
function extractLatestUserMessage(context: Context, agent: string): string {
	const parts: string[] = [];
	const session = sessions.get(agent);

	// On first prompt, send system prompt to establish context
	if (session && !session.systemPromptSent && context.systemPrompt) {
		parts.push(
			"<system_instructions>",
			"You are being used as a backend LLM through pi coding agent.",
			"You have full permission to read, write, edit, and execute any files or commands.",
			"Follow these instructions:",
			"",
			context.systemPrompt,
			"</system_instructions>",
			"",
		);
		session.systemPromptSent = true;
	}

	// Find last user message
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			const textParts: string[] = [];
			for (const block of msg.content) {
				if ("text" in block && typeof block.text === "string") {
					textParts.push(block.text);
				}
			}
			if (textParts.length > 0) {
				parts.push(textParts.join("\n"));
				break;
			}
		}
	}

	return parts.join("\n") || "hello";
}

// =============================================================================
// Stream Implementation
// =============================================================================

function streamAcpx(
	model: Model<any>,
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
			stream.push({ type: "start", partial: output });

			// Parse agent and acpx model from pi model id: "agent:modelId"
			const colonIdx = model.id.indexOf(":");
			const agent = colonIdx >= 0 ? model.id.substring(0, colonIdx) : model.id;
			const acpxModelId = colonIdx >= 0 ? model.id.substring(colonIdx + 1) : undefined;

			// Ensure session exists — retry with cwd fallback
			if (!sessions.has(agent)) {
				createSession(agent, projectCwd);
			}
			// If session creation failed (empty name), try again with process.cwd()
			const existingSession = sessions.get(agent);
			if (existingSession && !existingSession.name) {
				sessions.delete(agent);
				createSession(agent, process.cwd());
			}

			const session = sessions.get(agent);
			const prompt = extractLatestUserMessage(context, agent);

			// Build acpx prompt command with session
			const args = ["--format", "json", "--approve-all"];
			if (acpxModelId && acpxModelId !== "default") {
				args.push("--model", acpxModelId);
			}
			args.push(agent, "prompt");
			if (session?.name) {
				args.push("-s", session.name);
			}
			args.push(prompt);

			const proc = spawn("acpx", args, {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: projectCwd,
			});

			let buffer = "";
			let textContentIndex = -1;
			let thinkingContentIndex = -1;
			let killed = false;

			// Handle abort
			if (options?.signal) {
				const onAbort = () => {
					if (!killed) {
						killed = true;
						proc.kill("SIGTERM");
					}
				};
				if (options.signal.aborted) {
					killed = true;
					proc.kill("SIGTERM");
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					let msg: JsonRpcMessage;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}

					if (msg.method === "session/update" && msg.params?.update) {
						const update = msg.params.update;

						switch (update.sessionUpdate) {
							case "agent_message_chunk": {
								const text = update.content?.text || "";
								if (!text) break;

								if (textContentIndex < 0) {
									// Close thinking block if open
									if (thinkingContentIndex >= 0) {
										const thinkBlock = output.content[thinkingContentIndex];
										if (thinkBlock.type === "thinking") {
											stream.push({
												type: "thinking_end",
												contentIndex: thinkingContentIndex,
												content: thinkBlock.thinking,
												partial: output,
											});
										}
									}
									output.content.push({ type: "text", text: "" });
									textContentIndex = output.content.length - 1;
									stream.push({
										type: "text_start",
										contentIndex: textContentIndex,
										partial: output,
									});
								}

								const block = output.content[textContentIndex];
								if (block.type === "text") {
									block.text += text;
									stream.push({
										type: "text_delta",
										contentIndex: textContentIndex,
										delta: text,
										partial: output,
									});
								}
								break;
							}

							case "agent_thought_chunk": {
								const text = update.content?.text || "";
								if (!text) break;

								if (thinkingContentIndex < 0) {
									output.content.push({ type: "thinking", thinking: "" });
									thinkingContentIndex = output.content.length - 1;
									stream.push({
										type: "thinking_start",
										contentIndex: thinkingContentIndex,
										partial: output,
									});
								}

								const block = output.content[thinkingContentIndex];
								if (block.type === "thinking") {
									block.thinking += text;
									stream.push({
										type: "thinking_delta",
										contentIndex: thinkingContentIndex,
										delta: text,
										partial: output,
									});
								}
								break;
							}

							// Ignore tool_call / tool_call_update — remote agent's tools,
							// not pi's. We only capture text output.
							default:
								break;
						}
					}

					// Handle final result
					if (msg.id !== undefined && msg.result?.stopReason) {
						const reason = msg.result.stopReason;
						output.stopReason = reason === "end_turn" ? "stop" : reason;
					}

					// Capture JSON-RPC errors for diagnostics
					if (msg.error) {
						stderrOutput += `JSON-RPC error: ${msg.error.message || JSON.stringify(msg.error)}\n`;
					}
				}
			});

			let stderrOutput = "";
			proc.stderr.on("data", (chunk: Buffer) => {
				stderrOutput += chunk.toString();
			});

			await new Promise<void>((resolve, reject) => {
				proc.on("close", (code) => {
					// Close open content blocks
					if (thinkingContentIndex >= 0) {
						const block = output.content[thinkingContentIndex];
						if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: thinkingContentIndex,
								content: block.thinking,
								partial: output,
							});
						}
					}
					if (textContentIndex >= 0) {
						const block = output.content[textContentIndex];
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: textContentIndex,
								content: block.text,
								partial: output,
							});
						}
					}

					if (killed || options?.signal?.aborted) {
						reject(new Error("aborted"));
					} else if (code !== 0 && output.content.length === 0) {
						reject(new Error(`acpx exited with code ${code}: ${stderrOutput.trim()}`));
					} else {
						resolve();
					}
				});

				proc.on("error", reject);
			});

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: output.stopReason as "aborted" | "error",
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Capture cwd at extension load time, before pi potentially changes to /tmp.
	// acpx needs this to find session markers in the project directory tree.
	projectCwd = process.cwd();

	const agentList = (process.env.ACPX_AGENTS || "cursor")
		.split(",")
		.map((a) => a.trim())
		.filter(Boolean);

	registeredAgents = agentList;

	// Register each agent with a default placeholder model immediately
	for (const agent of agentList) {
		pi.registerProvider(`acpx-${agent}`, {
			baseUrl: "https://localhost",
			apiKey: "acpx", // pragma: allowlist secret
			api: "acpx",
			models: [
				{
					id: `${agent}:default`,
					name: `${agent} (default)`,
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 32768,
				},
			],
			streamSimple: streamAcpx,
		});
	}

	// Discover real models and create acpx sessions on pi session start
	pi.on("session_start", async (_event, ctx) => {
		// Discover models for ALL agents in parallel to avoid one slow agent delaying others
		const discoveryResults = await Promise.allSettled(
			agentList.map(async (agent) => {
				const discoveredModels = await discoverModels(agent);
				return { agent, discoveredModels };
			}),
		);

		// Register providers and create sessions based on discovery results
		for (const result of discoveryResults) {
			if (result.status === "rejected") continue;

			const { agent, discoveredModels } = result.value;
			try {
				if (discoveredModels.length > 0) {
					const models = discoveredModels.map((m) => ({
						id: `${agent}:${m.modelId}`,
						name: `${m.name} (${agent})`,
						reasoning: false,
						input: ["text" as const, "image" as const],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000,
						maxTokens: 32768,
					}));
					pi.registerProvider(`acpx-${agent}`, {
						baseUrl: "https://localhost",
						apiKey: "acpx", // pragma: allowlist secret
						api: "acpx",
						models,
						streamSimple: streamAcpx,
					});
					ctx.ui.notify(`acpx-${agent}: ${discoveredModels.length} models discovered and registered`, "info");
				} else {
					ctx.ui.notify(`acpx-${agent}: no models discovered (timeout?), using default only`, "warning");
				}

				// Create a persistent acpx session
				createSession(agent, projectCwd);
			} catch {
				// Keep placeholder models
			}
		}
	});

	// Clean up acpx sessions on pi shutdown
	pi.on("session_shutdown", () => {
		for (const agent of agentList) {
			closeSession(agent, projectCwd);
		}
	});
}
