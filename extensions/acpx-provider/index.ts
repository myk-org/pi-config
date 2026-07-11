/**
 * ACPX Provider Extension for pi
 *
 * Routes pi LLM requests through acpx runtime library using persistent sessions.
 * This lets you use models only available through specific agents (e.g., Cursor's
 * Composer 2, GPT-5.4, etc.) as native pi models.
 *
 * How it works:
 * 1. During extension load, creates an AcpxRuntime per agent and discovers models synchronously
 * 2. On each LLM request, sends only the latest user message via runtime.startTurn()
 *    (the acpx session maintains full conversation history on the agent side)
 * 3. Model is set per-session via ensureSession sessionOptions
 * 4. On session_shutdown, closes acpx sessions and runtime
 *
 * Configuration:
 *   ACPX_AGENTS - Comma-separated list of agents to register as providers
 *                 e.g., "cursor" or "cursor,claude,gemini,copilot"
 *
 * Loaded from: extensions/acpx-provider/ (pi-config package)
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { rm } from "node:fs/promises";

// =============================================================================
// Types
// =============================================================================

// We import acpx types dynamically to handle the case where acpx isn't installed.
// The runtime module is imported lazily on first use.
type AcpxRuntime = import("acpx/runtime").AcpxRuntime;
type AcpRuntimeHandle = import("acpx/runtime").AcpRuntimeHandle;

interface AgentState {
	agent: string;
	runtime: AcpxRuntime;
	/** Handles keyed by acpx model ID (or "default" for no model preference) */
	handles: Map<string, AcpRuntimeHandle>;
	/** In-flight handle creation promises to prevent race conditions */
	pendingHandles: Map<string, Promise<AcpRuntimeHandle>>;
	/** Whether the system prompt has been sent per handle */
	systemPromptSent: Set<string>;
	/** Available model IDs discovered from the agent */
	availableModelIds: string[];
	/** Resolves when model discovery is complete */
	ready: Promise<void>;
	/** Call to signal that initialization is complete */
	signalReady: () => void;
}

// =============================================================================
// Module State
// =============================================================================

/** Active agent runtimes keyed by agent name */
const agents = new Map<string, AgentState>();

/**
 * The working directory captured at extension initialization time.
 * acpx searches for session markers starting from cwd, but pi's process
 * may run from /tmp where no markers exist. We capture the real project
 * cwd at init and pass it to all runtime instances.
 */
let projectCwd: string;
let projectCwdSlug: string;

/** List of registered acpx agent names, used to reject non-acpx models */
let registeredAgents: string[] = [];

// =============================================================================
// SDK Console Error Suppression
// =============================================================================

/**
 * Suppress the ACP SDK's console.error for unhandled extension methods.
 * The SDK logs "Error handling request" for every agent-specific method
 * (cursor/task, cursor/update_todos, etc.) that the client doesn't handle.
 * These are harmless — the SDK sends methodNotFound back and the agent
 * handles it — but the log noise breaks the console view.
 *
 * Same approach as acpx's internal shouldSuppressSdkConsoleError().
 */
let consoleErrorPatched = false;
function installConsoleErrorSuppression(): void {
	if (consoleErrorPatched) return;
	consoleErrorPatched = true;
	const originalConsoleError = console.error;
	console.error = (...args: any[]) => {
		if (args.length > 0 && typeof args[0] === "string" && args[0] === "Error handling request") {
			return;
		}
		originalConsoleError(...args);
	};
}

// =============================================================================
// Runtime Initialization
// =============================================================================

async function createAgentRuntime(): Promise<AcpxRuntime> {
	const {
		createAcpRuntime,
		createFileSessionStore,
		createAgentRegistry,
	} = await import("acpx/runtime");

	const stateDir = path.join(os.homedir(), ".acpx", `pi-${projectCwdSlug}`);
	const runtime = createAcpRuntime({
		cwd: projectCwd,
		sessionStore: createFileSessionStore({ stateDir }),
		agentRegistry: createAgentRegistry(),
		permissionMode: "approve-all",
	});

	return runtime;
}

function sessionKey(agent: string, modelId?: string): string {
	const model = modelId && modelId !== "default" ? `-${modelId.replace(/[^a-zA-Z0-9.-]/g, "_")}` : "";
	return `pi-${agent}${model}-${projectCwdSlug}`;
}

async function ensureHandle(
	state: AgentState,
	acpxModelId: string | undefined,
	systemPrompt?: string,
): Promise<AcpRuntimeHandle> {
	const key = acpxModelId || "default";

	// Return existing handle
	const existing = state.handles.get(key);
	if (existing) return existing;

	// Prevent race: if another call is already creating this handle, wait for it
	const pending = state.pendingHandles.get(key);
	if (pending) return pending;

	const promise = (async () => {
		try {
			const sessionOpts: { model?: string; systemPrompt?: string } = {};
			if (acpxModelId && acpxModelId !== "default") {
				sessionOpts.model = acpxModelId;
			}
			if (systemPrompt) {
				sessionOpts.systemPrompt = systemPrompt;
			}

			const handle = await state.runtime.ensureSession({
				sessionKey: sessionKey(state.agent, acpxModelId),
				agent: state.agent,
				mode: "persistent",
				cwd: projectCwd,
				...(Object.keys(sessionOpts).length > 0 ? { sessionOptions: sessionOpts } : {}),
			});

			state.handles.set(key, handle);
			return handle;
		} finally {
			state.pendingHandles.delete(key);
		}
	})();

	state.pendingHandles.set(key, promise);
	return promise;
}

// =============================================================================
// Model Discovery
// =============================================================================

/**
 * Discover available models for an acpx agent.
 *
 * Uses the acpx/runtime library API: creates a temporary session, queries
 * getStatus().models.availableModelIds, then closes the session.
 *
 * Returns an array of { id, name, provider } objects ready for model registries.
 *
 * @example
 * ```typescript
 * import { discoverAcpxModels } from "pi-orchestrator-config/extensions/acpx-provider";
 * const models = await discoverAcpxModels("cursor", "/path/to/project");
 * // [{ id: "cursor:gpt-5.4[...]", name: "Gpt 5.4 (cursor)", provider: "acpx-cursor" }, ...]
 * ```
 */
export async function discoverAcpxModels(
	agent: string,
	cwd?: string,
): Promise<Array<{ id: string; name: string; provider: string }>> {
	// Validate agent name to prevent path traversal or injection
	if (!/^[a-z0-9_-]+$/i.test(agent)) {
		throw new Error(`Invalid agent name: ${agent}`);
	}

	const {
		createAcpRuntime,
		createFileSessionStore,
		createAgentRegistry,
	} = await import("acpx/runtime");

	const effectiveCwd = cwd || process.cwd();
	const uid = randomUUID().slice(0, 8);
	const stateDir = path.join(os.homedir(), ".acpx", `discover-${process.pid}-${uid}`);
	const runtime = createAcpRuntime({
		cwd: effectiveCwd,
		sessionStore: createFileSessionStore({ stateDir }),
		agentRegistry: createAgentRegistry(),
		permissionMode: "deny-all",
	});

	let handle: AcpRuntimeHandle | undefined;
	try {
		handle = await runtime.ensureSession({
			sessionKey: `discover-${agent}-${uid}`,
			agent,
			mode: "oneshot",
			cwd: effectiveCwd,
		});

		const status = await runtime.getStatus({ handle });
		const modelIds = status.models?.availableModelIds || [];

		return modelIds.map((modelId) => ({
			id: `${agent}:${modelId}`,
			name: `${modelIdToDisplayName(modelId)} (${agent})`,
			provider: `acpx-${agent}`,
		}));
	} catch (err) {
		console.debug(`[acpx] model discovery failed for ${agent}:`, err);
		return [];
	} finally {
		if (handle) {
			await runtime.close({ handle, reason: "discovery complete" }).catch((err) => {
				console.debug("[acpx] failed to close discovery session:", err);
			});
		}
		await rm(stateDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function discoverModelsInternal(state: AgentState): Promise<string[]> {
	try {
		// Ensure a default session exists so we can query status
		const handle = await ensureHandle(state, undefined);
		const status = await state.runtime.getStatus({ handle });
		if (status.models?.availableModelIds) {
			state.availableModelIds = status.models.availableModelIds;
			return status.models.availableModelIds;
		}
	} catch (err) {
		console.debug(`[acpx] model discovery failed for ${state.agent}:`, err);
	}
	return [];
}

function modelIdToDisplayName(modelId: string): string {
	// Strip bracket suffixes for display: gpt-5.4[context=272k,...] -> Gpt 5.4
	const bracketIdx = modelId.indexOf("[");
	const baseName = bracketIdx >= 0 ? modelId.substring(0, bracketIdx) : modelId;
	return baseName
		.replace(/-/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

// =============================================================================
// Context Helpers
// =============================================================================

/**
 * Build the system prompt to send on first session creation.
 * Since acpx sessions maintain their own conversation history,
 * we set the system prompt once at session creation time.
 */
function buildSystemPrompt(context: Context): string | undefined {
	if (!context.systemPrompt) return undefined;
	return [
		"You are being used as a backend LLM through pi coding agent.",
		"You have full permission to read, write, edit, and execute any files or commands.",
		"Follow these instructions:",
		"",
		context.systemPrompt,
	].join("\n");
}

/**
 * Extract the latest user message from pi's context.
 * Since the acpx session maintains its own conversation history,
 * we only send the newest user message.
 */
function extractLatestUserMessage(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				return msg.content;
			}
			const textParts: string[] = [];
			for (const block of msg.content) {
				if ("text" in block && typeof block.text === "string") {
					textParts.push(block.text);
				}
			}
			if (textParts.length > 0) {
				return textParts.join("\n");
			}
		}
	}
	console.debug("[acpx] no user message found in context, using fallback");
	return "hello";
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

			// Parse agent and acpx model from pi model id: "agent:modelId[opts]"
			const colonIdx = model.id.indexOf(":");
			const agent = colonIdx >= 0 ? model.id.substring(0, colonIdx) : model.id;
			if (!registeredAgents.includes(agent)) {
				throw new Error(`Unknown acpx agent: ${agent}`);
			}
			const acpxModelId = colonIdx >= 0 ? model.id.substring(colonIdx + 1) : undefined;

			const state = agents.get(agent);
			if (!state) {
				throw new Error(`Agent runtime not initialized: ${agent}`);
			}

			// Wait for model discovery to complete before first use
			await state.ready;

			// Build system prompt for first use
			const handleKey = acpxModelId || "default";
			const needsSystemPrompt = !state.systemPromptSent.has(handleKey);
			const systemPrompt = needsSystemPrompt ? buildSystemPrompt(context) : undefined;

			// Ensure session handle exists (creates session with model + system prompt if needed)
			const handle = await ensureHandle(state, acpxModelId, systemPrompt);
			if (needsSystemPrompt) {
				state.systemPromptSent.add(handleKey);
			}

			const prompt = extractLatestUserMessage(context);

			// Create abort controller for cancellation
			const abortController = new AbortController();
			if (options?.signal) {
				if (options.signal.aborted) {
					abortController.abort();
				} else {
					options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
				}
			}

			// Start the turn using the runtime API
			const turn = state.runtime.startTurn({
				handle,
				text: prompt,
				mode: "prompt",
				requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				signal: abortController.signal,
			});

			let textContentIndex = -1;
			let thinkingContentIndex = -1;
			let thinkingClosed = false;

			// Process events from the async iterator
			for await (const event of turn.events) {
				if (abortController.signal.aborted) break;

				switch (event.type) {
					case "text_delta": {
						const text = event.text;
						if (!text) break;

						if (event.stream === "thought") {
							// Thinking content
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
						} else {
							// Regular text content
							if (textContentIndex < 0) {
								// Close thinking block if open
								if (thinkingContentIndex >= 0 && !thinkingClosed) {
									thinkingClosed = true;
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
						}
						break;
					}

					// tool_call / status events are the remote agent's tools, not pi's
					default:
						break;
				}
			}

			// Get turn result for stop reason
			const result = await turn.result;
			if (result.status === "completed") {
				output.stopReason = result.stopReason === "end_turn" ? "stop" : (result.stopReason || "stop");
			} else if (result.status === "cancelled") {
				output.stopReason = "stop";
			} else if (result.status === "failed") {
				throw new Error(`acpx turn failed: ${result.error.message}`);
			}

			// Close open content blocks
			if (thinkingContentIndex >= 0 && !thinkingClosed) {
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

export default async function (pi: ExtensionAPI) {
	// Subagents don't need acpx providers — they use the parent's model via --model flag.
	// Without this guard, cursor-agent spawns as a child and prevents the subagent from exiting.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// Suppress noisy ACP SDK errors for unhandled agent extension methods
	installConsoleErrorSuppression();

	// Capture cwd at extension load time, before pi potentially changes to /tmp.
	// acpx needs this to find session markers in the project directory tree.
	projectCwd = process.cwd();
	projectCwdSlug = createHash("sha256").update(projectCwd).digest("hex").slice(0, 12);

	const agentList = (process.env.ACPX_AGENTS || "")
		.split(",")
		.map((a) => a.trim())
		.filter((a) => /^[a-z0-9_-]+$/i.test(a));

	registeredAgents = agentList;

	// Skip sync discovery if no agents configured
	if (agentList.length === 0) return;

	const DISCOVERY_TIMEOUT_MS = 30_000;

	const makeModel = (id: string, name: string) => ({
		id, name, reasoning: false,
		input: ["text" as const, "image" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000, maxTokens: 32768,
	});

	// Discover models synchronously during extension load.
	// Pi awaits async extension factories, so models are registered before
	// the model resolver runs — preventing silent fallback to default model.
	// Timeout ensures a stuck agent doesn't block pi startup indefinitely.
	const results = await Promise.allSettled(
		agentList.map(async (agent) => {
			try {
				let timer: ReturnType<typeof setTimeout>;
				let timedOut = false;
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => { timedOut = true; reject(new Error(`discovery timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`)); }, DISCOVERY_TIMEOUT_MS);
					if (timer.unref) timer.unref();
				});

				const discovery = (async () => {
					const runtime = await createAgentRuntime();
					// Check timeout after slow runtime creation — don't store state if we already lost the race.
					// Runtime without handles is lightweight (no connections/processes); safe to discard.
					if (timedOut) { console.debug(`[acpx] ${agent}: discarding runtime after timeout`); return { agent, modelIds: [] as string[] }; }
					let signalReady!: () => void;
					const ready = new Promise<void>((resolve) => { signalReady = resolve; });
					const state: AgentState = {
						agent,
						runtime,
						handles: new Map(),
						pendingHandles: new Map(),
						systemPromptSent: new Set(),
						availableModelIds: [],
						ready,
						signalReady,
					};
					agents.set(agent, state);

					const modelIds = await discoverModelsInternal(state);
					// If timed out during discovery, clean up the orphaned state
					if (timedOut) { agents.delete(agent); return { agent, modelIds: [] as string[] }; }
					signalReady();
					return { agent, modelIds };
				})();

				const result = await Promise.race([discovery, timeout]);
				clearTimeout(timer!);
				return result;
			} catch (err) {
				console.debug(`[acpx] runtime init failed for ${agent}:`, err);
				const state = agents.get(agent);
				if (state) state.signalReady();
				return { agent, modelIds: [] as string[] };
			}
		}),
	);

	for (const result of results) {
		if (result.status === "rejected") continue;

		const { agent, modelIds } = result.value;
		// Skip registration if runtime failed (no AgentState) — prevents
		// registering a provider whose streamAcpx would always throw.
		if (!agents.has(agent)) {
			console.debug(`[acpx] acpx-${agent}: skipped registration (no runtime)`);
			continue;
		}

		try {
			const models = modelIds.length > 0
				? modelIds.map((m) => makeModel(`${agent}:${m}`, `${modelIdToDisplayName(m)} (${agent})`))
				: [makeModel(`${agent}:default`, `${agent} (default)`)];

			pi.registerProvider(`acpx-${agent}`, {
				baseUrl: "https://localhost",
				apiKey: "acpx", // pragma: allowlist secret
				api: "acpx",
				models,
				streamSimple: streamAcpx,
			});
			console.debug(`[acpx] acpx-${agent}: ${models.length} model(s) registered`);
		} catch (err) {
			console.debug(`[acpx] acpx-${agent}: setup failed:`, err);
		}
	}

	// Clean up acpx sessions on pi shutdown
	pi.on("session_shutdown", () => {
		const closePromises: Promise<void>[] = [];
		for (const [, state] of agents) {
			for (const [, handle] of state.handles) {
				closePromises.push(
					state.runtime.close({ handle, reason: "pi session shutdown" }).catch((err) => {
						console.debug(`[acpx] session close failed:`, err);
					}),
				);
			}
		}
		// Wait for graceful close, then clear state
		return Promise.allSettled(closePromises).finally(() => agents.clear());
	});
}
