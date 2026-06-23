// Forked from https://github.com/disler/pi-vs-claude-code (commit b93c3f1)
// We own this code — check upstream periodically for relevant changes.
/**
 * coms — Peer-to-peer messaging between Pi agents on the same machine
 *
 * Each agent listens on a single endpoint (unix socket on POSIX, named pipe on
 * Windows) and discovers peers through per-project registry files under
 * ~/.pi/coms/projects/<project>/agents/<name>.json.
 *
 * Phase A (foundation): identity resolution, registry I/O, transport bind/send,
 * connection handlers. Phase B: tools (coms_list/send/get), agent_end
 * response capture. Phase C: live pool widget, ping + keepalive cycles, /coms
 * slash command, clean shutdown lifecycle.
 *
 * Usage: loaded via extensions/coms/index.ts
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyExtensionDefaults } from "./themeMap.js";
import { ulid, hexFg, isValidHex, fallbackColor, comsParseYamlFrontmatter as parseFrontmatter, nowIso, abbreviateModel, findSystemPromptPath, readFrontmatterFromArgv, readTaskSummary, buildInboundContent, renderTasksPart, FALLBACK_PALETTE, type TasksSummary } from "./coms-shared.js";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Worker } from "node:worker_threads";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
const TIMEOUT_MS = Number(process.env.PI_COMS_TIMEOUT_MS) || 1_800_000;
const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const LINE_CAP_BYTES = 64 * 1024;


// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "response" | "ping";

interface Envelope {
	type: EnvelopeType;
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
}

interface PromptEnvelope extends Envelope {
	type: "prompt";
	prompt: string;
	sender_name: string;
	sender_cwd: string;
	conversation_id?: string | null;
	response_schema?: object | null;
	tasks?: Array<{ subject: string; description: string }> | null;
}

interface ResponseEnvelope extends Envelope {
	type: "response";
	response: any;
	error?: string | null;
}

interface PingEnvelope extends Envelope {
	type: "ping";
}

interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct: number;
	queue_depth: number;
	tasks_summary?: { total: number; completed: number; in_progress: number } | null;
}

interface Pong {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
}

interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	/** Informational only — not used for liveness checks (socket existence + heartbeat used instead). */
	pid: number;
	endpoint: string;
	cwd: string;
	started_at: string;
	explicit: boolean;
	version: number;
	// Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
	// Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
	context_used_pct?: number;
	queue_depth?: number;
	heartbeat_at?: string;
}

interface PendingReply {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
	target_name?: string;
	created_at: string;
}

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	prompt: string;
	tasks?: Array<{ subject: string; description: string }> | null;
	response_schema?: object | null;
	fulfilled: boolean;
}

function makeEndpoint(sessionId: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-coms-${sessionId}`;
	}
	return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

/** Inline ping worker — responds to pings on a separate socket, immune to main-thread event-loop blocks */
function createPingWorker(pingEndpoint: string): Worker {
	const workerCode = `
const net = require("net");
const fs = require("fs");
const { parentPort, workerData } = require("worker_threads");

let cachedPong = null;
parentPort.on("message", (msg) => {
	if (msg.type === "update_card") cachedPong = msg.pong;
	if (msg.type === "shutdown") {
		if (srv) try { srv.close(); } catch {}
		try { fs.unlinkSync(workerData.endpoint); } catch {}
		process.exit(0);
	}
});

const srv = net.createServer((socket) => {
	let buf = "";
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf-8");
		if (buf.length > 65536) { try { socket.destroy(); } catch {} return; }
		const nl = buf.indexOf("\\n");
		if (nl < 0) return;
		const line = buf.slice(0, nl);
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "ping" && cachedPong) {
				const resp = { ...cachedPong, msg_id: parsed.msg_id };
				socket.write(JSON.stringify(resp) + "\\n");
			} else {
				socket.write(JSON.stringify({ type: "nack", msg_id: parsed.msg_id || "", error: "not ready" }) + "\\n");
			}
		} catch {
			socket.write(JSON.stringify({ type: "nack", msg_id: "", error: "parse error" }) + "\\n");
		}
		try { socket.end(); } catch {}
	});
	socket.once("error", () => { try { socket.destroy(); } catch {} });
});

// Clean up stale socket file
if (fs.existsSync(workerData.endpoint)) {
	try { fs.unlinkSync(workerData.endpoint); } catch {}
}

srv.listen(workerData.endpoint, () => {
	parentPort.postMessage({ type: "ready" });
});
srv.on("error", (err) => {
	parentPort.postMessage({ type: "error", message: err.message });
});
`;
	const worker = new Worker(workerCode, {
		eval: true,
		workerData: { endpoint: pingEndpoint },
	});
	worker.unref();
	return worker;
}

// ━━ CLI flag shape (read via pi.registerFlag/pi.getFlag) ━━━━━━━━━━━━━━━━━━━

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	// Identity flags are declared via pi.registerFlag at extension load time so
	// pi's CLI parser accepts them; here we just read them back.
	const name = pi.getFlag("cname") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	return {
		name: name && name.length > 0 ? name : undefined,
		purpose: purpose && purpose.length > 0 ? purpose : undefined,
		project: project && project.length > 0 ? project : undefined,
		color: color && color.length > 0 ? color : undefined,
		explicit: explicit === true,
	};
}

// ━━ Registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function projectAgentsDir(project: string): string {
	return path.join(COMS_DIR, "projects", project, "agents");
}

function registryFilePath(project: string, sessionId: string): string {
	// Guard against path traversal from malformed session_id
	if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
		throw new Error(`Invalid session_id: ${sessionId}`);
	}
	return path.join(projectAgentsDir(project), `${sessionId}.json`);
}

function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
	const dir = projectAgentsDir(project);
	fs.mkdirSync(dir, { recursive: true });
	const final = registryFilePath(project, entry.session_id);
	const tmp = `${final}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, final);
	return final;
}

function readAllRegistryEntries(project: string): RegistryEntry[] {
	const dir = projectAgentsDir(project);
	if (!fs.existsSync(dir)) return [];
	const out: RegistryEntry[] = [];
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, f), "utf-8");
			const parsed = JSON.parse(raw) as RegistryEntry;
			if (parsed && typeof parsed.session_id === "string") {
				out.push(parsed);
			}
		} catch {
			// skip malformed
		}
	}
	return out;
}

function readAllRegistryEntriesAcrossProjects(): RegistryEntry[] {
	const root = path.join(COMS_DIR, "projects");
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...readAllRegistryEntries(p));
	}
	return out;
}

function removeRegistryEntry(project: string, sessionId: string): void {
	try {
		fs.unlinkSync(registryFilePath(project, sessionId));
	} catch {
		// best-effort
	}
}

async function pruneDeadEntries(project: string): Promise<RegistryEntry[]> {
	const entries = readAllRegistryEntries(project);
	const socketsDir = path.join(COMS_DIR, "sockets");

	// Phase 1: Sync pre-filter (fast — no I/O)
	const candidates: RegistryEntry[] = [];
	for (const entry of entries) {
		if (!entry.endpoint || typeof entry.endpoint !== "string") {
			removeRegistryEntry(project, entry.session_id);
			continue;
		}
		// On Windows, endpoints are named pipes — fs.existsSync doesn't apply
		if (process.platform !== "win32" && !fs.existsSync(entry.endpoint)) {
			removeRegistryEntry(project, entry.session_id);
			continue;
		}
		// Check heartbeat/started_at structural validity (malformed = remove, missing = remove)
		// Timestamp staleness is NOT checked here — stale entries go to Phase 2 for socket probing.
		// This prevents false pruning after laptop suspend/resume when all timestamps are stale
		// but peers are still alive.
		const lastSeen = entry.heartbeat_at ?? entry.started_at;
		if (lastSeen) {
			const lastSeenMs = new Date(lastSeen).getTime();
			if (isNaN(lastSeenMs)) {
				removeRegistryEntry(project, entry.session_id);
				continue;
			}
		} else {
			removeRegistryEntry(project, entry.session_id);
			continue;
		}
		candidates.push(entry);
	}

	// Phase 2: Parallel socket probes (capped at 10 concurrent to avoid EMFILE)
	if (candidates.length === 0) return [];
	const PROBE_CONCURRENCY = 10;
	const results: ("in_use" | "stale")[] = [];
	for (let start = 0; start < candidates.length; start += PROBE_CONCURRENCY) {
		const batch = candidates.slice(start, start + PROBE_CONCURRENCY);
		const batchResults = await Promise.allSettled(batch.map(entry => probeStaleSocket(entry.endpoint)));
		results.push(...batchResults.map(r => r.status === "fulfilled" ? r.value : "in_use" as const));
	}
	const live: RegistryEntry[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (results[i] === "stale") {
			const entry = candidates[i];
			removeRegistryEntry(project, entry.session_id);
			if (entry.endpoint.startsWith(socketsDir + path.sep) || entry.endpoint.startsWith(socketsDir + "/")) {
				try { fs.unlinkSync(entry.endpoint); } catch { /* best-effort */ }
				try { fs.unlinkSync(`${entry.endpoint}.ping`); } catch { /* best-effort */ }
			}
		} else {
			live.push(candidates[i]);
		}
	}
	return live;
}

async function pruneDeadEntriesAllProjects(): Promise<RegistryEntry[]> {
	const root = path.join(COMS_DIR, "projects");
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...await pruneDeadEntries(p));
	}
	return out;
}

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("stale"), 250);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		sock.once("error", (err: any) => {
			clearTimeout(timer);
			if (err && (err.code === "ECONNREFUSED" || err.code === "ENOENT")) {
				finish("stale");
			} else {
				// Transient errors (EMFILE, EACCES, etc.) — treat as live to avoid false pruning
				finish("in_use");
			}
		});
	});
}

async function bindEndpoint(
	endpoint: string,
	connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		const verdict = await probeStaleSocket(endpoint);
		if (verdict === "in_use") {
			throw new Error(`coms: endpoint already in use (${endpoint})`);
		}
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// best-effort
		}
	}
	return await new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer(connHandler);
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

function readOneLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				reject(new Error("line too large"));
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				resolve(buf.slice(0, nl));
			}
		};
		socket.on("data", onData);
		socket.once("error", (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
		socket.once("close", () => {
			if (settled) return;
			settled = true;
			reject(new Error("connection closed before line received"));
		});
	});
}

function sendEnvelope(endpoint: string, envelope: Envelope | Pong | { type: string; msg_id?: string; [k: string]: any }): Promise<any> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			reject(err);
		};
		sock.once("error", fail);
		sock.once("connect", async () => {
			try {
				sock.write(JSON.stringify(envelope) + "\n");
				const line = await readOneLine(sock);
				const parsed = JSON.parse(line);
				try { sock.end(); } catch { /* ignore */ }
				if (settled) return;
				settled = true;
				if (parsed && parsed.type === "nack") {
					reject(new Error(parsed.error || "nack"));
				} else {
					resolve(parsed);
				}
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	// ━━ Register identity CLI flags so pi's parser accepts them. ━━━━━━━━━
	// Without these, pi 0.73+ rejects the invocation with "Unknown options:
	// --name, --project, ..." before this extension's hooks ever fire.
	// Agent name flag for coms peer identity.
	pi.registerFlag("cname", {
		description: "Override coms agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("purpose", {
		description: "Override agent purpose (otherwise from frontmatter description)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("project", {
		description: "Project namespace for peer discovery",
		type: "string",
		default: "default",
	});
	pi.registerFlag("color", {
		description: "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("explicit", {
		description: "Hide this agent from auto-discovery; only addressable by exact name",
		type: "boolean",
		default: false,
	});

	// State containers — shared across all hooks for this extension instance.
	let identity: {
		session_id: string;
		name: string;
		purpose: string;
		color: string;
		project: string;
		explicit: boolean;
		cwd: string;
		model: string;
		endpoint: string;
		registryFile: string;
	} | null = null;
	const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	let server: net.Server | null = null;
	let pingTimer: NodeJS.Timeout | null = null;
	let pingWorker: Worker | null = null;
	let pingWorkerReady = false;
	let cardUpdateTimer: NodeJS.Timeout | null = null;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	let includeExplicit = false;
	let displayProject: string | null = null;
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	let processingInbound = false;

	let lastPoolSnapshot = "";
	function maybeRefreshWidget(): void {
		if (!currentCtx?.hasUI) return;
		let pc = 0;
		for (const i of inboundQueue.values()) if (!i.fulfilled && i !== currentInbound) pc++;
		const key = `pending=${pc}|` + [...peerCards.entries()].map(([k, v]) => `${k}:${v.staleCount}`).sort().join(",");
		if (key === lastPoolSnapshot) return;
		lastPoolSnapshot = key;
		try { installPoolWidget(currentCtx); } catch {}
	}

	// Phase A stub handlers — each just acks valid envelopes. Phase B replaces these.
	function ackOk(socket: net.Socket, msg_id: string): void {
		try {
			socket.write(JSON.stringify({ type: "ack", msg_id }) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function nack(socket: net.Socket, msg_id: string, error: string): void {
		try {
			socket.write(JSON.stringify({ type: "nack", msg_id, error }) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
		// 1. Hop limit check
		if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
			nack(socket, env.msg_id, "hops exceeded");
			return;
		}

		// 2. Insert into inbound queue (store message content for FIFO re-injection)
		const inbound: InboundContext = {
			msg_id: env.msg_id,
			hops: env.hops,
			sender_endpoint: env.sender_endpoint,
			sender_session: env.sender_session,
			sender_name: env.sender_name,
			sender_cwd: env.sender_cwd,
			prompt: env.prompt,
			tasks: Array.isArray(env.tasks) ? env.tasks : null,
			response_schema: env.response_schema ?? null,
			fulfilled: false,
		};
		inboundQueue.set(env.msg_id, inbound);
		maybeRefreshWidget();

		// 3. If already processing another inbound, just queue — agent_end will drain FIFO.
		if (processingInbound) {
			ackOk(socket, env.msg_id);

			try {
				pi.appendEntry("coms-log", {
					event: "inbound_queued",
					msg_id: env.msg_id,
					sender: env.sender_session,
					hops: env.hops,
					queue_depth: inboundQueue.size,
				});
			} catch { /* best-effort */ }
			return;
		}

		// 4. Not busy — inject immediately.
		currentInbound = inbound;
		processingInbound = true;
		try {
			pi.sendMessage(
				{
					customType: "coms-inbound",
					content: buildInboundContent(`[from ${env.sender_name} @ ${env.sender_cwd}]`, env.prompt, env.tasks),
					display: true,
					details: {
						msg_id: env.msg_id,
						sender_session: env.sender_session,
						response_schema: env.response_schema ?? null,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (err) {
			inboundQueue.delete(env.msg_id);
			maybeRefreshWidget();
			currentInbound = null;
			processingInbound = false;
			nack(socket, env.msg_id, "internal error");
			return;
		}

		// 5. Ack + audit log
		ackOk(socket, env.msg_id);

		try {
			pi.appendEntry("coms-log", {
				event: "inbound_prompt",
				msg_id: env.msg_id,
				sender: env.sender_session,
				hops: env.hops,
			});
		} catch {
			// best-effort
		}
	}

	function handleResponse(socket: net.Socket, env: ResponseEnvelope): void {
		const pending = pendingReplies.get(env.msg_id);
		if (pending) {
			if (pending.timer) {
				try { clearTimeout(pending.timer); } catch { /* ignore */ }
				pending.timer = null;
			}
			pending.result = { response: env.response, error: env.error ?? null };
			try {
				pending.resolve(pending.result);
			} catch {
				// ignore
			}

			// Auto-deliver response as followUp so the LLM sees it without polling
			const targetName = pending.target_name ?? "peer";
			const responseText = env.error
				? `[coms response from ${targetName}] Error: ${env.error}`
				: typeof env.response === "string"
					? `[coms response from ${targetName}] ${env.response}`
					: `[coms response from ${targetName}] ${JSON.stringify(env.response, null, 2)}`;
			try {
				pi.sendMessage(
					{
						customType: "coms-response",
						content: responseText,
						display: true,
						details: {
							msg_id: env.msg_id,
							target_name: targetName,
							error: env.error ?? null,
						},
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch { /* best-effort */ }

			// Clean up immediately since response was delivered
			setTimeout(() => { pendingReplies.delete(env.msg_id); }, 60_000).unref();
		} else {
			try {
				pi.appendEntry("coms-log", { event: "orphan_response", msg_id: env.msg_id });
			} catch {
				// best-effort
			}
		}
		ackOk(socket, env.msg_id);
	}

	function buildAgentCard(): AgentCard {
		const ctx = currentCtx;
		const ident = identity;
		const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
		return {
			name: ident?.name ?? "unknown",
			purpose: ident?.purpose ?? "",
			model: ctx?.model?.id ?? ident?.model ?? "unknown",
			color: ident?.color ?? "#36F9F6",
			context_used_pct: pct,
			queue_depth: inboundQueue.size,
			tasks_summary: readTaskSummary(currentCtx?.cwd ?? process.cwd(), currentCtx?.sessionManager?.getSessionId?.()),
		};
	}

	/** Push current agent card to ping worker so it can respond independently */
	function updatePingWorkerCard(): void {
		if (!pingWorker || !pingWorkerReady) return;
		try {
			const card = buildAgentCard();
			const pong: Pong = { type: "pong", msg_id: "", agent_card: card };
			pingWorker.postMessage({ type: "update_card", pong });
		} catch { /* ignore */ }
	}

	function handlePing(socket: net.Socket, env: PingEnvelope): void {
		const card = buildAgentCard();
		const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
		try {
			socket.write(JSON.stringify(pong) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
		// Also update worker with latest card
		updatePingWorkerCard();
	}

	function isValidEnvelope(obj: any): obj is Envelope {
		return (
			obj &&
			typeof obj === "object" &&
			typeof obj.type === "string" &&
			typeof obj.msg_id === "string" &&
			typeof obj.sender_session === "string" &&
			typeof obj.sender_endpoint === "string"
		);
	}

	function connHandler(socket: net.Socket): void {
		let buf = "";
		let handled = false;
		const onData = (chunk: Buffer) => {
			if (handled) return;
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				handled = true;
				socket.removeListener("data", onData);
				nack(socket, "", "malformed envelope");
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			handled = true;
			socket.removeListener("data", onData);
			const line = buf.slice(0, nl);
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				nack(socket, "", "malformed envelope");
				return;
			}
			if (!isValidEnvelope(parsed)) {
				const mid = parsed && typeof parsed.msg_id === "string" ? parsed.msg_id : "";
				nack(socket, mid, "malformed envelope");
				return;
			}
			try {
				if (parsed.type === "prompt") {
					handlePrompt(socket, parsed as PromptEnvelope);
				} else if (parsed.type === "response") {
					handleResponse(socket, parsed as ResponseEnvelope);
				} else if (parsed.type === "ping") {
					handlePing(socket, parsed as PingEnvelope);
				} else {
					nack(socket, parsed.msg_id, "unknown type");
				}
			} catch {
				nack(socket, parsed.msg_id, "internal error");
			}
		};
		socket.on("data", onData);
		socket.once("error", () => {
			// connection failures during handshake — drop quietly
			try { socket.destroy(); } catch { /* ignore */ }
		});
	}

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;
		shuttingDown = false;
		peerCards.clear();

		// 1. Resolve identity from CLI flags > frontmatter > defaults.
		const flags = readCliFlags(pi);
		const fm = readFrontmatterFromArgv(process.argv);
		const project = flags.project || "default";
		const explicit = flags.explicit === true;
		const session_id = ulid();

		const defaultName = `agent-${session_id.slice(-6)}`;
		const name = flags.name || fm.name || defaultName;
		const purpose = flags.purpose || fm.description || "";

		// Color: validate at every level; fall through invalid hex to next.
		// Order: --color CLI flag > frontmatter color > deterministic fallback.
		let color = fallbackColor(session_id);
		if (fm.color && isValidHex(fm.color)) {
			color = fm.color;
		}
		if (flags.color && isValidHex(flags.color)) {
			color = flags.color;
		}

		const endpoint = makeEndpoint(session_id);
		const cwd = ctx.cwd || process.cwd();
		const model = ctx.model?.id ?? "unknown";

		// 2. Ensure storage dirs exist.
		try {
			fs.mkdirSync(path.join(COMS_DIR, "projects", project, "agents"), { recursive: true });
			if (process.platform !== "win32") {
				fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
				try { fs.chmodSync(COMS_DIR, 0o700); } catch { /* best-effort */ }
			}
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		// 2b. Reject duplicate names — each peer must have a unique name in the project.
		const existingEntries = readAllRegistryEntries(project);
		for (const existing of existingEntries) {
			if (existing.name === name && existing.session_id !== session_id) {
				// Verify the existing peer is actually alive via .ping endpoint.
				if (typeof existing.endpoint === "string" && existing.endpoint) {
					const pingEp = `${existing.endpoint}.ping`;
					const hasPing = process.platform === "win32" || fs.existsSync(pingEp);
					const hasMain = process.platform === "win32" || fs.existsSync(existing.endpoint);

					let pingResult: "in_use" | "stale" = "stale";
					let mainResult: "in_use" | "stale" = "stale";

					if (hasPing) {
						pingResult = await probeStaleSocket(pingEp);
					}
					if (hasMain) {
						mainResult = await probeStaleSocket(existing.endpoint);
					}

					// "stale" = ECONNREFUSED, ENOENT, or 250ms timeout — peer unresponsive.
					// "in_use" = connected OR transient error (EMFILE, etc.) — not confirmed dead.
					if (pingResult === "in_use" || mainResult === "in_use") {
						// At least one probe couldn't confirm the peer is dead.
						// If either actually connected (not just error), it's definitely alive.
						// Either way, reject — better to false-reject than allow duplicate names.
						throw new Error(
							`name "${name}" is already taken by an existing peer (probe: ping=${pingResult}, main=${mainResult}). ` +
							`Use --cname to pick a different name, or stop the other peer first.`
						);
					}

					if (!hasPing && !hasMain) {
						// No socket files at all — definitely dead
						removeRegistryEntry(project, existing.session_id);
					} else {
						// Probe(s) returned stale — remove registry, peer is dead
						removeRegistryEntry(project, existing.session_id);
					}
				} else {
					// No valid endpoint — remove stale entry
					removeRegistryEntry(project, existing.session_id);
				}
			}
		}

		// 3. Bind the endpoint.
		try {
			server = await bindEndpoint(endpoint, connHandler);
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: bind failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		// 3b. Start ping worker on separate socket for liveness checks
		const pingEndpoint = `${endpoint}.ping`;
		try {
			pingWorker = createPingWorker(pingEndpoint);
			pingWorker.on("message", (msg: any) => {
				if (msg.type === "ready") {
					pingWorkerReady = true;
					updatePingWorkerCard(); // Push initial card immediately
				}
				if (msg.type === "error") console.debug("[coms] ping worker error:", msg.message);
			});
			pingWorker.on("error", () => { pingWorkerReady = false; });
			pingWorker.on("exit", () => { pingWorkerReady = false; pingWorker = null; });
		} catch (err) {
			console.debug("[coms] ping worker failed to start:", err instanceof Error ? err.message : String(err));
		}

		// 4. Build + write registry entry atomically.
		const entry: RegistryEntry = {
			session_id,
			name,
			purpose,
			model,
			color,
			pid: process.pid,
			endpoint,
			cwd,
			started_at: nowIso(),
			explicit,
			version: 1,
		};
		let registryFile: string;
		try {
			registryFile = writeRegistryAtomic(entry, project);
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: registry write failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			try { server?.close(); } catch { /* ignore */ }
			return;
		}

		identity = {
			session_id,
			name,
			purpose,
			color,
			project,
			explicit,
			cwd,
			model,
			endpoint,
			registryFile,
		};
		includeExplicit = false;
		displayProject = project;

		// 5. Audit log: boot.
		try {
			pi.appendEntry("coms-log", { event: "boot", session_id, name, project });
		} catch {
			// best-effort
		}

		// 6. Surface presence in the UI + install the live pool widget.
		try {
			ctx.ui.setStatus("coms", `📡 ${name}@${project}`);
			installPoolWidget(ctx);
			ctx.ui.notify(
				`📡 coms ready · ${name}@${project} · ${displayProject ?? project} pool`,
				"info",
			);
		} catch {
			// hasUI may be false in some contexts — non-fatal.
		}

		// 7. Start ping + keepalive cycles (skip in one-shot modes).
		if (ctx.mode !== "print" && ctx.mode !== "json") {
		pingTimer = setInterval(() => { refreshPool().catch(() => {}); }, PING_INTERVAL_MS);
		try { (pingTimer as any).unref?.(); } catch { /* ignore */ }
		// Update ping worker card periodically
		cardUpdateTimer = setInterval(updatePingWorkerCard, 5000);
		try { (cardUpdateTimer as any).unref?.(); } catch { /* ignore */ }
		keepaliveTimer = setInterval(async () => {
			if (!identity) return;
			if (shuttingDown) return;
			try {
				// Socket self-heal: if our socket file was deleted (e.g., by pruneStaleRegistry
				// timeout), the net.Server is orphaned — listening on an inode with no filesystem
				// entry. Re-bind the server and ping worker on the same endpoint path.
				if (!shuttingDown && process.platform !== "win32" && !fs.existsSync(identity.endpoint)) {
					try {
						pi.appendEntry("coms-log", { event: "self_heal_socket", session_id: identity.session_id, reason: "socket file missing" });
						// Close old server
						if (server) {
							try { server.close(); } catch { /* ignore */ }
							server = null;
						}
						// Re-bind new server on same endpoint
						server = await bindEndpoint(identity.endpoint, connHandler);
						// Restart ping worker — terminate old one and remove its
						// event handlers to prevent late exit/error from clobbering
						// the new worker's state.
						if (pingWorker) {
							const oldWorker = pingWorker;
							oldWorker.removeAllListeners();
							try { oldWorker.postMessage({ type: "shutdown" }); } catch {}
							try { oldWorker.terminate(); } catch {}
							pingWorker = null;
							pingWorkerReady = false;
						}
						const pingEndpoint = `${identity.endpoint}.ping`;
						try {
							pingWorker = createPingWorker(pingEndpoint);
							pingWorker.on("message", (msg: any) => {
								if (msg.type === "ready") {
									pingWorkerReady = true;
									updatePingWorkerCard();
								}
								if (msg.type === "error") console.debug("[coms] ping worker error:", msg.message);
							});
							pingWorker.on("error", () => { pingWorkerReady = false; });
							pingWorker.on("exit", () => { pingWorkerReady = false; pingWorker = null; });
						} catch { /* best-effort */ }
					} catch (err) {
						pi.appendEntry("coms-log", { event: "self_heal_socket_failed", session_id: identity.session_id, reason: err instanceof Error ? err.message : String(err) });
					}
				}

				const ctx = currentCtx;
				// Detect missing-registry BEFORE writing so the self_heal audit only
				// fires when something actually went wrong (file unlinked under us).
				const missingBeforeWrite = !fs.existsSync(identity.registryFile);
				const live: RegistryEntry = {
					session_id: identity.session_id,
					name: identity.name,
					purpose: identity.purpose,
					model: ctx?.model?.id ?? identity.model,
					color: identity.color,
					pid: process.pid,
					endpoint: identity.endpoint,
					cwd: identity.cwd,
					started_at: nowIso(),
					explicit: identity.explicit,
					version: 1,
					context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
					queue_depth: inboundQueue.size,
					heartbeat_at: nowIso(),
				};
				// Unconditional atomic write: handles BOTH the live-status refresh
				// (file present → overwrite with fresh values) AND self-heal (file
				// missing → re-create entry). The atomic write also bumps mtime.
				writeRegistryAtomic(live, identity.project);
				if (missingBeforeWrite) {
					pi.appendEntry("coms-log", { event: "self_heal", session_id: identity.session_id, reason: "registry file missing" });
					// Edge case: if the file was unlinked again between our write and
					// this check, re-write once to be safe.
					if (!fs.existsSync(identity.registryFile)) {
						writeRegistryAtomic(live, identity.project);
					}
				}
			} catch { /* best-effort */ }
		}, KEEPALIVE_INTERVAL_MS);
		try { (keepaliveTimer as any).unref?.(); } catch { /* ignore */ }

		// Kick one ping cycle immediately so the widget populates fast.
		refreshPool().catch(() => {});
		} // end mode guard for timers
	});

	// ━━ Helpers used by tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function pingPeer(endpoint: string): Promise<AgentCard | null> {
		if (!identity) return null;
		const env: PingEnvelope = {
			type: "ping",
			msg_id: ulid(),
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
		};
		try {
			const resp = await sendEnvelope(endpoint, env);
			if (resp && resp.type === "pong" && resp.agent_card) {
				return resp.agent_card as AgentCard;
			}
		} catch {
			// ignore — peer unreachable
		}
		return null;
	}

	// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function renderPool(width: number, theme: Theme): string[] {
		const projectFilter = displayProject ?? identity?.project ?? "default";
		const registryEntries = projectFilter === "*"
			? readAllRegistryEntriesAcrossProjects()
			: readAllRegistryEntries(projectFilter);

		interface Row {
			name: string;
			model: string;
			color: string;
			purpose: string;
			pct: number | null;
			pending: boolean;
			stale: boolean;
			tasks?: { total: number; completed: number; in_progress: number } | null;
		}
		const rows: Row[] = [];
		const seenSessions = new Set<string>();

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			seenSessions.add(sid);
			rows.push({
				name: card.name,
				model: card.model,
				color: card.color,
				purpose: card.purpose,
				pct: card.context_used_pct,
				pending: false,
				stale: (card.staleCount ?? 0) >= 3,
				tasks: card.tasks_summary,
			});
		}

		// Registry-only entries that aren't yet in peerCards → pending
		const seenNames = new Set(rows.map((r) => r.name));
		for (const entry of registryEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!includeExplicit && entry.explicit) continue;
			if (seenSessions.has(entry.session_id)) continue;
			if (seenNames.has(entry.name)) continue;
			rows.push({
				name: entry.name,
				model: entry.model,
				color: entry.color,
				purpose: entry.purpose,
				pct: null,
				pending: true,
				stale: false,
			});
		}

		// Border helpers — sandwich the body with single-line box-drawing rules
		// so the widget reads as its own block above the minimal footer. The
		// top border carries a branded ` coms ` tag so the widget reads as its
		// own block; bottom border stays a plain rule for minimalism.
		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 12) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
			const leftFill = theme.fg("dim", "━");
			let pendingCount = 0;
			for (const i of inboundQueue.values()) if (!i.fulfilled && i !== currentInbound) pendingCount++;
			const pendingSuffix = ` (${pendingCount} pending)`;
			const nameLen = identity ? identity.name.length + pendingSuffix.length : 0;
			const rightTagVisLen = identity ? nameLen + 3 : 0;
			const remaining = safeWidth - 9 /* "┏━ coms ━" */ - rightTagVisLen - 1 /* "┓" */;
			if (identity && remaining >= 1) {
				const pendingPart = pendingCount > 0 ? theme.fg("warning", pendingSuffix) : theme.fg("dim", pendingSuffix);
				const rightTag =
					theme.fg("dim", " ") +
					hexFg(identity.color, identity.name) +
					pendingPart +
					theme.fg("dim", " ━");
				const middle = theme.fg("dim", "━".repeat(remaining));
				const right = theme.fg("dim", "┓");
				topBorder = left + leftFill + middle + rightTag + right;
			} else {
				const fallbackRemaining = Math.max(0, safeWidth - 2 /* "┏━" */ - 6 /* " coms " */ - 1 /* "┓" */);
				const right = theme.fg("dim", "━".repeat(fallbackRemaining) + "┓");
				topBorder = left + right;
			}
			bottomBorder = theme.fg("dim", "┗" + "━".repeat(safeWidth - 2) + "┛");
		}

		if (rows.length === 0) {
			const emptyMsg = theme.fg("muted", "no peers connected");
			return [
				topBorder,
				truncateToWidth(theme.fg("dim", " ") + emptyMsg, width),
				bottomBorder,
			];
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));

		const out: string[] = [topBorder];

		for (const r of rows) {
			const pctNum = r.pct ?? 0;
			const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
			const empty = 15 - filled;
			const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;

			if (r.stale) {
				const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
				out.push(truncateToWidth(" " + theme.fg("dim", dimRow), width));
				continue;
			}

			const swatch = r.pending ? theme.fg("dim", "●") : hexFg(r.color, "●");
			const namePart = theme.fg("accent", r.name.padEnd(12));
			const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
			const barFill = r.pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(r.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
			const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
			const pctPart = " " + theme.fg("accent", pctLabel.padStart(4));
			const sep = theme.fg("dim", "  —  ");
			const purposePart = theme.fg("muted", r.purpose || "");

			const tasksPart = renderTasksPart(r.tasks, theme);
			const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + tasksPart + sep + purposePart;
			out.push(truncateToWidth(line, width));
		}

		out.push(bottomBorder);
		return out;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-pool", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}), { placement: "belowEditor" });
		} catch {
			// non-fatal
		}
	}

	// ━━ Ping cycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	async function refreshPool(): Promise<void> {
		if (!identity) return;
		const projectFilter = displayProject ?? identity.project;
		const live = projectFilter === "*"
			? await pruneDeadEntriesAllProjects()
			: await pruneDeadEntries(projectFilter);

		const peers = live.filter((e) =>
			e.session_id !== identity!.session_id && (includeExplicit || !e.explicit),
		);

		const results = await Promise.allSettled(peers.map(async (peer) => {
			const pingEnv: PingEnvelope = {
				type: "ping",
				msg_id: ulid(),
				sender_session: identity!.session_id,
				sender_endpoint: identity!.endpoint,
				hops: 0,
				timestamp: nowIso(),
			};
			// Try dedicated ping socket first (immune to event-loop blocks), fall back to main
			const pingEndpoint = `${peer.endpoint}.ping`;
			let reply: any;
			try {
				reply = await sendEnvelope(pingEndpoint, pingEnv);
			} catch {
				reply = await sendEnvelope(peer.endpoint, pingEnv);
			}
			return { peer, pong: reply as Pong };
		}));

		const seenSessions = new Set<string>();
		let changed = false;

		for (const r of results) {
			if (r.status === "fulfilled" && r.value.pong && r.value.pong.agent_card) {
				const { peer, pong } = r.value;
				seenSessions.add(peer.session_id);
				const prev = peerCards.get(peer.session_id);
				const next = { ...pong.agent_card, staleCount: 0 };
				if (!prev || JSON.stringify({ ...prev, staleCount: 0 }) !== JSON.stringify(next)) {
					peerCards.set(peer.session_id, next);
					changed = true;
				}
			}
		}

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			if (!seenSessions.has(sid)) {
				card.staleCount = (card.staleCount ?? 0) + 1;
				if (card.staleCount > 6) {
					peerCards.delete(sid);
				}
				changed = true;
			}
		}

		// Dedup peerCards by name — when a peer reloads, it gets a new session_id.
		// Both old (stale) and new (alive) entries exist briefly. Keep the one with
		// lower staleCount (fresher). This prevents brief duplicate display in the widget.
		const nameToSid = new Map<string, string>();
		for (const [sid, card] of peerCards.entries()) {
			const existing = nameToSid.get(card.name);
			if (existing) {
				const prevCard = peerCards.get(existing)!;
				// Only dedup when one is clearly stale (reload artifact).
				// If both are alive (staleCount 0), keep both — they're distinct peers.
				if (card.staleCount === 0 && prevCard.staleCount === 0) {
					// Both alive — keep both, skip dedup
				} else if (card.staleCount < prevCard.staleCount) {
					peerCards.delete(existing);
					nameToSid.set(card.name, sid);
					changed = true;
				} else {
					peerCards.delete(sid);
					changed = true;
				}
			} else {
				nameToSid.set(card.name, sid);
			}
		}

		if (changed && currentCtx?.hasUI) {
			installPoolWidget(currentCtx);
		}
	}

	function listProjects(): string[] {
		const root = path.join(COMS_DIR, "projects");
		try {
			return fs.readdirSync(root).filter((d) => {
				try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
			});
		} catch {
			return [];
		}
	}

	async function resolveTarget(target: string): Promise<RegistryEntry | null> {
		// Prefer exact session_id match first (unambiguous).
		if (identity) {
			const localEntries = await pruneDeadEntries(identity.project);
			// Try session_id match first (always unambiguous)
			const bySession = localEntries.find((e) => e.session_id === target);
			if (bySession) return bySession;
			// Name match — warn if ambiguous
			const byName = localEntries.filter((e) => e.name === target);
			if (byName.length === 1) return byName[0];
			if (byName.length > 1) {
				// Ambiguous — sort deterministically: freshest heartbeat first, session_id tiebreaker
				byName.sort((a, b) => {
					const haRaw = a.heartbeat_at ? new Date(a.heartbeat_at).getTime() : 0;
					const hbRaw = b.heartbeat_at ? new Date(b.heartbeat_at).getTime() : 0;
					const ha = isNaN(haRaw) ? 0 : haRaw;
					const hb = isNaN(hbRaw) ? 0 : hbRaw;
					if (hb !== ha) return hb - ha; // freshest first
					return a.session_id.localeCompare(b.session_id); // stable tiebreak
				});
				try {
					pi.appendEntry("coms-log", {
						event: "ambiguous_target",
						target,
						matches: byName.length,
						selected_session: byName[0].session_id,
						selected_heartbeat: byName[0].heartbeat_at ?? null,
					});
				} catch { /* best-effort */ }
				return byName[0];
			}
		}
		// Fall back to scanning all projects by session_id.
		for (const proj of listProjects()) {
			const entries = await pruneDeadEntries(proj);
			const bySession = entries.find((e) => e.session_id === target);
			if (bySession) return bySession;
		}
		// Fall back to name match across projects.
		for (const proj of listProjects()) {
			const entries = await pruneDeadEntries(proj);
			const byName = entries.find((e) => e.name === target);
			if (byName) return byName;
		}
		return null;
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "coms_list",
		label: "Coms List",
		description:
			"List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
			"Use project=\"*\" to scan all projects. include_explicit=true reveals agents marked --explicit.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name, or \"*\" for all projects. Defaults to caller's project." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
		}),
		async execute(_callId, params) {
			const includeExp = params.include_explicit === true;
			const projectFilter = params.project ?? identity?.project ?? "default";
			const projects = projectFilter === "*" ? listProjects() : [projectFilter];

			const collected: { entry: RegistryEntry; project: string }[] = [];
			for (const proj of projects) {
				for (const entry of await pruneDeadEntries(proj)) {
					if (entry.explicit && !includeExp) continue;
					if (identity && entry.session_id === identity.session_id) continue;
					collected.push({ entry, project: proj });
				}
			}

			// Ping each peer in parallel for live context usage.
			const pongs = await Promise.allSettled(collected.map((c) => pingPeer(c.entry.endpoint)));

			const agents = collected.map((c, i) => {
				const r = pongs[i];
				const pong = r.status === "fulfilled" ? r.value : null;
				return {
					name: c.entry.name,
					session_id: c.entry.session_id,
					purpose: c.entry.purpose,
					model: c.entry.model,
					cwd: c.entry.cwd,
					project: c.project,
					alive: pong != null,
					context_used_pct: pong ? pong.context_used_pct : null,
					color: c.entry.color,
				};
			});

			const lines = agents.length === 0
				? "No peer agents found."
				: agents.map((a) => {
					const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
					const live = a.alive ? "●" : "✗";
					return `${live} ${a.name} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${agents.length} peer(s):\n${lines}` }],
				details: { agents, project: projectFilter },
			};
		},
		renderCall(args, theme) {
			const proj = (args as any).project;
			const filter = proj ? ` ${proj}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_list")) + theme.fg("dim", filter),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			const agents: any[] = details?.agents ?? [];
			const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) {
				return new Text(header, 0, 0);
			}
			const rows = agents.map((a) => {
				const dot = a.alive ? theme.fg("success", "●") : theme.fg("error", "✗");
				const pct = a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}`;
			}).join("\n");
			return new Text(header + "\n" + rows, 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_send",
		label: "Coms Send",
		description:
			"Send a prompt to a peer agent. Returns synchronously with a msg_id once the receiver acks. " +
			"The response auto-delivers as a followUp message when the peer replies — no polling needed. Use coms_get for non-blocking status checks if needed. " +
			"Throws if the receiver is unreachable or rejects the envelope.\n\n" +
			"When delegating multiple work items, use the `tasks` parameter to include structured task definitions. " +
			"The peer receives them as an instruction to create tasks via TaskCreate and track progress in their task widget.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred, scoped to your project) or session_id (global)." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
			tasks: Type.Optional(Type.Array(Type.Object({
				subject: Type.String({ description: "Brief task title" }),
				description: Type.String({ description: "Detailed task description" }),
			}), { description: "Optional structured tasks to create in the peer's task list." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms not initialised");
			}
			const target = await resolveTarget(params.target);
			if (!target) {
				throw new Error(`coms: no live agent matching "${params.target}"`);
			}
			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}
			const msg_id = ulid();
			const env: PromptEnvelope = {
				type: "prompt",
				msg_id,
				sender_session: identity.session_id,
				sender_endpoint: identity.endpoint,
				sender_name: identity.name,
				sender_cwd: identity.cwd,
				hops,
				timestamp: nowIso(),
				prompt: params.prompt,
				conversation_id: params.conversation_id ?? null,
				response_schema: (params.response_schema as object | undefined) ?? null,
				tasks: params.tasks ?? null,
			};

			// Send the envelope synchronously and wait for the receiver's ack.
			await sendEnvelope(target.endpoint, env);

			// Register a pending entry whose promise the receiver-side handleResponse
			// (or the timeout below) will settle.
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			let rejectFn!: (e: Error) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res, rej) => {
				resolveFn = res;
				rejectFn = rej;
			});
			const entry: PendingReply = {
				resolve: resolveFn,
				reject: rejectFn,
				timer: null,
				promise,
				target_name: target.name,
				created_at: nowIso(),
			};
			entry.timer = setTimeout(() => {
				if (entry.result) return;
				entry.result = { error: "timeout" };
				try { entry.resolve(entry.result); } catch { /* ignore */ }
				// Clean up timed-out entry
				setTimeout(() => { pendingReplies.delete(msg_id); }, 60_000).unref();
			}, TIMEOUT_MS);
			// Don't keep the event loop alive solely for this timer.
			try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
			pendingReplies.set(msg_id, entry);

			try {
				pi.appendEntry("coms-log", {
					event: "outbound_prompt",
					msg_id,
					target: target.name,
					hops,
				});
			} catch {
				// best-effort
			}

			return {
				content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nhops ${hops}` }],
				details: { msg_id, target: target.name, target_session: target.session_id, hops },
			};
		},
		renderCall(args, theme) {
			const tgt = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_send ")) +
				theme.fg("accent", tgt) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", "→ ") +
				theme.fg("accent", d.target) +
				theme.fg("dim", `  msg_id `) +
				theme.fg("warning", d.msg_id),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "coms_get",
		label: "Coms Get",
		description:
			"Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
		}),
		async execute(_callId, params) {
			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_get: unknown msg_id ${params.msg_id}` }],
					details: { status: "error", error: "unknown msg_id" },
				};
			}
			if (entry.result) {
				const r = entry.result;
				const text = r.error
					? `coms_get: error — ${r.error}`
					: `coms_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status: "complete", response: r.response, error: r.error ?? null },
				};
			}
			return {
				content: [{ type: "text" as const, text: `coms_get: pending` }],
				details: { status: "pending" },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const status = d?.status ?? "?";
			const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	// ━━ agent_end: capture turn output and dispatch response back ━━━━━━━━

	pi.on("agent_end", async (_event, ctx) => {
		if (!currentInbound || !identity) {
			// Drain any orphaned inbounds — can't send responses without identity,
			// but must clear the queue to prevent permanent buildup
			if (!identity) {
				for (const [id, ib] of inboundQueue) {
					ib.fulfilled = true;
					inboundQueue.delete(id);
				}
				currentInbound = null;
			}
			processingInbound = false;
			return;
		}
		const inbound = currentInbound;

		// Walk the session branch for the most recent assistant message text.
		let lastAssistantText = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as any;
				if (typeof m.content === "string") {
					lastAssistantText = m.content;
				} else if (Array.isArray(m.content)) {
					lastAssistantText = m.content
						.filter((b: any) => b && b.type === "text")
						.map((b: any) => b.text)
						.join("\n");
				}
			}
		}

		let payload: any = lastAssistantText;
		let error: string | null = null;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			try {
				payload = JSON.parse(lastAssistantText);
			} catch {
				error = "response not valid JSON";
				payload = null;
			}
		}

		const respEnv: ResponseEnvelope = {
			type: "response",
			msg_id: inbound.msg_id,
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
			response: payload,
			error,
		};

		try {
			await sendEnvelope(inbound.sender_endpoint, respEnv);
			try {
				pi.appendEntry("coms-log", {
					event: "outbound_response",
					msg_id: inbound.msg_id,
					error,
				});
			} catch { /* best-effort */ }
		} catch (e: any) {
			try {
				pi.appendEntry("coms-log", {
					event: "outbound_response_failed",
					msg_id: inbound.msg_id,
					reason: e?.message ?? String(e),
				});
			} catch { /* best-effort */ }
		}

		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		maybeRefreshWidget();
		currentInbound = null;

		// FIFO drain: pick the next queued (oldest unfulfilled) inbound
		const next = [...inboundQueue.values()].find((i) => !i.fulfilled);
		if (next) {
			currentInbound = next;
			try {
				pi.sendMessage(
					{
						customType: "coms-inbound",
						content: buildInboundContent(`[from ${next.sender_name} @ ${next.sender_cwd}]`, next.prompt, next.tasks),
						display: true,
						details: {
							msg_id: next.msg_id,
							sender_session: next.sender_session,
							response_schema: next.response_schema ?? null,
						},
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch (err: any) {
				// Failed to inject — drain ALL remaining queued messages with error responses
				try { pi.appendEntry("coms-log", { event: "fifo_drain_failed", msg_id: next.msg_id, reason: err?.message ?? String(err) }); } catch { /* best-effort */ }
				const remaining = [next, ...[...inboundQueue.values()].filter(i => !i.fulfilled && i.msg_id !== next.msg_id)];
				for (const orphan of remaining) {
					try {
						await sendEnvelope(orphan.sender_endpoint, {
							type: "response",
							msg_id: orphan.msg_id,
							sender_session: identity!.session_id,
							sender_endpoint: identity!.endpoint,
							hops: 0,
							timestamp: nowIso(),
							response: null,
							error: "injection_failed",
						});
					} catch { /* best-effort */ }
					orphan.fulfilled = true;
					inboundQueue.delete(orphan.msg_id);
				}
				currentInbound = null;
				processingInbound = false;
			}
		} else {
			processingInbound = false;
		}
	});

	// ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.registerCommand("coms", {
		description: "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (trimmed.includes("--all")) {
				includeExplicit = !includeExplicit;
				try { ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
			}
			const projectMatch = trimmed.match(/--project\s+(\S+)/);
			if (projectMatch) {
				displayProject = projectMatch[1];
				try { ctx.ui.notify(`coms: displaying project ${displayProject}`, "info"); } catch { /* ignore */ }
			}
			await refreshPool();
		},
	});

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
		if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
		if (server) {
			try { server.close(); } catch { /* ignore */ }
			server = null;
		}
		if (cardUpdateTimer) {
			clearInterval(cardUpdateTimer);
			cardUpdateTimer = null;
		}
		if (pingWorker) {
			try { pingWorker.postMessage({ type: "shutdown" }); } catch {}
			pingWorker = null;
			pingWorkerReady = false;
		}
		if (identity) {
			if (process.platform !== "win32") {
				try { fs.unlinkSync(identity.endpoint); } catch { /* ignore */ }
			}
			try { removeRegistryEntry(identity.project, identity.session_id); } catch { /* ignore */ }
			try {
				pi.appendEntry("coms-log", { event: "shutdown", session_id: identity.session_id });
			} catch { /* best-effort */ }
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
		}
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
