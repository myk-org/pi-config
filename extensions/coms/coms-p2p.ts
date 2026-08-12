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
import { ulid, hexFg, isValidHex, fallbackColor, comsParseYamlFrontmatter as parseFrontmatter, nowIso, abbreviateModel, findSystemPromptPath, readFrontmatterFromArgv, readTaskSummary, buildInboundContent, renderTasksPart, renderQueuePart, formatQueueStr, formatComsResponseText, formatComsResponseType, formatComsResponseBody, formatComsInboundType, sanitizeComsName, createComsInboundTasks, FALLBACK_PALETTE, type TasksSummary } from "./coms-shared.js";
import { openListDetailOverlay, OverlayScrollDetail } from "../orchestrator/overlay-dashboard.js";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { getSetting } from "../orchestrator/project-settings.js";
import { createLogger } from "../shared/logger.js";
import { setLogFilePrefix } from "../shared/file-logger.js";
import { probeStaleSocket } from "./probe-socket.js";
import { isUserMessageDuringInbound, computeMixedTurn } from "./mixed-turn.js";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const log = createLogger("coms");
let COMS_DIR = path.join(os.homedir(), ".pi", "coms");
let MAX_HOPS = 5;

let TIMEOUT_MS = 1_800_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const LINE_CAP_BYTES = 64 * 1024;


// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "response" | "ping" | "task_update" | "queue_manage" | "task_manage" | "presence";

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
	queued_msg_ids?: string[];
	your_pending?: Array<{ msg_id: string; preview: string }>;
}

interface PingEnvelope extends Envelope {
	type: "ping";
}

interface TaskUpdateEnvelope extends Envelope {
	type: "task_update";
	task_id: string;
	subject: string;
	status: string;
	sender_name: string;
}

interface QueueManageEnvelope extends Envelope {
	type: "queue_manage";
	action: "delete" | "edit" | "clear" | "prioritize";
	target_msg_id?: string;
	new_content?: string;
	sender_name: string;
}

interface TaskManageEnvelope extends Envelope {
	type: "task_manage";
	action: "create" | "update" | "delete" | "list" | "get";
	sender_name: string;
	subject?: string;
	description?: string;
	metadata?: Record<string, any>;
	task_id?: string;
	fields?: any;
}

interface PresenceEnvelope extends Envelope {
	type: "presence";
	status: "leaving";
	sender_name: string;
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
	coms_session_id: string;
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
	pi_session_id?: string;
}

interface PendingReply {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: any; error?: string | null; queued_msg_ids?: string[] }>;
	result?: { response?: any; error?: string | null; queued_msg_ids?: string[] };
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
	/** How many times this inbound was re-injected due to mixed-turn conflict */
	mixedTurnRetries?: number;
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
	const final = registryFilePath(project, entry.coms_session_id);
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
			if (parsed && typeof parsed.coms_session_id === "string") {
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

async function pruneDeadEntries(project: string, cwd = process.cwd()): Promise<RegistryEntry[]> {
	const entries = readAllRegistryEntries(project);
	const socketsDir = path.join(COMS_DIR, "sockets");

	// Phase 1: Sync pre-filter (fast — no I/O)
	const candidates: RegistryEntry[] = [];
	const youngEntries: RegistryEntry[] = [];
	for (const entry of entries) {
		if (!entry.endpoint || typeof entry.endpoint !== "string") {
			removeRegistryEntry(project, entry.coms_session_id);
			continue;
		}
		// On Windows, endpoints are named pipes — fs.existsSync doesn't apply
		if (process.platform !== "win32" && !fs.existsSync(entry.endpoint)) {
			removeRegistryEntry(project, entry.coms_session_id);
			continue;
		}
		// Skip entries younger than 30s — recently booted peers get grace period
		const entryAge = Date.now() - new Date(entry.heartbeat_at ?? entry.started_at ?? "").getTime();
		if (!isNaN(entryAge) && entryAge < getSetting(cwd, "coms_entry_grace_period_ms")) {
			log.debug("prune_skip_grace", entry.name, "age_ms", entryAge);
			youngEntries.push(entry);
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
				removeRegistryEntry(project, entry.coms_session_id);
				continue;
			}
		} else {
			removeRegistryEntry(project, entry.coms_session_id);
			continue;
		}
		candidates.push(entry);
	}

	// Phase 2: Parallel socket probes (capped at 10 concurrent to avoid EMFILE)
	if (candidates.length === 0) {
		log.debug("prune_complete", "checked", entries.length);
		return youngEntries;
	}
	const PROBE_CONCURRENCY = 10;
	const results: ("in_use" | "stale")[] = [];
	for (let start = 0; start < candidates.length; start += PROBE_CONCURRENCY) {
		const batch = candidates.slice(start, start + PROBE_CONCURRENCY);
		const batchResults = await Promise.allSettled(batch.map(entry => probeStaleSocket(entry.endpoint, entry.name, cwd)));
		results.push(...batchResults.map(r => r.status === "fulfilled" ? r.value : "in_use" as const));
	}
	const live: RegistryEntry[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (results[i] === "stale") {
			const entry = candidates[i];
			removeRegistryEntry(project, entry.coms_session_id);
			// Do NOT delete socket files — they belong to the peer process.
			// Only the owning peer should manage its own socket.
			// If the peer is alive, it will self-heal its registry.
		} else {
			live.push(candidates[i]);
		}
	}
	log.debug("prune_complete", "checked", entries.length);
	return [...live, ...youngEntries];
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
		out.push(...await pruneDeadEntries(p, process.cwd()));
	}
	return out;
}

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Strict liveness probe — only returns "alive" on actual successful TCP connect.
 * Unlike probeStaleSocket which treats transient errors as "in_use" (safe for
 * pruning decisions), this function treats ANY error as "dead" (safe for
 * duplicate-name rejection where false positives block startup).
 */
function probeAlive(endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (alive: boolean) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(alive);
		};
		const timer = setTimeout(() => finish(false), 500);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish(true);
		});
		sock.once("error", () => {
			clearTimeout(timer);
			finish(false);
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
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
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
		coms_session_id: string;
		name: string;
		purpose: string;
		color: string;
		project: string;
		explicit: boolean;
		cwd: string;
		model: string;
		endpoint: string;
		registryFile: string;
		pi_session_id: string;
	} | null = null;
	const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
	let welcomeShown = false;
	const knownPeerSessions: Map<string, string> = new Map(); // session_id → name
	const accumulatedResponses: Map<string, string[]> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	/** Track pending (unresponded) outbound msg_ids per target name. */
	const pendingOutbound: Map<string, Set<string>> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	let server: net.Server | null = null;
	let fsWatcher: fs.FSWatcher | null = null;
	let pingWorker: Worker | null = null;
	let pingWorkerReady = false;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	let includeExplicit = false;
	let displayProject: string | null = null;
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	let bundledInbounds: InboundContext[] = [];
	let processingInbound = false;
	/** True when the agent is running a turn NOT triggered by a coms inbound.
	 *  Set on agent_start, cleared on agent_end. Only true for user-initiated turns. */
	let agentRunningUserTurn = false;
	/** True when currentInbound was set while the agent was running a user turn (#731). */
	let inboundSetDuringUserTurn = false;
	/** True when a real user message landed during an inbound turn (#741). */
	let userMessageDuringInbound = false;
	const comsSendCalledThisTurn: Set<string> = new Set();

	function getPendingInboundCount(): number {
		let count = 0;
		for (const i of inboundQueue.values()) if (!i.fulfilled && i !== currentInbound) count++;
		return count;
	}

	/** Get pending messages from a specific sender still in our queue. */
	function getSenderPending(senderSession: string, excludeMsgId: string): Array<{ msg_id: string; preview: string }> {
		const result: Array<{ msg_id: string; preview: string }> = [];
		for (const ib of inboundQueue.values()) {
			if (ib.sender_session === senderSession && !ib.fulfilled && ib.msg_id !== excludeMsgId) {
				result.push({ msg_id: ib.msg_id, preview: ib.prompt.slice(0, 80) });
			}
		}
		// Re-verify: filter out any entries removed between scan and return
		const filtered = result.filter(r => { const ib = inboundQueue.get(r.msg_id); return ib && !ib.fulfilled; });
		log.debug("getSenderPending", "sender", senderSession, "found", filtered.length);
		return filtered;
	}

	let lastPoolSnapshot = "";
	function maybeRefreshWidget(): void {
		if (!currentCtx?.hasUI) return;
		const pc = getPendingInboundCount();
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

			log.debug("inbound_queued", env.msg_id, "from", env.sender_name, "depth", getPendingInboundCount());
			return;
		}

		// 4. Not busy — inject immediately.
		// If the agent is already running (user turn), this inbound arrives
		// mid-turn via followUp — mark as mixed turn for agent_end (#731).
		inboundSetDuringUserTurn = agentRunningUserTurn;
		currentInbound = inbound;
		processingInbound = true;
		try {
			pi.sendMessage(
				{
					customType: formatComsInboundType(env.sender_name, sanitizeComsName(identity?.name ?? "?"), env.sender_cwd),
					content: buildInboundContent("", env.prompt, env.tasks, env.sender_name, env.sender_cwd),
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
			const errIb = inboundQueue.get(env.msg_id);
			if (errIb) errIb.fulfilled = true;
			inboundQueue.delete(env.msg_id);
			maybeRefreshWidget();
			currentInbound = null;
			processingInbound = false;
			nack(socket, env.msg_id, "internal error");
			return;
		}

		// 5. Ack + audit log
		ackOk(socket, env.msg_id);

		log.debug("inbound_prompt", env.msg_id, "from", env.sender_name, "hops", env.hops);
	}

	function handleResponse(socket: net.Socket, env: ResponseEnvelope): void {
		const pending = pendingReplies.get(env.msg_id);
		// Clean up pending outbound tracking
		if (pending?.target_name) {
			const set = pendingOutbound.get(pending.target_name);
			if (set) { set.delete(env.msg_id); if (set.size === 0) pendingOutbound.delete(pending.target_name); }
		}
		if (pending) {
			if (pending.timer) {
				try { clearTimeout(pending.timer); } catch { /* ignore */ }
				pending.timer = null;
			}
			const queuedMsgIds: string[] = Array.isArray(env.queued_msg_ids) ? env.queued_msg_ids.filter((id: unknown) => typeof id === "string") : [];
			pending.result = { response: env.response, error: env.error ?? null, queued_msg_ids: queuedMsgIds };
			try {
				pending.resolve(pending.result);
			} catch (e: any) {
				log.error("resolve_failed", env.msg_id, e?.message);
			}
			log.debug("handleResponse", env.msg_id, "from", env.sender_session.slice(-8), "error", env.error ?? "none");

			// Skip display for bundled/cleared responses — not user-visible
			if (env.error === "bundled" || env.error === "queue_cleared") {
				setTimeout(() => { pendingReplies.delete(env.msg_id); }, 60_000).unref();
				return;
			}

			// Auto-deliver response as followUp so the LLM sees it without polling
			const targetName = pending.target_name ?? "peer";
			const selfName = sanitizeComsName(identity?.name ?? "?");
			const responseType = formatComsResponseType(targetName, selfName, queuedMsgIds);
			let responseBody = formatComsResponseBody(env.response, env.error ?? null);
			const yourPending = Array.isArray(env.your_pending) ? env.your_pending : [];
			if (yourPending.length > 0) {
				responseBody += `\n\nPeer still has ${yourPending.length} of your messages queued:\n` +
					yourPending.filter((p: any) => p && typeof p === "object").map((p: any, i: number) => `  ${i + 1}. [${p.msg_id ?? "?"}] "${p.preview ?? ""}…"`).join("\n");
			}
			try {
				pi.sendMessage(
					{
						customType: responseType,
						content: responseBody,
						display: true,
						details: {
							msg_id: env.msg_id,
							target_name: targetName,
							error: env.error ?? null,
							queued_msg_ids: queuedMsgIds,
						},
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch { /* best-effort */ }

			// Clean up immediately since response was delivered
			setTimeout(() => { pendingReplies.delete(env.msg_id); }, 60_000).unref();
		} else {
			log.warn("orphan_response", env.msg_id);
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
			queue_depth: getPendingInboundCount(),
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
			log.debug("envelope_received", parsed.type, parsed.msg_id?.slice(-8) ?? "?");
			try {
				if (parsed.type === "prompt") {
					handlePrompt(socket, parsed as PromptEnvelope);
				} else if (parsed.type === "response") {
					handleResponse(socket, parsed as ResponseEnvelope);
				} else if (parsed.type === "ping") {
					handlePing(socket, parsed as PingEnvelope);
				} else if (parsed.type === "task_update") {
					handleTaskUpdate(socket, parsed as TaskUpdateEnvelope);
				} else if (parsed.type === "queue_manage") {
					handleQueueManage(socket, parsed as QueueManageEnvelope);
				} else if (parsed.type === "task_manage") {
					handleTaskManage(socket, parsed as TaskManageEnvelope);
				} else if (parsed.type === "presence") {
					handlePresence(socket, parsed as PresenceEnvelope);
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

	// ━━ presence handler ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function handlePresence(socket: net.Socket, env: PresenceEnvelope): void {
		ackOk(socket, env.msg_id);
		if (env.status === "leaving" && env.sender_name) {
			for (const [sid, card] of peerCards.entries()) {
				if (card.name === env.sender_name) {
					peerCards.delete(sid);
					// Also clean up knownPeerSessions and fire notification
					if (knownPeerSessions.has(sid)) {
						knownPeerSessions.delete(sid);
						log.debug("presence_leaving_received", "from", env.sender_name);
						try {
							pi.sendMessage({ customType: "coms-peer-left", content: `📡 Peer left: ${card.name} [${new Date().toISOString()}]`, display: true }, { triggerTurn: false });
							try { pi.events.emit("pidash:coms-peer-event", { customType: "coms-peer-left", content: `📡 Peer left: ${card.name} [${new Date().toISOString()}]` }); } catch {}
						} catch {}
					}
					break;
				}
			}
			maybeRefreshWidget();
		}

		log.debug("presence", env.status, "from", env.sender_name);
	}

	// ━━ task_update handler ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function handleTaskUpdate(socket: net.Socket, env: TaskUpdateEnvelope): void {
		ackOk(socket, env.msg_id);
		log.debug("task_update_in", env.task_id, env.status, "from", env.sender_name);
	}

	// ━━ queue_manage handler ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Only the message OWNER (sender_session match) can manage their messages.
	function handleQueueManage(socket: net.Socket, env: QueueManageEnvelope): void {
		const action = env.action;
		let affected = 0;
		let error: string | null = null;

		/** Check if an inbound is eligible (pending, not processing, owned by sender). */
		const isOwned = (ib: InboundContext): boolean =>
			!ib.fulfilled
			&& !(currentInbound && ib.msg_id === currentInbound.msg_id)
			&& ib.sender_session === env.sender_session;

		/** Fulfill and remove a queued inbound, sending error response. */
		const dropInbound = (ib: InboundContext): void => {
			ib.fulfilled = true;
			inboundQueue.delete(ib.msg_id);
			if (identity) {
				sendEnvelope(ib.sender_endpoint, {
					type: "response", msg_id: ib.msg_id,
					sender_session: identity.coms_session_id, sender_endpoint: identity.endpoint,
					hops: 0, timestamp: nowIso(),
					response: null, error: "queue_cleared",
					queued_msg_ids: [],
				}).catch(() => { /* best-effort */ });
			}
		};

		if (action === "delete" && env.target_msg_id) {
			const ib = inboundQueue.get(env.target_msg_id);
			if (!ib) { error = "not_found"; }
			else if (!isOwned(ib)) { error = "not_owned"; }
			else { dropInbound(ib); affected++; }
		} else if (action === "edit" && env.target_msg_id && typeof env.new_content === "string") {
			const ib = inboundQueue.get(env.target_msg_id);
			if (!ib) { error = "not_found"; }
			else if (!isOwned(ib)) { error = "not_owned"; }
			else { ib.prompt = env.new_content; affected++; }
		} else if (action === "clear") {
			for (const ib of [...inboundQueue.values()]) {
				if (isOwned(ib)) { dropInbound(ib); affected++; }
			}
		} else if (action === "prioritize" && env.target_msg_id) {
			const ib = inboundQueue.get(env.target_msg_id);
			if (!ib) { error = "not_found"; }
			else if (!isOwned(ib)) { error = "not_owned"; }
			else {
				inboundQueue.delete(ib.msg_id);
				const entries = [...inboundQueue.entries()];
				inboundQueue.clear();
				inboundQueue.set(ib.msg_id, ib);
				for (const [k, v] of entries) inboundQueue.set(k, v);
				affected++;
			}
		} else {
			error = "invalid_action";
		}

		// Send ack with result — includes error and affected count
		try {
			socket.write(JSON.stringify({ type: "ack", msg_id: env.msg_id, affected, error }) + "\n");
		} catch { /* ignore */ }

		maybeRefreshWidget();
		log.debug("queue_manage", action, "target", env.target_msg_id, "affected", affected, "error", error);
	}

	// ━━ task_manage handler — remote task operations from peers ━━━━━━━━━━━
	async function handleTaskManage(socket: net.Socket, env: TaskManageEnvelope): Promise<void> {
		ackOk(socket, env.msg_id);
		let result: any = null;
		let error: string | null = null;

		try {
			const { createTask, getTask, listTasks, updateTask, deleteTask } = await import("../pitasks/index.js");
			switch (env.action) {
				case "create":
					if (env.subject) result = createTask(env.subject, env.description ?? "", env.metadata);
					else error = "missing subject";
					break;
				case "get":
					if (env.task_id) result = getTask(env.task_id);
					else error = "missing task_id";
					break;
				case "list":
					result = listTasks();
					break;
				case "update":
					if (env.task_id && env.fields) {
						const t = getTask(env.task_id);
						if (t?.createdBy?.session === env.sender_session) {
							result = updateTask(env.task_id, env.fields);
						} else {
							error = "ownership_denied — can only update tasks you created";
						}
					} else error = "missing task_id or fields";
					break;
				case "delete":
					if (env.task_id) {
						const t = getTask(env.task_id);
						if (t?.createdBy?.session === env.sender_session) {
							result = deleteTask(env.task_id);
						} else {
							error = "ownership_denied — can only delete tasks you created";
						}
					} else error = "missing task_id";
					break;
				default:
					error = `unknown action: ${env.action}`;
			}
		} catch (e: any) {
			error = e?.message ?? String(e);
		}

		// Send response back to sender
		if (identity) {
			try {
				await sendEnvelope(env.sender_endpoint, {
					type: "response",
					msg_id: env.msg_id,
					sender_session: identity.coms_session_id,
					sender_endpoint: identity.endpoint,
					hops: 0,
					timestamp: nowIso(),
					response: result,
					error,
					queued_msg_ids: [],
				});
			} catch { /* best-effort */ }
		}
		log.debug("task_manage", env.action, "from", env.sender_name, "error", error);
	}

	// ━━ tool_result: send task heartbeat to coms originator (#731) ━━━━━━━━
	pi.on("tool_result", async (event: any, ctx) => {
		if (!identity) return;
		const toolName = event?.toolName as string;
		if (toolName !== "TaskUpdate") return;
		const input = event?.input || {};
		const taskId = input.taskId as string;
		const newStatus = input.status as string;
		if (!taskId || !newStatus) return;

		// Look up the task to check if created by a coms peer
		try {
			const { getComsOriginTask } = await import("./coms-shared.js");
			const task = await getComsOriginTask(taskId);
			if (!task?.createdBy) return;
			const origin = task.createdBy;
			if (!origin.endpoint) return;

			const env: TaskUpdateEnvelope = {
				type: "task_update",
				msg_id: ulid(),
				sender_session: identity.coms_session_id,
				sender_endpoint: identity.endpoint,
				hops: 0,
				timestamp: nowIso(),
				task_id: taskId,
				subject: task.subject ?? "",
				status: newStatus,
				sender_name: identity.name,
			};
			await sendEnvelope(origin.endpoint, env);
			log.debug("task_update_out", taskId, newStatus, "to", origin.name);
		} catch { /* best-effort — don't block tool_result */ }
	});

	// ━━ task heartbeat keepalive timer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let taskHeartbeatTimer: NodeJS.Timeout | null = null;

	// ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;
		shuttingDown = false;
		peerCards.clear();
		welcomeShown = false;
		knownPeerSessions.clear();
		accumulatedResponses.clear();

		// 1. Resolve identity from CLI flags > frontmatter > defaults.
		const flags = readCliFlags(pi);
		const fm = readFrontmatterFromArgv(process.argv);
		const project = flags.project || "default";
		const explicit = flags.explicit === true;
		const comsSessionId = (globalThis as any).__piConfigSessionId || ulid();

		const defaultName = `agent-${comsSessionId.slice(-6)}`;
		const name = flags.name || fm.name || defaultName;
		const purpose = flags.purpose || fm.description || "";

		// Color: validate at every level; fall through invalid hex to next.
		// Order: --color CLI flag > frontmatter color > deterministic fallback.
		let color = fallbackColor(comsSessionId);
		if (fm.color && isValidHex(fm.color)) {
			color = fm.color;
		}
		if (flags.color && isValidHex(flags.color)) {
			color = flags.color;
		}

		const cwd = ctx.cwd || process.cwd();

		// Resolve coms settings from project settings
		COMS_DIR = getSetting(cwd, "coms_dir") || path.join(os.homedir(), ".pi", "coms");
		MAX_HOPS = getSetting(cwd, "coms_max_hops");
		TIMEOUT_MS = getSetting(cwd, "coms_timeout_ms");
		const TASK_HEARTBEAT_MS: number = getSetting(cwd, "coms_task_heartbeat_ms") ?? 300_000;

		const endpoint = makeEndpoint(comsSessionId);
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
			if (existing.name === name && existing.coms_session_id !== comsSessionId) {
				// Verify the existing peer is actually alive via .ping endpoint.
				if (typeof existing.endpoint === "string" && existing.endpoint) {
					const pingEp = `${existing.endpoint}.ping`;
					const hasPing = process.platform === "win32" || fs.existsSync(pingEp);
					const hasMain = process.platform === "win32" || fs.existsSync(existing.endpoint);

					// Use strict probe — only "alive" on actual TCP connect.
					// Transient errors (EMFILE, EACCES) resolve to false, not blocking startup.
					let alive = false;
					if (hasPing) {
						alive = await probeAlive(pingEp);
					}
					if (!alive && hasMain) {
						alive = await probeAlive(existing.endpoint);
					}

					if (alive) {
						throw new Error(
							`name "${name}" is already taken by a live peer. ` +
							`Use --cname to pick a different name, or stop the other peer first.`
						);
					}

					if (!hasPing && !hasMain) {
						// No socket files at all — definitely dead
						removeRegistryEntry(project, existing.coms_session_id);
					} else {
						// Probe(s) returned stale — remove registry, peer is dead
						removeRegistryEntry(project, existing.coms_session_id);
					}
				} else {
					// No valid endpoint — remove stale entry
					removeRegistryEntry(project, existing.coms_session_id);
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
				if (msg.type === "error") log.warn("ping_worker_error", msg.message);
			});
			pingWorker.on("error", () => { pingWorkerReady = false; });
			pingWorker.on("exit", () => { pingWorkerReady = false; pingWorker = null; });
		} catch (err) {
			log.warn("ping_worker_start_failed", err instanceof Error ? err.message : String(err));
		}

		// 4. Build + write registry entry atomically.
		const piSessionId = (globalThis as any).__piConfigSessionId || "";
		const entry: RegistryEntry = {
			coms_session_id: comsSessionId,
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
			pi_session_id: piSessionId,
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
			coms_session_id: comsSessionId,
			name,
			purpose,
			color,
			project,
			explicit,
			cwd,
			model,
			endpoint,
			registryFile,
			pi_session_id: piSessionId,
		};
		includeExplicit = false;
		displayProject = project;

		// 5. Audit log: boot.
		setLogFilePrefix("coms", identity.name);
		try { pi.events.emit("pidash:coms-identity", { name: identity.name, purpose: identity.purpose || "", project: identity.project || "" }); } catch {}
		log.info("boot", name, project);

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

		// 7. Start timers (skip in one-shot modes).
		if (ctx.mode !== "print" && ctx.mode !== "json") {

		// Seed peerCards from existing registry entries
		const existingPeers = readAllRegistryEntries(project);
		for (const entry of existingPeers) {
			if (entry.coms_session_id === identity.coms_session_id) continue;
			if (entry.explicit && !includeExplicit) continue;
			peerCards.set(entry.coms_session_id, {
				name: entry.name,
				purpose: entry.purpose,
				model: entry.model,
				color: entry.color,
				context_used_pct: entry.context_used_pct ?? 0,
				queue_depth: entry.queue_depth ?? 0,
				tasks_summary: null,
				staleCount: 0,
			});
			knownPeerSessions.set(entry.coms_session_id, entry.name);
		}
		log.info("boot_seed", "peers", peerCards.size);
		if (peerCards.size > 0) {
			maybeRefreshWidget();
		}

		// Show welcome if peers found — reusable so the FIRST peer (who booted
		// with no peers) still gets it retroactively when a peer later joins.
		const showWelcomeIfNeeded = () => {
			if (welcomeShown || !identity) return;
			welcomeShown = true;
			const peerList = peerCards.size > 0
				? [...peerCards.values()]
					.map(card => `● ${card.name} (${card.model})${card.purpose ? ` — ${card.purpose}` : ""}`)
					.join("\n")
				: "(none yet — you are the first peer)";
			const welcomeMsg = `📡 Connected to coms · You are "${identity.name}" on project "${identity.project}"

## How to reply
- Your assistant text IS your reply — auto-captured when your turn ends

## Available tools
- coms_list — see connected peers
- coms_send — send a message to a peer
- coms_get — check status of a sent message
- coms_queue_delete / coms_queue_edit / coms_queue_clear / coms_queue_prioritize — manage queued messages
- coms_tasks_create — create tasks on a peer's task list with auto-report and auto-message
- coms_task_delete — delete a task you created on a peer's task list
- coms_task_list — list tasks on a peer's task list without sending a message
- coms_task_get — get a specific task from a peer's task list
- coms_task_update — update a task you created on a peer's task list

## Task handling
- Tasks may appear in your task widget at any time — check TaskList when prompted to work
- When you receive a message to start working, check TaskList first for assigned tasks
- Work through tasks in order using TaskUpdate to mark progress
- Report completion back to the sender when all tasks are done
- If a task is too large, break it into subtasks
- The last task in your list will always be "Report completion to sender" — it's blocked by all other tasks. When all tasks are done, use coms_send to report back.

## Connected peers
${peerList}
Do not respond to this message.`;

			// Seed knownPeerSessions for every current peer so the retroactive
			// welcome does not also trigger duplicate "peer joined" cards.
			for (const [sid, card] of peerCards) knownPeerSessions.set(sid, card.name);

			log.info("welcome_shown", "peers", peerCards.size);
			log.debug("welcome_trigger_turn", peerCards.size > 0);
			try {
				pi.sendMessage({
					customType: "coms-welcome",
					content: welcomeMsg,
					display: true,
				}, { triggerTurn: peerCards.size > 0 });
			} catch {}
		};

		// Show welcome if peers found on boot
		showWelcomeIfNeeded();

		// Watch registry directory for peer changes (fs.watch)
		const agentsDir = projectAgentsDir(project);
		try {
			fsWatcher = fs.watch(agentsDir, (eventType, filename) => {
				log.debug("fs_watch_event", eventType, filename);
				if (!filename || !filename.endsWith(".json") || filename.endsWith(".tmp")) return;
				if (!identity || shuttingDown) return;
				const filePath = path.join(agentsDir, filename);
				const sessionId = filename.replace(".json", "");
				if (sessionId === identity.coms_session_id) return;

				if (eventType === "rename") {
					if (fs.existsSync(filePath)) {
						try {
							const entry = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RegistryEntry;
							if (entry && entry.coms_session_id && entry.endpoint) {
								if (peerCards.has(entry.coms_session_id)) {
									// Existing peer — update card (heartbeat via atomic rename)
									const existing = peerCards.get(entry.coms_session_id)!;
									existing.context_used_pct = entry.context_used_pct ?? existing.context_used_pct;
									existing.queue_depth = entry.queue_depth ?? existing.queue_depth;
									existing.model = entry.model ?? existing.model;
									existing.staleCount = 0;
									log.debug("fs_watch_heartbeat_rename", entry.name, "ctx", entry.context_used_pct);
								} else {
									// New peer
									const card: AgentCard & { staleCount: number } = {
										name: entry.name, purpose: entry.purpose, model: entry.model,
										color: entry.color, context_used_pct: entry.context_used_pct ?? 0,
										queue_depth: entry.queue_depth ?? 0, tasks_summary: null, staleCount: 0,
									};
									peerCards.set(entry.coms_session_id, card);
									log.info("fs_watch_peer_added", entry.name, entry.coms_session_id);
									maybeRefreshWidget();
									if (!welcomeShown) {
										log.debug("welcome_retroactive", entry.name);
										showWelcomeIfNeeded();
									}
									if (welcomeShown && !knownPeerSessions.has(entry.coms_session_id)) {
										knownPeerSessions.set(entry.coms_session_id, entry.name);
										try { pi.sendMessage({ customType: "coms-peer-joined", content: `📡 Peer joined: ${entry.name} (${entry.model})${entry.purpose ? ` — ${entry.purpose}` : ""} [${new Date().toISOString()}]`, display: true }, { triggerTurn: false }); } catch {}
										try { pi.events.emit("pidash:coms-peer-event", { customType: "coms-peer-joined", content: `📡 Peer joined: ${entry.name} (${entry.model})${entry.purpose ? ` — ${entry.purpose}` : ""} [${new Date().toISOString()}]` }); } catch {}
									}
								}
							}
						} catch {}
					} else {
						if (peerCards.has(sessionId)) {
							const card = peerCards.get(sessionId);
							peerCards.delete(sessionId);
							log.info("fs_watch_peer_removed", card?.name ?? sessionId);
							maybeRefreshWidget();
							if (knownPeerSessions.has(sessionId)) {
								const name = knownPeerSessions.get(sessionId) ?? sessionId;
								knownPeerSessions.delete(sessionId);
								const sameNameStillExists = [...peerCards.values()].some(c => c.name === name);
								if (!sameNameStillExists) {
									try { pi.sendMessage({ customType: "coms-peer-left", content: `📡 Peer left: ${name} [${new Date().toISOString()}]`, display: true }, { triggerTurn: false }); } catch {}
									try { pi.events.emit("pidash:coms-peer-event", { customType: "coms-peer-left", content: `📡 Peer left: ${name} [${new Date().toISOString()}]` }); } catch {}
								}
							}
						}
					}
				} else if (eventType === "change") {
					try {
						const entry = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RegistryEntry;
						if (entry && entry.coms_session_id && peerCards.has(entry.coms_session_id)) {
							const existing = peerCards.get(entry.coms_session_id)!;
							existing.context_used_pct = entry.context_used_pct ?? existing.context_used_pct;
							existing.queue_depth = entry.queue_depth ?? existing.queue_depth;
							existing.staleCount = 0;
							existing.model = entry.model ?? existing.model;
							log.debug("fs_watch_heartbeat", entry.name, "ctx", entry.context_used_pct);
						} else if (entry && entry.coms_session_id && !peerCards.has(entry.coms_session_id)) {
							const card: AgentCard & { staleCount: number } = {
								name: entry.name, purpose: entry.purpose, model: entry.model,
								color: entry.color, context_used_pct: entry.context_used_pct ?? 0,
								queue_depth: entry.queue_depth ?? 0, tasks_summary: null, staleCount: 0,
							};
							peerCards.set(entry.coms_session_id, card);
							log.info("fs_watch_peer_added_via_change", entry.name, entry.coms_session_id);
							maybeRefreshWidget();
							if (!welcomeShown) {
								log.debug("welcome_retroactive", entry.name);
								showWelcomeIfNeeded();
							}
							if (welcomeShown && !knownPeerSessions.has(entry.coms_session_id)) {
								knownPeerSessions.set(entry.coms_session_id, entry.name);
								try { pi.sendMessage({ customType: "coms-peer-joined", content: `📡 Peer joined: ${entry.name} (${entry.model})${entry.purpose ? ` — ${entry.purpose}` : ""} [${new Date().toISOString()}]`, display: true }, { triggerTurn: false }); } catch {}
								try { pi.events.emit("pidash:coms-peer-event", { customType: "coms-peer-joined", content: `📡 Peer joined: ${entry.name} (${entry.model})${entry.purpose ? ` — ${entry.purpose}` : ""} [${new Date().toISOString()}]` }); } catch {}
							}
						}
					} catch {}
				}
			});
			log.info("fs_watch_started", agentsDir);
		} catch (err) {
			log.error("fs_watch_failed", err instanceof Error ? err.message : String(err));
		}

		// Start task heartbeat keepalive timer (#731)
		if (taskHeartbeatTimer) { try { clearInterval(taskHeartbeatTimer); } catch { /* ignore */ } }
		taskHeartbeatTimer = setInterval(async () => {
			if (!identity || shuttingDown) return;
			try {
				const { getComsOriginTasks } = await import("./coms-shared.js");
				const tasks = await getComsOriginTasks();
				for (const task of tasks) {
					if (!task.createdBy.endpoint) continue;
					try {
						await sendEnvelope(task.createdBy.endpoint, {
							type: "task_update",
							msg_id: ulid(),
							sender_session: identity.coms_session_id,
							sender_endpoint: identity.endpoint,
							hops: 0,
							timestamp: nowIso(),
							task_id: task.taskId,
							subject: task.subject,
							status: task.status,
							sender_name: identity.name,
						});
					} catch {}
				}
			} catch {}
		}, TASK_HEARTBEAT_MS);
		try { (taskHeartbeatTimer as any).unref?.(); } catch {}

		// Keepalive — write registry heartbeat + socket self-heal
		keepaliveTimer = setInterval(async () => {
			if (!identity) return;
			if (shuttingDown) return;
			try {
				if (!shuttingDown && process.platform !== "win32" && !fs.existsSync(identity.endpoint)) {
					try {
						log.warn("self_heal_socket_missing", identity.coms_session_id, identity.endpoint);
						if (server) { try { server.close(); } catch {} server = null; }
						server = await bindEndpoint(identity.endpoint, connHandler);
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
								if (msg.type === "ready") { pingWorkerReady = true; updatePingWorkerCard(); }
								if (msg.type === "error") log.warn("ping_worker_error", msg.message);
							});
							pingWorker.on("error", () => { pingWorkerReady = false; });
							pingWorker.on("exit", () => { pingWorkerReady = false; pingWorker = null; });
						} catch {}
					} catch (err) {
						log.error("self_heal_socket_failed", identity.coms_session_id, err instanceof Error ? err.message : String(err));
					}
				}
				const ctx = currentCtx;
				const missingBeforeWrite = !fs.existsSync(identity.registryFile);
				const live: RegistryEntry = {
					coms_session_id: identity.coms_session_id,
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
					queue_depth: getPendingInboundCount(),
					heartbeat_at: nowIso(),
					pi_session_id: (globalThis as any).__piConfigSessionId || identity.pi_session_id || "",
				};
				writeRegistryAtomic(live, identity.project);
				if (missingBeforeWrite) {
					log.warn("self_heal_registry", identity.coms_session_id);
					if (!fs.existsSync(identity.registryFile)) {
						writeRegistryAtomic(live, identity.project);
					}
				}
				updatePingWorkerCard();
			} catch {}
		}, KEEPALIVE_INTERVAL_MS);
		try { (keepaliveTimer as any).unref?.(); } catch {}

		// Stale peer detection — runs every 60s, confirms with socket probe
		const STALE_THRESHOLD_MS = 90_000;
		const staleCheckTimer = setInterval(async () => {
			if (!identity || shuttingDown) return;
			for (const [sid, card] of peerCards.entries()) {
				if (sid === identity.coms_session_id) continue;
				const regFile = registryFilePath(identity.project, sid);
				try {
					const stat = fs.statSync(regFile);
					const age = Date.now() - stat.mtimeMs;
					if (age > STALE_THRESHOLD_MS) {
						log.debug("stale_check", card.name, "age", Math.round(age / 1000), "s");
						const entries = readAllRegistryEntries(identity.project);
						const entry = entries.find(e => e.coms_session_id === sid);
						if (entry?.endpoint) {
							const alive = await probeAlive(entry.endpoint);
							if (!alive) {
								log.info("stale_confirmed_dead", card.name, sid);
								peerCards.delete(sid);
								if (knownPeerSessions.has(sid)) {
									const name = knownPeerSessions.get(sid) ?? sid;
									knownPeerSessions.delete(sid);
									const sameNameStillExists = [...peerCards.values()].some(c => c.name === name);
									if (!sameNameStillExists) {
										try { pi.sendMessage({ customType: "coms-peer-left", content: `📡 Peer left: ${name} [${new Date().toISOString()}]`, display: true }, { triggerTurn: false }); } catch {}
										try { pi.events.emit("pidash:coms-peer-event", { customType: "coms-peer-left", content: `📡 Peer left: ${name} [${new Date().toISOString()}]` }); } catch {}
									}
								}
								removeRegistryEntry(identity.project, sid);
								maybeRefreshWidget();
							} else {
								log.debug("stale_but_alive", card.name, "resetting staleCount");
								card.staleCount = 0;
							}
						}
					}
				} catch {}
			}
		}, 60_000);
		log.debug("stale_check_timer_started", "interval", 60000, "threshold", STALE_THRESHOLD_MS);
		try { (staleCheckTimer as any).unref?.(); } catch {}

		} // end mode guard for timers
	});

	// ━━ Helpers used by tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	// ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function renderPool(width: number, theme: Theme): string[] {
		interface Row {
			name: string;
			model: string;
			color: string;
			purpose: string;
			pct: number | null;
			pending: boolean;
			stale: boolean;
			tasks?: { total: number; completed: number; in_progress: number } | null;
			queue_depth: number;
		}
		const rows: Row[] = [];

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.coms_session_id) continue;
			rows.push({
				name: card.name,
				model: card.model,
				color: card.color,
				purpose: card.purpose,
				pct: card.context_used_pct,
				pending: false,
				stale: (card.staleCount ?? 0) >= 3,
				tasks: card.tasks_summary,
				queue_depth: card.queue_depth ?? 0,
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
			const pendingCount = getPendingInboundCount();
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
			const queuePart = renderQueuePart(r.queue_depth, theme);
			const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + tasksPart + queuePart + sep + purposePart;
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
			const localEntries = await pruneDeadEntries(identity.project, process.cwd());
			// Try session_id match first (always unambiguous)
			const bySession = localEntries.find((e) => e.coms_session_id === target);
			if (bySession) { log.debug("resolveTarget", target, "→", bySession.name, "by_session"); return bySession; }
			// Name match — warn if ambiguous
			const byName = localEntries.filter((e) => e.name === target);
			if (byName.length === 1) { log.debug("resolveTarget", target, "→", byName[0].name, "by_name"); return byName[0]; }
			if (byName.length > 1) {
				// Ambiguous — sort deterministically: freshest heartbeat first, session_id tiebreaker
				byName.sort((a, b) => {
					const haRaw = a.heartbeat_at ? new Date(a.heartbeat_at).getTime() : 0;
					const hbRaw = b.heartbeat_at ? new Date(b.heartbeat_at).getTime() : 0;
					const ha = isNaN(haRaw) ? 0 : haRaw;
					const hb = isNaN(hbRaw) ? 0 : hbRaw;
					if (hb !== ha) return hb - ha; // freshest first
					return a.coms_session_id.localeCompare(b.coms_session_id); // stable tiebreak
				});
				log.warn("ambiguous_target", target, "matches", byName.length, "selected", byName[0].coms_session_id);
				return byName[0];
			}
		}
		// Fall back to scanning all projects by session_id.
		for (const proj of listProjects()) {
			const entries = await pruneDeadEntries(proj, process.cwd());
			const bySession = entries.find((e) => e.coms_session_id === target);
			if (bySession) return bySession;
		}
		// Fall back to name match across projects.
		for (const proj of listProjects()) {
			const entries = await pruneDeadEntries(proj, process.cwd());
			const byName = entries.find((e) => e.name === target);
			if (byName) return byName;
		}
		log.debug("resolveTarget", target, "→ not_found");
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

			// Read from peerCards — no pinging needed
			const agents = [...peerCards.entries()]
				.filter(([sid]) => identity && sid !== identity.coms_session_id)
				.map(([sid, card]) => ({
					name: card.name,
					session_id: sid,
					purpose: card.purpose,
					model: card.model,
					cwd: "",
					project: identity?.project ?? "default",
					alive: true,
					context_used_pct: card.context_used_pct,
					queue_depth: card.queue_depth ?? 0,
					color: card.color,
				}));

			const lines = agents.length === 0
				? "No peer agents found."
				: agents.map((a) => {
					const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
					const live = a.alive ? "●" : "✗";
					const queueStr = formatQueueStr(a.queue_depth);
					return `${live} ${a.name} (${a.model})${ctxStr}${queueStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
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
			clearPrevious: Type.Optional(Type.Boolean({ description: "If true, clear all your prior pending messages on the receiver before delivering this one." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms not initialised");
			}
			const target = await resolveTarget(params.target);
			if (!target) {
				throw new Error(`coms: no live agent matching "${params.target}"`);
			}
			// Block coms_send to the sender when processing their inbound — auto-capture handles the reply
			if (processingInbound && currentInbound && !currentInbound.fulfilled && target.coms_session_id === currentInbound.sender_session) {
				log.info("coms_send_blocked", "to", target.name, "auto-capture will reply");
				return {
					content: [{ type: "text" as const, text: `coms_send blocked: you are responding to ${target.name}'s inbound message. Your assistant text will be auto-captured and sent back. Do NOT use coms_send to reply.` }],
					details: { blocked: true, reason: "processing_inbound", target: target.name },
				};
			}
			// Clear sender's prior pending messages on the receiver before delivering
			if (params.clearPrevious) {
				try { await sendQueueManage(target, "clear"); } catch { /* best-effort */ }
			}
			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}
			const msg_id = ulid();
			// Append sender's active tasks for this peer to the prompt
			let promptText = params.prompt;
			try {
				const { listTasksForSession } = require("../pitasks/index.js");
				const targetPiSessionId = target.pi_session_id || target.coms_session_id;
				const allTasks = listTasksForSession(targetPiSessionId, target.cwd) || [];
				const myTasks = allTasks.filter((t: any) =>
					(t.status === "pending" || t.status === "in_progress") &&
					t.createdBy?.session === identity!.coms_session_id
				);
				if (myTasks.length > 0) {
					const taskLines = myTasks.map((t: any) => `#${t.id} [${t.status}] ${t.subject}`).join("\n");
					promptText += `\n\n---\nReminder - Tasks assigned to you by ${identity!.name}:\n${taskLines}`;
				}
			} catch { /* task store not available — skip */ }
			const env: PromptEnvelope = {
				type: "prompt",
				msg_id,
				sender_session: identity.coms_session_id,
				sender_endpoint: identity.endpoint,
				sender_name: identity.name,
				sender_cwd: identity.cwd,
				hops,
				timestamp: nowIso(),
				prompt: promptText,
				conversation_id: params.conversation_id ?? null,
				response_schema: (params.response_schema as object | undefined) ?? null,
				tasks: params.tasks ?? null,
			};

			// Send the envelope synchronously and wait for the receiver's ack.
			await sendEnvelope(target.endpoint, env);
			comsSendCalledThisTurn.add(target.coms_session_id);

			// Auto-create tasks on the target's task store (sender-side, instant)
			if (params.tasks && params.tasks.length > 0 && target.coms_session_id) {
				try {
					const count = createComsInboundTasks(
						params.tasks,
						{ sender_session: identity.coms_session_id, sender_name: identity.name, sender_endpoint: identity.endpoint },
						target.pi_session_id || target.coms_session_id,
						target.cwd,
					);
					if (count > 0) {
						log.info("tasks_auto_created", msg_id, "to", target.name, "count", count);
					}
				} catch { /* best-effort */ }
			}

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
				// Clean up timed-out entry from both maps
				const pSet = pendingOutbound.get(target.name);
				if (pSet) { pSet.delete(msg_id); if (pSet.size === 0) pendingOutbound.delete(target.name); }
				setTimeout(() => { pendingReplies.delete(msg_id); }, 60_000).unref();
			}, TIMEOUT_MS);
			// Don't keep the event loop alive solely for this timer.
			try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
			pendingReplies.set(msg_id, entry);

			log.debug("outbound_prompt", msg_id, "to", target.name, "hops", hops);

			// Track pending outbound
			const targetKey = target.name;
			if (!pendingOutbound.has(targetKey)) pendingOutbound.set(targetKey, new Set());
			pendingOutbound.get(targetKey)!.add(msg_id);

			// Peer status from peerCards
			const peerCard = peerCards.get(target.coms_session_id);
			const peer_queue_depth = peerCard?.queue_depth ?? 0;
			const peer_status = currentInbound && !currentInbound.fulfilled ? "processing" : "idle";

			// Warn if pending messages exist
			const pendingCount = (pendingOutbound.get(targetKey)?.size ?? 1) - 1; // exclude this one
			const pendingWarn = pendingCount > 0 && !params.clearPrevious
				? `\n⚠️ You have ${pendingCount} pending message(s) to ${targetKey} that haven't been answered yet. Wait for responses or use clearPrevious:true to replace them.`
				: "";

			return {
				content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nhops ${hops}${pendingWarn}` }],
				details: { msg_id, target: target.name, target_session: target.coms_session_id, hops, peer_queue_depth, peer_status },
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
					details: { status: "complete", response: r.response, error: r.error ?? null, queued_msg_ids: r.queued_msg_ids ?? [] },
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

	// ━━ coms queue management tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	/** Send a queue_manage envelope to a peer. Only affects messages owned by this session. */
	async function sendQueueManage(target: { name: string; endpoint: string }, action: string, targetMsgId?: string, newContent?: string): Promise<{ affected?: number; error?: string | null }> {
		if (!identity) throw new Error("coms not initialised");
		const ack = await sendEnvelope(target.endpoint, {
			type: "queue_manage",
			msg_id: ulid(),
			sender_session: identity.coms_session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
			action,
			target_msg_id: targetMsgId,
			new_content: newContent,
			sender_name: identity.name,
		});
		return { affected: ack?.affected, error: ack?.error };
	}

	pi.registerTool({
		name: "coms_queue_delete",
		label: "Coms Queue Delete",
		description: "Delete your message from a peer's queue. Only works on your own pending messages.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			msg_id: Type.String({ description: "The msg_id to delete from the peer's queue." }),
		}),
		async execute(_callId, params) {
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);
			const result = await sendQueueManage(target, "delete", params.msg_id);
			if (result.error) throw new Error(`coms_queue_delete failed: ${result.error}`);
			return { content: [{ type: "text" as const, text: `coms_queue_delete → ${target.name}\nmsg_id: ${params.msg_id}` }] };
		},
	});

	pi.registerTool({
		name: "coms_queue_edit",
		label: "Coms Queue Edit",
		description: "Replace the content of your queued message on a peer. Only works on your own pending messages.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			msg_id: Type.String({ description: "The msg_id to edit." }),
			new_content: Type.String({ description: "New prompt content to replace the existing message." }),
		}),
		async execute(_callId, params) {
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);
			const result = await sendQueueManage(target, "edit", params.msg_id, params.new_content);
			if (result.error) throw new Error(`coms_queue_edit failed: ${result.error}`);
			return { content: [{ type: "text" as const, text: `coms_queue_edit → ${target.name}\nmsg_id: ${params.msg_id}` }] };
		},
	});

	pi.registerTool({
		name: "coms_queue_clear",
		label: "Coms Queue Clear",
		description: "Delete ALL your pending messages from a peer's queue. Only affects your own messages.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
		}),
		async execute(_callId, params) {
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);
			await sendQueueManage(target, "clear");
			return { content: [{ type: "text" as const, text: `coms_queue_clear → ${target.name}` }] };
		},
	});

	pi.registerTool({
		name: "coms_queue_prioritize",
		label: "Coms Queue Prioritize",
		description: "Move your message to the front of a peer's queue. Only works on your own pending messages.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			msg_id: Type.String({ description: "The msg_id to prioritize." }),
		}),
		async execute(_callId, params) {
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);
			const result = await sendQueueManage(target, "prioritize", params.msg_id);
			if (result.error) throw new Error(`coms_queue_prioritize failed: ${result.error}`);
			return { content: [{ type: "text" as const, text: `coms_queue_prioritize → ${target.name}\nmsg_id: ${params.msg_id}` }] };
		},
	});

	pi.registerTool({
		name: "coms_tasks_create",
		label: "Coms Tasks Create",
		description: "Create multiple tasks on a peer's task list. Automatically adds a 'Report completion to sender' task blocked by all created tasks, and sends a message to the peer to start working.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			tasks: Type.Array(Type.Object({
				subject: Type.String({ description: "Brief task title" }),
				description: Type.String({ description: "Detailed task description" }),
			}), { description: "Tasks to create on the peer" }),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms not initialised");
			if (!params.tasks || params.tasks.length === 0) throw new Error("coms_tasks_create requires at least one task");
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);

			const createdBy = {
				type: "coms" as const,
				origin: identity.name,
				session: identity.coms_session_id,
				project: process.cwd(),
			};
			const meta: Record<string, any> = {};
			if (identity.endpoint) meta.sender_endpoint = identity.endpoint;

			try {
				const { createTasksForSession, listTasksForSession, updateTaskForSession } = require("../pitasks/index.js");
				const targetPiSessionId = target.pi_session_id || target.coms_session_id;

				// Create all tasks in one batch
				const taskDefs = params.tasks.map(t => ({
					subject: t.subject,
					description: t.description,
					createdBy,
					metadata: { ...meta },
				}));
				const created = createTasksForSession(targetPiSessionId, taskDefs, target.cwd);
				const createdIds = created.map((t: any) => t.id);

				// Check if "Report completion to sender" already exists from this sender
				const allTasks = listTasksForSession(targetPiSessionId, target.cwd) || [];
				const existingReport = allTasks.find((t: any) =>
					t.createdBy?.session === identity!.coms_session_id &&
					t.subject === "Report completion to sender" &&
					t.status !== "completed" && t.status !== "deleted"
				);

				if (existingReport) {
					// Update existing report task's blockedBy to include new task IDs
					const newBlockedBy = [...new Set([...(existingReport.blockedBy || []), ...createdIds])];
					updateTaskForSession(targetPiSessionId, existingReport.id, { blockedBy: newBlockedBy }, target.cwd);
				} else {
					// Create report task blocked by all new tasks
					createTasksForSession(targetPiSessionId, [{
						subject: "Report completion to sender",
						description: `When all tasks are done, use coms_send to report back to ${identity!.name}.`,
						createdBy,
						blockedBy: createdIds,
						metadata: { ...meta },
					}], target.cwd);
				}

				log.info("coms_tasks_create", created.length, "tasks on", target.name);

				// Auto-send message to peer to start working
				try {
					const msg_id = ulid();
					const env: PromptEnvelope = {
						type: "prompt",
						msg_id,
						sender_session: identity.coms_session_id,
						sender_endpoint: identity.endpoint,
						sender_name: identity.name,
						sender_cwd: identity.cwd,
						hops: 0,
						timestamp: nowIso(),
						prompt: `You have tasks to work on. Check TaskList and start.`,
						conversation_id: null,
						response_schema: null,
						tasks: null,
					};
					await sendEnvelope(target.endpoint, env);
					pendingReplies.set(msg_id, { target_session: target.coms_session_id, target_name: target.name, sent_at: Date.now() });
				} catch (e: any) {
					log.debug("auto-message after task create failed:", e?.message);
				}

				const lines = created.map((t: any) => `#${t.id}: ${t.subject}`);
				return {
					content: [{ type: "text" as const, text: `Created ${created.length} tasks on ${target.name}:\n${lines.join("\n")}` }],
					details: { target: target.name, count: created.length, taskIds: createdIds },
				};
			} catch (e: any) {
				throw new Error(`Failed to create tasks on ${target.name}: ${e?.message}`);
			}
		},
	});

	pi.registerTool({
		name: "coms_task_delete",
		label: "Coms Task Delete",
		description: "Delete a task from a peer's task list. Only works on tasks you created (createdBy match).",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			task_id: Type.String({ description: "Task ID to delete." }),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);

			try {
				const { getTaskForSession, deleteTaskForSession } = require("../pitasks/index.js");
				const targetPiSessionId = target.pi_session_id || target.coms_session_id;
				const task = getTaskForSession(targetPiSessionId, params.task_id, target.cwd);
				if (!task) throw new Error(`Task #${params.task_id} not found`);
				if (task.createdBy?.session !== identity.coms_session_id) {
					throw new Error(`Ownership denied — can only delete tasks you created`);
				}
				if (task.status === "in_progress") {
					return {
						content: [{ type: "text" as const, text: `Cannot delete task #${params.task_id} — task is in_progress. Wait for the peer to finish.` }],
						details: { blocked: true, reason: "in_progress" },
					};
				}
				deleteTaskForSession(targetPiSessionId, params.task_id, target.cwd);
				log.info("coms_task_delete", params.task_id, "on", target.name);
			} catch (e: any) {
				throw new Error(`Failed to delete task on ${target.name}: ${e?.message}`);
			}

			return {
				content: [{ type: "text" as const, text: `Task #${params.task_id} deleted from ${target.name}` }],
				details: { target: target.name, task_id: params.task_id },
			};
		},
	});

	pi.registerTool({
		name: "coms_task_list",
		label: "Coms Task List",
		description: "List tasks on a peer's task list without sending a message.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);

			try {
				const { listTasksForSession } = require("../pitasks/index.js");
				const targetPiSessionId = target.pi_session_id || target.coms_session_id;
				const tasks = listTasksForSession(targetPiSessionId, target.cwd);
				log.debug("coms_task_list", target.name, "tasks", tasks?.length ?? 0);

				if (!tasks || tasks.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No tasks found" }],
						details: undefined,
					};
				}

				const sorted = [...tasks].sort((a: any, b: any) => {
					const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
					const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
					if (so !== 0) return so;
					return Number(a.id) - Number(b.id);
				});
				const lines = sorted.map((t: any) => {
					let line = `#${t.id} [${t.status}] ${t.subject}`;
					if (t.owner) line += ` (${t.owner})`;
					if (t.blockedBy?.length > 0) {
						const openBlockers = t.blockedBy.filter((bid: string) => {
							const blocker = tasks.find((bt: any) => bt.id === bid);
							return blocker && blocker.status !== "completed";
						});
						if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map((id: string) => "#" + id).join(", ")}]`;
					}
					return line;
				});
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: undefined,
				};
			} catch (e: any) {
				throw new Error(`Failed to list tasks on ${target.name}: ${e?.message}`);
			}
		},
	});

	pi.registerTool({
		name: "coms_task_get",
		label: "Coms Task Get",
		description: "Get a specific task from a peer's task list without sending a message.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			task_id: Type.String({ description: "Task ID to retrieve." }),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);

			try {
				const { getTaskForSession } = require("../pitasks/index.js");
				const targetPiSessionId = target.pi_session_id || target.coms_session_id;
				const task = getTaskForSession(targetPiSessionId, params.task_id, target.cwd);
				if (!task) throw new Error(`Task #${params.task_id} not found on ${target.name}`);

				log.debug("coms_task_get", target.name, "task", params.task_id);

				// Match local TaskGet format
				const desc = task.description || "(no description)";
				const lines: string[] = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
				if (task.owner) lines.push(`Owner: ${task.owner}`);
				lines.push(`Description: ${desc}`);
				if (task.blockedBy?.length > 0) {
					const { listTasksForSession } = require("../pitasks/index.js");
					const allTasks = listTasksForSession(targetPiSessionId, target.cwd);
					const openBlockers = task.blockedBy.filter((bid: string) => {
						const blocker = allTasks.find((bt: any) => bt.id === bid);
						return blocker && blocker.status !== "completed";
					});
					if (openBlockers.length > 0) lines.push(`Blocked by: ${openBlockers.map((id: string) => "#" + id).join(", ")}`);
				}
				if (task.blocks?.length > 0) lines.push(`Blocks: ${task.blocks.map((id: string) => "#" + id).join(", ")}`);

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: undefined,
				};
			} catch (e: any) {
				throw new Error(`Failed to get task from ${target.name}: ${e?.message}`);
			}
		},
	});

	pi.registerTool({
		name: "coms_task_update",
		label: "Coms Task Update",
		description: "Update a task on a peer's task list. Only works on tasks you created (createdBy match).",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			task_id: Type.String({ description: "The ID of the task to update" }),
			status: Type.Optional(Type.Unsafe({ type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status for the task" })),
			subject: Type.Optional(Type.String({ description: "New subject for the task" })),
			description: Type.Optional(Type.String({ description: "New description for the task" })),
			activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
			owner: Type.Optional(Type.String({ description: "New owner for the task" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
		}),
		async execute(_callId, params) {
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveTarget(params.target);
			if (!target) throw new Error(`coms: no live agent matching "${params.target}"`);

			try {
				const { getTaskForSession, updateTaskForSession } = require("../pitasks/index.js");
				const targetPiSessionId = target.pi_session_id || target.coms_session_id;
				const task = getTaskForSession(targetPiSessionId, params.task_id, target.cwd);
				if (!task) throw new Error(`Task #${params.task_id} not found on ${target.name}`);
				if (task.createdBy?.session !== identity.coms_session_id) {
					throw new Error(`Ownership denied — can only update tasks you created`);
				}
				if (task.status === "in_progress") {
					return {
						content: [{ type: "text" as const, text: `Cannot update task #${params.task_id} — task is in_progress. Wait for the peer to finish.` }],
						details: { blocked: true, reason: "in_progress" },
					};
				}

				const { target: _t, task_id: _tid, ...fields } = params;
				const result = updateTaskForSession(targetPiSessionId, params.task_id, fields, target.cwd);
				log.info("coms_task_update", params.task_id, "on", target.name, "fields", Object.keys(fields).join(","));

				const changedFields = result?.changedFields ?? [];
				const warnings = result?.warnings ?? [];
				let msg = `Updated task #${params.task_id} ${changedFields.join(", ")}`;
				if (warnings.length > 0) msg += ` (warning: ${warnings.join("; ")})`;
				return {
					content: [{ type: "text" as const, text: msg }],
					details: undefined,
				};
			} catch (e: any) {
				throw new Error(`Failed to update task on ${target.name}: ${e?.message}`);
			}
		},
	});

	// ━━ Track agent running state for mixed-turn detection (#731) ━━━━━━━━━
	// Only mark as "user turn" if NO coms inbound is active (processingInbound false).
	// When processingInbound is true, the agent is running a coms followUp — not a user turn.
	pi.on("agent_start" as any, () => {
		agentRunningUserTurn = !processingInbound;
		comsSendCalledThisTurn.clear();
		userMessageDuringInbound = false;
		log.debug("agent_start", "userTurn", agentRunningUserTurn, "processingInbound", processingInbound, "currentInbound", currentInbound?.msg_id ?? "null");
	});

	// ━━ message_start: detect a real user message interrupting an inbound turn (#741) ━━
	// A message_start with role "user" while processingInbound means a genuine user
	// message landed during a coms inbound turn — auto-capturing that assistant text
	// would leak user-directed content to the peer. Flag it for mixed-turn handling.
	pi.on("message_start" as any, (event: any) => {
		if (shuttingDown || !identity) return;
		if (isUserMessageDuringInbound(processingInbound, event?.message?.role)) {
			userMessageDuringInbound = true;
			log.info("user_message_during_inbound", currentInbound?.msg_id ?? "null");
		}
	});

	// ━━ agent_end: capture turn output and dispatch response back ━━━━━━━━

	pi.on("agent_end", async (_event, ctx) => {
		log.info("agent_end_enter", "currentInbound", currentInbound?.msg_id ?? "null", "identity", !!identity, "processingInbound", processingInbound);
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
			agentRunningUserTurn = false;
			inboundSetDuringUserTurn = false;
			userMessageDuringInbound = false;
			processingInbound = false;
			log.debug("agent_end_early", "currentInbound", currentInbound?.msg_id ?? "null", "processingInbound", processingInbound);
			return;
		}
		const inbound = currentInbound;
		currentInbound = null;
		agentRunningUserTurn = false;

		// Skip auto-capture if LLM already replied via coms_send to the same peer
		if (comsSendCalledThisTurn.has(inbound.sender_session)) {
			log.info("agent_end_skip_autocapture", inbound.msg_id, "coms_send called this turn", "sender", inbound.sender_name);
			inbound.fulfilled = true;
			inboundQueue.delete(inbound.msg_id);
			maybeRefreshWidget();
			// Continue FIFO drain
			const next = [...inboundQueue.values()].find((i) => !i.fulfilled);
			if (next) {
				currentInbound = next;
				try {
					pi.sendMessage(
						{
							customType: formatComsInboundType(next.sender_name, sanitizeComsName(identity?.name ?? "?"), next.sender_cwd),
							content: buildInboundContent("", next.prompt, next.tasks, next.sender_name, next.sender_cwd),
							display: true,
							details: {
								msg_id: next.msg_id,
								sender_session: next.sender_session,
								response_schema: next.response_schema ?? null,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					currentInbound = null;
					processingInbound = false;
				}
			} else {
				processingInbound = false;
			}
			return;
		}

		// ── Mixed-turn detection (#731) ──────────────────────────────────────
		// If the inbound was set while the agent was running a user turn
		// (not a coms followUp), the assistant's response is for the user.
		// Re-inject the inbound for a dedicated turn.
		const hasMixedTurn = computeMixedTurn(inboundSetDuringUserTurn, userMessageDuringInbound);
		if (userMessageDuringInbound && !inboundSetDuringUserTurn) {
			log.info("mixed_turn_user_interrupt", inbound.msg_id);
		}
		inboundSetDuringUserTurn = false;
		userMessageDuringInbound = false;

		const MAX_MIXED_RETRIES = 2;
		if (hasMixedTurn) {
			const retries = inbound.mixedTurnRetries ?? 0;
			if (retries < MAX_MIXED_RETRIES) {
				// Re-inject the inbound for a clean dedicated turn.
				inbound.mixedTurnRetries = retries + 1;
				log.info("mixed_turn_reinject", inbound.msg_id, "retry", inbound.mixedTurnRetries, "from", inbound.sender_name);
				try {
					pi.sendMessage(
						{
							customType: formatComsInboundType(inbound.sender_name, sanitizeComsName(identity?.name ?? "?"), inbound.sender_cwd),
							content: buildInboundContent(
								`[NOTE: your previous reply was not captured because a user message arrived in the same turn. ` +
								`This is a re-injection — please reply to this peer message now.]`,
								inbound.prompt, inbound.tasks ?? null, inbound.sender_name, inbound.sender_cwd),
							display: true,
							details: {
								msg_id: inbound.msg_id,
								sender_session: inbound.sender_session,
								response_schema: inbound.response_schema ?? null,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch (err: any) {
					// Re-injection failed — send error response to peer, then FIFO drain remaining
					log.error("mixed_turn_reinject_failed", inbound.msg_id, err?.message);
					inbound.fulfilled = true;
					inboundQueue.delete(inbound.msg_id);
					maybeRefreshWidget();
					currentInbound = null;
					const queuedIds: string[] = [];
					for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound) queuedIds.push(i.msg_id);
					try {
						await sendEnvelope(inbound.sender_endpoint, {
							type: "response", msg_id: inbound.msg_id,
							sender_session: identity.coms_session_id, sender_endpoint: identity.endpoint,
							hops: 0, timestamp: nowIso(),
							response: null, error: "mixed_turn_conflict",
							queued_msg_ids: queuedIds,
						});
					} catch { /* best-effort */ }
					// FIFO drain: inject next or drain all remaining with error responses
					const next = [...inboundQueue.values()].find((i) => !i.fulfilled);
					if (next) {
						currentInbound = next;
						try {
							pi.sendMessage(
								{
									customType: formatComsInboundType(next.sender_name, sanitizeComsName(identity?.name ?? "?"), next.sender_cwd),
									content: buildInboundContent("", next.prompt, next.tasks, next.sender_name, next.sender_cwd),
									display: true,
									details: {
										msg_id: next.msg_id,
										sender_session: next.sender_session,
										response_schema: next.response_schema ?? null,
									},
								},
								{ deliverAs: "followUp", triggerTurn: true },
							);
						} catch (drainErr: any) {
							log.error("fifo_drain_failed", next.msg_id, drainErr?.message);
							const remaining = [next, ...[...inboundQueue.values()].filter(i => !i.fulfilled && i.msg_id !== next.msg_id)];
							for (let idx = 0; idx < remaining.length; idx++) {
								const orphan = remaining[idx];
								try {
									await sendEnvelope(orphan.sender_endpoint, {
										type: "response", msg_id: orphan.msg_id,
										sender_session: identity!.coms_session_id, sender_endpoint: identity!.endpoint,
										hops: 0, timestamp: nowIso(),
										response: null, error: "injection_failed",
										queued_msg_ids: remaining.slice(idx + 1).map(r => r.msg_id),
									});
								} catch (e: any) {
									log.error("orphan_cleanup_failed", orphan.msg_id, e?.message);
								}
								orphan.fulfilled = true;
								inboundQueue.delete(orphan.msg_id);
							}
							currentInbound = null;
							processingInbound = false;
						}
					} else {
						processingInbound = false;
					}
					return;
				}
				// Re-injection succeeded — restore currentInbound for next agent_end
				currentInbound = inbound;
				return;
			}

			// Max retries exhausted — send error response to peer.
			log.warn("mixed_turn_exhausted", inbound.msg_id, "from", inbound.sender_name, "retries", retries);
			const queuedIds: string[] = [];
			for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound) queuedIds.push(i.msg_id);
			try {
				await sendEnvelope(inbound.sender_endpoint, {
					type: "response", msg_id: inbound.msg_id,
					sender_session: identity.coms_session_id, sender_endpoint: identity.endpoint,
					hops: 0, timestamp: nowIso(),
					response: null, error: "mixed_turn_conflict",
					queued_msg_ids: queuedIds,
				});
			} catch { /* best-effort */ }
			inbound.fulfilled = true;
			inboundQueue.delete(inbound.msg_id);
			maybeRefreshWidget();
			currentInbound = null;

			// Continue FIFO drain after mixed-turn exhaustion
			const next = [...inboundQueue.values()].find((i) => !i.fulfilled);
			if (next) {
				currentInbound = next;
				try {
					pi.sendMessage(
						{
							customType: formatComsInboundType(next.sender_name, sanitizeComsName(identity?.name ?? "?"), next.sender_cwd),
							content: buildInboundContent("", next.prompt, next.tasks, next.sender_name, next.sender_cwd),
							display: true,
							details: {
								msg_id: next.msg_id,
								sender_session: next.sender_session,
								response_schema: next.response_schema ?? null,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch (drainErr: any) {
					log.error("fifo_drain_failed", next.msg_id, drainErr?.message);
					const remaining = [next, ...[...inboundQueue.values()].filter(i => !i.fulfilled && i.msg_id !== next.msg_id)];
					for (let idx = 0; idx < remaining.length; idx++) {
						const orphan = remaining[idx];
						try {
							await sendEnvelope(orphan.sender_endpoint, {
								type: "response", msg_id: orphan.msg_id,
								sender_session: identity!.coms_session_id, sender_endpoint: identity!.endpoint,
								hops: 0, timestamp: nowIso(),
								response: null, error: "injection_failed",
								queued_msg_ids: remaining.slice(idx + 1).map(r => r.msg_id),
							});
						} catch (e: any) {
							log.error("orphan_cleanup_failed", orphan.msg_id, e?.message);
						}
						orphan.fulfilled = true;
						inboundQueue.delete(orphan.msg_id);
					}
					currentInbound = null;
					processingInbound = false;
				}
			} else {
				processingInbound = false;
			}
			return;
		}
		// ── End mixed-turn detection ─────────────────────────────────────────

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

		// Check if sender has more pending messages — accumulate response if so
		const bundledIds = new Set(bundledInbounds.map(bi => bi.msg_id));
		const morePending = [...inboundQueue.values()].some(i =>
			!i.fulfilled && i.sender_session === inbound.sender_session && i.msg_id !== inbound.msg_id
			&& !bundledIds.has(i.msg_id)
		);

		if (morePending) {
			// Accumulate response, fulfill silently, let FIFO drain continue with next from same sender
			if (!accumulatedResponses.has(inbound.sender_session)) {
				accumulatedResponses.set(inbound.sender_session, []);
			}
			accumulatedResponses.get(inbound.sender_session)!.push(lastAssistantText);
			log.debug("agent_end_accumulate", inbound.msg_id, "from", inbound.sender_name, "accumulated", accumulatedResponses.get(inbound.sender_session)!.length);

			inbound.fulfilled = true;
			inboundQueue.delete(inbound.msg_id);

			// Also fulfill bundled inbounds silently
			for (const bi of bundledInbounds) {
				bi.fulfilled = true;
				inboundQueue.delete(bi.msg_id);
			}
			bundledInbounds = [];

			maybeRefreshWidget();

			// FIFO drain — pick next from same sender (or any sender)
			const allPending = [...inboundQueue.values()].filter((i) => !i.fulfilled);
			if (allPending.length > 0) {
				const firstSender = allPending[0].sender_session;
				const senderPending = allPending.filter(i => i.sender_session === firstSender);

				if (senderPending.length === 1) {
					currentInbound = senderPending[0];
					bundledInbounds = [];
					log.debug("agent_end_fifo_next", senderPending[0].msg_id, "from", senderPending[0].sender_name);
					try {
						pi.sendMessage({
							customType: formatComsInboundType(senderPending[0].sender_name, sanitizeComsName(identity?.name ?? "?"), senderPending[0].sender_cwd),
							content: buildInboundContent("", senderPending[0].prompt, senderPending[0].tasks, senderPending[0].sender_name, senderPending[0].sender_cwd),
							display: true,
							details: { msg_id: senderPending[0].msg_id, sender_session: senderPending[0].sender_session, response_schema: senderPending[0].response_schema ?? null },
						}, { deliverAs: "followUp", triggerTurn: true });
					} catch { currentInbound = null; bundledInbounds = []; processingInbound = false; }
				} else {
					const primary = senderPending[0];
					currentInbound = primary;
					bundledInbounds = senderPending.slice(1);
					const bundledContent = senderPending.map((ib, idx) =>
						`--- Message ${idx + 1} of ${senderPending.length} [${ib.msg_id}] ---\n${ib.prompt}`
					).join("\n\n");
					const header = `[BUNDLED: ${senderPending.length} messages from ${primary.sender_name}. Later messages may override earlier ones. Read ALL before acting.]`;
					log.debug("agent_end_fifo_bundle", senderPending.length, "from", primary.sender_name);
					try {
						pi.sendMessage({
							customType: formatComsInboundType(primary.sender_name, sanitizeComsName(identity?.name ?? "?"), primary.sender_cwd),
							content: buildInboundContent(header, bundledContent, null, primary.sender_name, primary.sender_cwd),
							display: true,
							details: { msg_id: primary.msg_id, sender_session: primary.sender_session, response_schema: primary.response_schema ?? null, bundled_msg_ids: senderPending.map(i => i.msg_id) },
						}, { deliverAs: "followUp", triggerTurn: true });
					} catch { currentInbound = null; bundledInbounds = []; processingInbound = false; }
				}
			} else {
				processingInbound = false;
			}
			return;
		}

		// No more pending from this sender — build combined response
		const accumulated = accumulatedResponses.get(inbound.sender_session) ?? [];
		accumulated.push(lastAssistantText);
		accumulatedResponses.delete(inbound.sender_session);
		const combinedPayload = accumulated.length > 1 ? accumulated.join("\n\n---\n\n") : accumulated[0] || lastAssistantText;
		log.debug("agent_end_combined_response", inbound.msg_id, "parts", accumulated.length);

		let payload: any = combinedPayload;
		let error: string | null = null;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			try {
				payload = JSON.parse(lastAssistantText);
			} catch {
				error = "response not valid JSON";
				payload = null;
			}
		}

		// Use inline count instead of getPendingInboundCount() — `inbound` (local param)
		// differs from `currentInbound` (module-scoped, already null at this point).
		const queuedIds: string[] = [];
		for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound && !bundledIds.has(i.msg_id)) queuedIds.push(i.msg_id);
		const respEnv: ResponseEnvelope = {
			type: "response",
			msg_id: inbound.msg_id,
			sender_session: identity.coms_session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
			response: payload,
			error,
			queued_msg_ids: queuedIds,
		};
		// Compute your_pending at the last moment before send
		respEnv.your_pending = getSenderPending(inbound.sender_session, inbound.msg_id).filter(p => !bundledIds.has(p.msg_id));

		try {
			await sendEnvelope(inbound.sender_endpoint, respEnv);
			log.debug("outbound_response", inbound.msg_id, "error", error);
		} catch (e: any) {
			log.error("outbound_response_failed", inbound.msg_id, e?.message);
		}

		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);

		// Fulfill bundled inbounds — fire-and-forget responses, don't block agent_end
		for (const bi of bundledInbounds) {
			const biMsgId = bi.msg_id;
			const biEndpoint = bi.sender_endpoint;
			// Fire-and-forget — don't await, don't block
			if (identity) {
				sendEnvelope(biEndpoint, {
					type: "response",
					msg_id: biMsgId,
					sender_session: identity.coms_session_id,
					sender_endpoint: identity.endpoint,
					hops: 0,
					timestamp: nowIso(),
					response: null,
					error: "bundled",
					queued_msg_ids: [],
				}).catch(() => { /* best-effort */ });
			}
			bi.fulfilled = true;
			inboundQueue.delete(bi.msg_id);
		}
		bundledInbounds = [];

		maybeRefreshWidget();

		// FIFO drain: collect ALL pending from the same sender and bundle them
		const allPending = [...inboundQueue.values()].filter((i) => !i.fulfilled);
		if (allPending.length > 0) {
			// Group by sender — process first sender's messages together
			const firstSender = allPending[0].sender_session;
			const senderPending = allPending.filter(i => i.sender_session === firstSender);

			if (senderPending.length === 1) {
				// Single message — inject normally
				const next = senderPending[0];
				currentInbound = next;
				bundledInbounds = [];
				try {
					pi.sendMessage(
						{
							customType: formatComsInboundType(next.sender_name, sanitizeComsName(identity?.name ?? "?"), next.sender_cwd),
							content: buildInboundContent("", next.prompt, next.tasks, next.sender_name, next.sender_cwd),
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
					log.error("fifo_drain_failed", next.msg_id, err?.message);
					next.fulfilled = true;
					inboundQueue.delete(next.msg_id);
					currentInbound = null;
					bundledInbounds = [];
					processingInbound = false;
				}
			} else {
				// Multiple messages from same sender — bundle them
				const primary = senderPending[0];
				currentInbound = primary;
				bundledInbounds = senderPending.slice(1);

				const bundledContent = senderPending.map((ib, idx) =>
					`--- Message ${idx + 1} of ${senderPending.length} [${ib.msg_id}] ---\n${ib.prompt}`
				).join("\n\n");

				const header = `[BUNDLED: ${senderPending.length} messages from ${primary.sender_name}. Later messages may override earlier ones. Read ALL before acting.]`;

				try {
					pi.sendMessage(
						{
							customType: formatComsInboundType(primary.sender_name, sanitizeComsName(identity?.name ?? "?"), primary.sender_cwd),
							content: buildInboundContent(header, bundledContent, null, primary.sender_name, primary.sender_cwd),
							display: true,
							details: {
								msg_id: primary.msg_id,
								sender_session: primary.sender_session,
								response_schema: primary.response_schema ?? null,
								bundled_msg_ids: senderPending.map(i => i.msg_id),
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch (err: any) {
					log.error("fifo_bundle_failed", primary.msg_id, err?.message);
					for (const ib of senderPending) {
						ib.fulfilled = true;
						inboundQueue.delete(ib.msg_id);
					}
					currentInbound = null;
					bundledInbounds = [];
					processingInbound = false;
				}
			}
		} else {
			bundledInbounds = [];
			processingInbound = false;
		}
	});

	// ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	const comsRefreshHandler = async (args: any, ctx: any) => {
		const trimmed = ((args as string) ?? "").trim();
		if (trimmed.includes("--all")) {
			includeExplicit = !includeExplicit;
			try { ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
		}
		const projectMatch = trimmed.match(/--project\s+(\S+)/);
		if (projectMatch) {
			displayProject = projectMatch[1];
			try { ctx.ui.notify(`coms: displaying project ${displayProject}`, "info"); } catch { /* ignore */ }
		}
		maybeRefreshWidget();
	};
	pi.registerCommand("coms", {
		description: "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
		handler: comsRefreshHandler,
	});

	// ━━ /coms-queue command — view and kill queued messages ━━━━━━━━━━━━━━━
	let comsQueueCmdHandler: any;
	pi.registerCommand("coms-queue", {
		description: "View and manage queued coms inbound messages",
		handler: comsQueueCmdHandler = async (_args: any, ctx: any) => {
			interface QueueItem {
				id: string;
				msg_id: string;
				sender_name: string;
				prompt: string;
				status: string;
				receivedAt: number;
			}

			const getItems = (): QueueItem[] => {
				const items: QueueItem[] = [];
				const now = Date.now();
				if (currentInbound && !currentInbound.fulfilled) {
					items.push({
						id: currentInbound.msg_id,
						msg_id: currentInbound.msg_id,
						sender_name: currentInbound.sender_name,
						prompt: currentInbound.prompt,
						status: "processing",
						receivedAt: now,
					});
				}
				for (const ib of inboundQueue.values()) {
					if (ib.fulfilled) continue;
					if (currentInbound && ib.msg_id === currentInbound.msg_id) continue;
					items.push({
						id: ib.msg_id,
						msg_id: ib.msg_id,
						sender_name: ib.sender_name,
						prompt: ib.prompt,
						status: "pending",
						receivedAt: now,
					});
				}
				return items;
			};

			const killItem = async (msgId: string) => {
				const ib = inboundQueue.get(msgId);
				if (!ib || ib.fulfilled) return;
				ib.fulfilled = true;
				inboundQueue.delete(msgId);
				if (currentInbound?.msg_id === msgId) {
					currentInbound = null;
				}
				maybeRefreshWidget();
				// Send error response to sender
				if (identity) {
					try {
						await sendEnvelope(ib.sender_endpoint, {
							type: "response", msg_id: ib.msg_id,
							sender_session: identity.coms_session_id, sender_endpoint: identity.endpoint,
							hops: 0, timestamp: nowIso(),
							response: null, error: "killed_by_user",
							queued_msg_ids: [],
						});
					} catch { /* best-effort */ }
				}
				log.info("queue_kill", msgId, "sender", ib.sender_name);
			};

			const fmtAge = (ms: number): string => {
				if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
				if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
				return `${Math.round(ms / 3_600_000)}h`;
			};

			await openListDetailOverlay(ctx, {
				emptyMessage: "No queued coms messages.",
				listSpec: {
					title: "Coms Queue",
					countLabel: (items) => `${items.length} message${items.length === 1 ? "" : "s"}`,
					borderTitle: (items) => {
						const processing = items.filter(i => i.status === "processing").length;
						return `queue · ${processing} processing / ${items.length}`;
					},
					footerHints: "↑↓/jk select · Enter view · x kill · Esc close",
					listItems: getItems,
					rowParts: (item, theme) => {
						const shortId = item.msg_id.length > 8 ? item.msg_id.slice(-8) : item.msg_id;
						const preview = item.prompt.length > 40 ? `${item.prompt.slice(0, 40)}…` : item.prompt;
						const statusColor = item.status === "processing" ? "warning" : "dim";
						return {
							glyph: item.status === "processing" ? theme.fg("warning", "■") : theme.fg("dim", "○"),
							title: item.sender_name,
							idLabel: theme.fg("dim", shortId),
							rightParts: [
								theme.fg("dim", preview),
								theme.fg(statusColor, item.status),
							],
						};
					},
					onX: (item) => { void killItem(item.id); },
				},
				createDetail: (item, tui, theme, done) => {
					return new OverlayScrollDetail(tui, theme, {
						followTail: false,
						emptyBody: "(no prompt)",
						footerHints: "↑↓/jk scroll · x kill · Esc back",
						onX: () => {
							void killItem(item.id);
							return true;
						},
						getHeader: (t) => {
							const shortId = item.msg_id.length > 8 ? item.msg_id.slice(-8) : item.msg_id;
							return (
								t.fg("accent", t.bold(item.sender_name)) +
								t.fg("dim", ` · ${shortId}`) +
								t.fg("muted", ` · ${item.status}`)
							);
						},
						getBodyLines: () => item.prompt.split("\n"),
					}, done);
				},
			});
		},
	});

	// Expose command handlers to pidash for browser command dispatch
	try {
		if ((globalThis as any).__coms_p2p_pidash_listener) {
			try { pi.events.removeListener("pidash:request-commands", (globalThis as any).__coms_p2p_pidash_listener); } catch {}
		}
		const registerWithPidash = () => {
			pi.events.emit("pidash:register-command", { name: "coms-queue", handler: comsQueueCmdHandler });
		};
		(globalThis as any).__coms_p2p_pidash_listener = registerWithPidash;
		registerWithPidash();
		pi.events.on("pidash:request-commands", registerWithPidash);
	} catch {}

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		try { pi.events.emit("pidash:coms-identity", { name: null, purpose: null }); } catch {}
		const ident = identity; // snapshot before nulling
		identity = null; // null identity so old handlers from previous reload cycles exit via !identity check
		if (fsWatcher) { try { fsWatcher.close(); } catch { /* ignore */ } fsWatcher = null; }
		if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
		if (taskHeartbeatTimer) { try { clearInterval(taskHeartbeatTimer); } catch { /* ignore */ } taskHeartbeatTimer = null; }
		// Broadcast "leaving" presence to all known peers (fire-and-forget)
		if (ident) {
			for (const [, card] of peerCards) {
				// Find endpoint for this peer from registry
				const entries = readAllRegistryEntries(ident.project);
				const peerEntry = entries.find(e => e.name === card.name && e.coms_session_id !== ident!.coms_session_id);
				if (peerEntry?.endpoint) {
					log.info("shutdown_leaving_broadcast", "to", card.name, peerEntry.endpoint);
					try {
						const sock = net.createConnection({ path: peerEntry.endpoint });
						sock.once("connect", () => {
							try {
								sock.write(JSON.stringify({
									type: "presence",
									status: "leaving",
									sender_name: ident!.name,
									msg_id: ulid(),
									sender_session: ident!.coms_session_id,
									sender_endpoint: ident!.endpoint,
									hops: 0,
									timestamp: nowIso(),
								}) + "\n");
							} catch { /* ignore */ }
							setTimeout(() => { try { sock.destroy(); } catch {} }, 200);
						});
						sock.once("error", () => { try { sock.destroy(); } catch {} });
					} catch { /* ignore */ }
				}
			}
		}
		if (server) {
			try { server.close(); } catch { /* ignore */ }
			server = null;
		}
		if (pingWorker) {
			try { pingWorker.postMessage({ type: "shutdown" }); } catch {}
			pingWorker = null;
			pingWorkerReady = false;
		}
		if (ident) {
			if (process.platform !== "win32") {
				try { fs.unlinkSync(ident.endpoint); } catch { /* ignore */ }
			}
			try { removeRegistryEntry(ident.project, ident.coms_session_id); } catch { /* ignore */ }
			log.info("shutdown", ident.coms_session_id);
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
			try { currentCtx.ui.setStatus("coms", undefined); } catch { /* ignore */ }
		}
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
