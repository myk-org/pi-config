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

import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyExtensionDefaults } from "./themeMap.js";
import {
	buildBundledContent, buildComsPeersPayload, ulid, hexFg, isValidHex, fallbackColor, comsParseYamlFrontmatter as parseFrontmatter, nowIso, abbreviateModel, findSystemPromptPath, readFrontmatterFromArgv, readTaskSummary, buildInboundContent, renderQueuePart, formatQueueStr, formatComsResponseText, formatComsResponseType, formatComsResponseBody, formatComsInboundType, sanitizeComsName, createComsInboundTasks, resolvePeerTaskStorePath, shouldEvictOnLeaving, shouldAnnouncePeerLeft, isSessionStillRegistered, FALLBACK_PALETTE, type TasksSummary, insertInboundByPriority, shouldAcceptSteer, summarizeBroadcast, formatBusyStr, selectSenderBundle, deadPeerCardIds, isPeerTaskCreator, type BroadcastTargetResult, resolvePromptOrigin, receivedPromptOrigin, type PromptOrigin, loadPitasks, summarizeTaskList, getComsOriginTask, getComsOriginTasks,
	COMS_INBOUND_CUSTOM_TYPE, COMS_RESPONSE_CUSTOM_TYPE, COMS_PEER_JOINED_CUSTOM_TYPE, COMS_PEER_LEFT_CUSTOM_TYPE,
	type ComsInboundDetails, type ComsResponseDetails, type ComsPeerEventDetails,
} from "./coms-shared.js";
import {
	createCompactOneLineComponent,
	createExpandedCustomBox,
	extractMessageText,
	extractSummaryLine,
	formatExpandHint,
	type CompactCustomMessage,
	type CompactMessageRenderOptions,
} from "../shared/compact-message-renderer.js";
import { resolveStorePath } from "../pitasks/task-store.js";
import { openTaskBlockers } from "../pitasks/tasks-view.js";
import { appendHistoryRecord, queryHistoryRecords, truncatePreview, type HistoryRecord } from "./coms-history.js";
import { openListDetailOverlay, OverlayScrollDetail } from "../orchestrator/overlay-dashboard.js";
import { projectProblem, userTargetProblem } from "./coms-peers.js";
import { READ_ONLY_LOCAL_ANNOTATIONS, TOOL_NAMESPACES } from "../shared/tool-namespaces.js";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { getSetting } from "../orchestrator/project-settings.js";
import { createLogger } from "../shared/logger.js";
import { setLogFilePrefix } from "../shared/file-logger.js";
import { ComsRegistry, probeAlive, probeStaleSocket, resolveComsDir, type RegistryEntry } from "./coms-registry.js";
import { isUserMessageDuringInbound, computeMixedTurn } from "./mixed-turn.js";
import { buildQueuePreview, clearLocalQueue, type QueueRecoveryItem, type QueueRecoveryPreview } from "./queue-recovery.js";
import { collectWorkload, openBlockers, renderWorkloadPart, toDescribeDetail, type ActiveWorkload, type PeerWorkloadCounts, type WorkloadTask } from "./coms-workload.js";
import {
	DEFAULT_BRIDGE_SESSION_KEY,
	consumeStreamLoopAborted,
	hasStreamLoopAborted,
	onMalformedRecoveryAborted,
	publishedTaskStore,
	publishedWorkloadSources,
	resolveBridgeSessionKey,
	shouldDeferForMalformedRecovery,
} from "../shared/session-bridge.js";
import { sanitizePeerText, stripOriginMarker } from "./peer-text.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import {
	TOGGLE_ALL_WIDGETS_EVENT,
	WIDGET_MODE_CHANGED_EVENT,
	formatComsCollapsedHeader,
	formatComsTopBorder,
	getRegisteredWidgetShortcut,
	getWidgetMode,
	type WidgetModeChangedEvent,
} from "../shared/widget-visibility.js";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const log = createLogger("coms");
/** #1084: the tell path's own trail (resolve/completion); coms-shared logs parse/build. */
const tellLog = createLogger("coms-tell");
const RECOVERY_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_RECOVERY_PREVIEWS_PER_SESSION = 20;
const KEEPALIVE_INTERVAL_MS = 30_000;
const LINE_CAP_BYTES = 64 * 1024;
/** #1430: safety TTL for persisted reload-handoff inbound queue files. */
export const RELOAD_QUEUE_TTL_MS = 60_000;


// ━━ Public Runtime Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type ComsActivationOrigin = "tool" | "slash" | "cli";

export interface ComsPeerFlagOverrides {
	cname?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
}

export interface ComsPeerStartOptions {
	flags?: ComsPeerFlagOverrides;
	origin?: ComsActivationOrigin;
	sessionId?: string;
	/** #1430: true when starting as part of a `/reload` cycle (restores persisted inbound queue). */
	reload?: boolean;
}

export interface ComsPeerStopOptions {
	/** Shutdown reason (e.g. `"reload"`, `"quit"`, `"stop"`, `"signal"`, `"reload_failed"`). */
	reason?: string;
	/** Optional project/session hint when discarding a pending reload queue without an active identity. */
	project?: string;
	sessionId?: string;
}

export interface ComsUserSendParams {
	target: string;
	prompt: string;
	project?: string;
	expectedEndpoint?: string;
}

export interface ComsUserSendResult {
	ok: boolean;
	message: string;
}

export interface ComsPeerSelf {
	sessionId: string;
	name: string;
	project: string;
	endpoint: string;
	origin: ComsActivationOrigin;
	registryFile: string;
}

export interface ComsPeerRuntimeOptions {
	/**
	 * When true, P2P tools register with `defaultActive: false` and reject calls while inactive,
	 * and `session_start`/`session_shutdown` are driven explicitly by the caller (e.g. `coms-wrapper.ts`).
	 * Defaults to false (auto-starts on `session_start`, stops on `session_shutdown`).
	 */
	deferred?: boolean;
	/** Message returned when a gated tool executes while inactive. */
	inactiveMessage?: string;
	/** Optional flag lookup override (checked before `pi.getFlag`). */
	getFlag?: (name: string) => unknown;
	/** Override COMS registry root directory (otherwise resolved via `getSetting(cwd, "coms_dir")`). */
	comsDir?: string;
	/** Override session id (otherwise resolved via `globalThis.__piConfigSessionId` or ULID). */
	sessionId?: string;
	/** Allow registration even when `PI_SUBAGENT_CHILD=1` (default: false). */
	allowSubagentChild?: boolean;
	/** Register SIGINT/SIGTERM process handlers while active (default: true). */
	registerSignalHandlers?: boolean;
	/** Override reload-handoff queue TTL in ms (primarily for isolated tests; default 60s). */
	reloadQueueTtlMs?: number;
}

export interface ComsPeerRuntime {
	start(ctx: ExtensionContext, options?: ComsPeerStartOptions): Promise<ComsPeerSelf | null>;
	stop(options?: ComsPeerStopOptions): Promise<void>;
	getSelf(): ComsPeerSelf | null;
	isActive(): boolean;
	sendAsUser(params: ComsUserSendParams): Promise<ComsUserSendResult>;
	openQueueOverlay(args: string, ctx: any): Promise<void>;
	readonly gatedToolNames: ReadonlySet<string>;
}


// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "response" | "ping" | "task_update" | "queue_manage" | "task_manage" | "presence" | "progress" | "describe";

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
	/** #924 §4: jump the receiver's inbound queue (queued delivery order). */
	priority?: boolean;
	/** #924 §1: inject into the receiver's IN-FLIGHT turn instead of queueing. */
	steer?: boolean;
	/** #1077: who authored this prompt. Only the command layer (`/coms tell`, the peers overlay)
	 *  sets "user"; every tool-driven send leaves it unset, which means "peer". */
	origin?: PromptOrigin;
}

/** A received origin counts only as the exact literal: a forged or malformed value is a peer
 *  message, so an unknown cannot claim human authority. */
function inboundOrigin(env: { origin?: unknown }): PromptOrigin {
	return receivedPromptOrigin(env.origin);
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
	action: "inspect" | "delete" | "edit" | "clear" | "prioritize";
	target_msg_id?: string;
	new_content?: string;
	preview_id?: string;
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

/** #924 §6: mid-turn progress signal from the peer processing our prompt.
 *  msg_id references the ORIGINAL prompt's msg_id — it never fulfills the
 *  pending reply, only annotates it. */
interface ProgressEnvelope extends Envelope {
	type: "progress";
	note: string;
	sender_name: string;
}

interface AgentCard {
	name: string;
	/** Socket of the peer: a card without it cannot be recognised as dead. */
	endpoint?: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct: number;
	queue_depth: number;
	/** #924 §3, #1466: receiver is currently processing a peer inbound or executing an active agent turn. */
	busy: boolean;
	tasks_summary?: { total: number; completed: number; in_progress: number } | null;
	/** #1083: the peer's own active workload. Absent = not reported = `unknown` (never 0). */
	workload?: PeerWorkloadCounts | null;
}

interface Pong {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
}

/** #1083: `/coms list` drilldown request. The reply is `{ type: "describe_reply", detail }`. */
interface DescribeEnvelope extends Envelope {
	type: "describe";
}

interface PendingReply {
	resolve?: (value: any) => void;
	reject?: (err: Error) => void;
	timer?: NodeJS.Timeout | null;
	promise?: Promise<{ response?: any; error?: string | null; queued_msg_ids?: string[] }>;
	result?: { response?: any; error?: string | null; queued_msg_ids?: string[] };
	target_session?: string;
	target_name?: string;
	target_project?: string;
	sent_at?: number;
	created_at?: string;
	/** Creation time drives body-free recovery previews. */
	queued_at?: string;
	/** #924 §6: last progress note received from the peer (never resolves the reply). */
	progress?: { note: string; at: string };
	/** Internal RPC reply (e.g. task_manage list): resolves caller directly without chat injection or history. */
	internal?: boolean;
}

/** #951: coms_send tool result details — blocked send or delivered message. */
type ComsSendDetails =
	| { blocked: boolean; reason: string; target: string }
	| { msg_id: string; target: string; target_session: string; hops: number; peer_queue_depth: number; peer_status: string };

/** #951: coms_get tool result details — error, completed reply, or pending progress. */
type ComsGetDetails =
	| { status: "error"; error: string }
	| { status: "complete"; response: unknown; error: string | null; queued_msg_ids: string[] }
	| { status: "pending"; progress: { note: string; at: string } | null };

/** #951: coms_task_delete tool result details — blocked or deleted. */
type ComsTaskDeleteDetails =
	| { blocked: boolean; reason: string }
	| { target: string; task_id: string };

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	prompt: string;
	tasks?: Array<{ subject: string; description: string }> | null;
	conversation_id?: string | null;
	response_schema?: object | null;
	queued_at: string;
	fulfilled: boolean;
	/** How many times this inbound was re-injected due to mixed-turn conflict */
	mixedTurnRetries?: number;
	/** How many times this inbound was re-injected after an abort/error before delivery (#1226) */
	undeliveredRetries?: number;
	/** #1429/#1430: monotonic delivery attempt counter so superseded followUp copies are suppressed. */
	injectAttempt?: number;
	/** #1226: true while Pi holds an undelivered followUp copy of this inbound in its queue. */
	followUpQueued?: boolean;
	/** #1226: steers injected as followUp for this inbound that have not yet emitted message_start. */
	pendingSteers?: number;
	/** #924 §4: this inbound was sent with priority (jumps the queue). */
	priority?: boolean;
	/** #924 §1: steers accepted into this inbound's turn so far (cap guard). */
	steerCount?: number;
	/** #1077: the sender's claim of human authorship (literal "user" only). */
	origin?: PromptOrigin;
	/** #924 §6: last progress-signal emission for this inbound (ms epoch). */
	lastProgressAt?: number;
}

interface PersistedReloadInbound {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	prompt: string;
	tasks?: Array<{ subject: string; description: string }> | null;
	conversation_id?: string | null;
	response_schema?: object | null;
	queued_at: string;
	priority?: boolean;
	origin?: PromptOrigin;
	injectAttempt?: number;
	wasInjected?: boolean;
}

interface ReloadQueuePayload {
	version: 1;
	session_id: string;
	project: string;
	endpoint: string;
	saved_at_ms: number;
	expires_at_ms: number;
	pid: number;
	items: PersistedReloadInbound[];
}

interface ReloadQueueGuardEntry {
	key: string;
	filePath: string;
	sessionId: string;
	endpoint: string;
	items: PersistedReloadInbound[];
	bindSignals: boolean;
	timer: NodeJS.Timeout | null;
}

interface ReloadQueueGuardRegistry {
	entries: Map<string, ReloadQueueGuardEntry>;
	exitListenersBound: boolean;
	signalListenersBound: boolean;
	signalCleanupInFlight: boolean;
	onBeforeExit: () => void;
	onExit: () => void;
	onSigint: () => void;
	onSigterm: () => void;
}

const RELOAD_QUEUE_GUARDS_SYMBOL = Symbol.for("pi.coms.reloadQueueGuards");

const EXIT_NOTIFY_RELOAD_CLOSED_SCRIPT = [
	'const net = require("net");',
	'const fs = require("fs");',
	'const data = JSON.parse(fs.readFileSync(0, "utf8"));',
	'const items = Array.isArray(data.items) ? data.items : [];',
	'const tasks = items.map((ib) => new Promise((resolve) => {',
	'  let done = false;',
	'  let buf = "";',
	'  const finish = (ok) => { if (!done) { done = true; clearTimeout(t); try { sock.destroy(); } catch {} resolve(ok); } };',
	'  const sock = net.createConnection({ path: ib.sender_endpoint });',
	'  const t = setTimeout(() => finish(false), 450);',
	'  sock.on("data", (chunk) => {',
	'    if (done) return;',
	'    buf += chunk.toString("utf8");',
	'    if (buf.length > 65536) { finish(false); return; }',
	'    const nl = buf.indexOf("\\n");',
	'    if (nl < 0) return;',
	'    try {',
	'      const parsed = JSON.parse(buf.slice(0, nl));',
	'      finish(Boolean(parsed && parsed.type === "ack" && parsed.msg_id === ib.msg_id));',
	'    } catch { finish(false); }',
	'  });',
	'  sock.once("connect", () => {',
	'    const line = JSON.stringify({',
	'      type: "response",',
	'      msg_id: ib.msg_id,',
	'      sender_session: data.sessionId,',
	'      sender_endpoint: data.endpoint,',
	'      hops: 0,',
	'      timestamp: new Date().toISOString(),',
	'      response: null,',
	'      error: "session_closed",',
	'      queued_msg_ids: [],',
	'    }) + "\\n";',
	'    sock.write(line);',
	'  });',
	'  sock.once("end", () => finish(false));',
	'  sock.once("close", () => finish(false));',
	'  sock.once("error", () => finish(false));',
	'}));',
	'Promise.all(tasks).then((results) => { process.exit(results.every(Boolean) ? 0 : 1); });',
].join("\n");

function notifyClosedReloadItemsSync(
	sessionId: string,
	endpoint: string,
	items: PersistedReloadInbound[],
): boolean {
	if (items.length === 0) return true;
	try {
		const res = spawnSync(process.execPath, ["-e", EXIT_NOTIFY_RELOAD_CLOSED_SCRIPT], {
			input: JSON.stringify({ sessionId, endpoint, items }),
			timeout: 750,
			stdio: ["pipe", "ignore", "ignore"],
		});
		return res.status === 0;
	} catch (err) {
		log.error("reload_queue_exit_notify_failed", {
			sessionId,
			count: items.length,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

function getReloadQueueGuardRegistry(): ReloadQueueGuardRegistry {
	const g = globalThis as Record<symbol, ReloadQueueGuardRegistry | undefined>;
	let reg = g[RELOAD_QUEUE_GUARDS_SYMBOL];
	if (!reg) {
		const created: ReloadQueueGuardRegistry = {
			entries: new Map(),
			exitListenersBound: false,
			signalListenersBound: false,
			signalCleanupInFlight: false,
			onBeforeExit: () => {
				for (const key of [...created.entries.keys()]) {
					void expireReloadQueueGuard(key, "process_before_exit");
				}
			},
			onSigint: () => { handleReloadGuardSignal("SIGINT"); },
			onSigterm: () => { handleReloadGuardSignal("SIGTERM"); },
			onExit: () => {
				const pending = [...created.entries.values()];
				created.entries.clear();
				unbindReloadExitListenersIfEmpty(created);
				for (const entry of pending) {
					if (entry.timer) {
						try { clearTimeout(entry.timer); } catch { /* ignore */ }
						entry.timer = null;
					}
					if (!fs.existsSync(entry.filePath)) continue;
					const notified = notifyClosedReloadItemsSync(entry.sessionId, entry.endpoint, entry.items);
					if (notified) {
						try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ }
					} else {
						log.error("reload_queue_exit_notify_incomplete", {
							sessionId: entry.sessionId,
							filePath: entry.filePath,
							count: entry.items.length,
						});
					}
				}
			},
		};
		const handleReloadGuardSignal = (signal: "SIGINT" | "SIGTERM") => {
			if (created.signalCleanupInFlight) return;
			created.signalCleanupInFlight = true;
			if (created.signalListenersBound) {
				process.off("SIGINT", created.onSigint);
				process.off("SIGTERM", created.onSigterm);
				created.signalListenersBound = false;
			}
			const keys = [...created.entries.keys()];
			void Promise.allSettled(
				keys.map((key) => expireReloadQueueGuard(key, `signal_${signal}`)),
			).finally(() => {
				created.signalCleanupInFlight = false;
				if (process.listenerCount(signal) === 0) {
					try {
						process.kill(process.pid, signal);
					} catch {
						process.exit(signal === "SIGINT" ? 130 : 143);
					}
				}
			});
		};
		g[RELOAD_QUEUE_GUARDS_SYMBOL] = created;
		reg = created;
	}
	return reg;
}

function unbindReloadExitListenersIfEmpty(reg: ReloadQueueGuardRegistry): void {
	if (reg.entries.size === 0 && reg.exitListenersBound) {
		process.off("beforeExit", reg.onBeforeExit);
		process.off("exit", reg.onExit);
		reg.exitListenersBound = false;
	}
	const wantsSignals = [...reg.entries.values()].some((e) => e.bindSignals);
	if (!wantsSignals && reg.signalListenersBound) {
		process.off("SIGINT", reg.onSigint);
		process.off("SIGTERM", reg.onSigterm);
		reg.signalListenersBound = false;
	}
}

function disarmReloadQueueGuard(key: string): void {
	const reg = getReloadQueueGuardRegistry();
	const existing = reg.entries.get(key);
	if (!existing) return;
	if (existing.timer) {
		try { clearTimeout(existing.timer); } catch { /* ignore */ }
		existing.timer = null;
	}
	reg.entries.delete(key);
	unbindReloadExitListenersIfEmpty(reg);
}

function claimReloadQueueFile(filePath: string): ReloadQueuePayload | null {
	const claimPath = `${filePath}.${process.pid}.${ulid()}.claim`;
	try {
		fs.renameSync(filePath, claimPath);
	} catch (err: any) {
		if (err?.code === "ENOENT") return null;
		log.warn("reload_queue_claim_failed", { filePath, error: err?.message ?? String(err) });
		return null;
	}
	try {
		const raw = fs.readFileSync(claimPath, "utf-8");
		const parsed = JSON.parse(raw) as ReloadQueuePayload;
		if (
			!parsed
			|| typeof parsed !== "object"
			|| parsed.version !== 1
			|| typeof parsed.session_id !== "string"
			|| !Array.isArray(parsed.items)
		) {
			log.warn("reload_queue_malformed", { filePath });
			return null;
		}
		return parsed;
	} catch (err: any) {
		log.warn("reload_queue_read_failed", { filePath, error: err?.message ?? String(err) });
		return null;
	} finally {
		try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
	}
}

async function notifyClosedReloadItems(
	sessionId: string,
	endpoint: string,
	items: PersistedReloadInbound[],
): Promise<void> {
	if (items.length === 0) return;
	let notifyTimeout: NodeJS.Timeout | undefined;
	await Promise.race([
		Promise.allSettled(items.map((ib) =>
			sendEnvelope(ib.sender_endpoint, {
				type: "response",
				msg_id: ib.msg_id,
				sender_session: sessionId,
				sender_endpoint: endpoint,
				hops: 0,
				timestamp: nowIso(),
				response: null,
				error: "session_closed",
				queued_msg_ids: [],
			}).catch((err) => {
				log.error("reload_queue_notify_closed_failed", {
					msg_id: ib.msg_id,
					sender: ib.sender_endpoint,
					error: err instanceof Error ? err.message : String(err),
				});
			}),
		)),
		new Promise<void>((resolve) => {
			notifyTimeout = setTimeout(resolve, 500);
			notifyTimeout.unref?.();
		}),
	]);
	if (notifyTimeout) clearTimeout(notifyTimeout);
}

async function expireReloadQueueGuard(key: string, reason: string): Promise<void> {
	const reg = getReloadQueueGuardRegistry();
	const entry = reg.entries.get(key);
	if (!entry) return;
	disarmReloadQueueGuard(key);
	const payload = claimReloadQueueFile(entry.filePath);
	if (!payload || payload.items.length === 0) return;
	log.warn("reload_queue_expired_cleanup", {
		reason,
		sessionId: payload.session_id,
		count: payload.items.length,
	});
	await notifyClosedReloadItems(payload.session_id, payload.endpoint, payload.items);
}

function persistReloadQueue(
	reg: ComsRegistry,
	project: string,
	sessionId: string,
	endpoint: string,
	items: PersistedReloadInbound[],
	ttlMs: number,
	bindSignals = true,
): string {
	const filePath = reg.reloadQueuePath(project, sessionId);
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const now = Date.now();
	const payload: ReloadQueuePayload = {
		version: 1,
		session_id: sessionId,
		project,
		endpoint,
		saved_at_ms: now,
		expires_at_ms: now + Math.max(1, ttlMs),
		pid: process.pid,
		items,
	};
	const tmpPath = `${filePath}.${process.pid}.${ulid()}.tmp`;
	try {
		fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
		if (process.platform !== "win32") {
			try { fs.chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }
		}
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		throw err;
	}

	const guardReg = getReloadQueueGuardRegistry();
	disarmReloadQueueGuard(filePath);
	const timer = setTimeout(() => {
		void expireReloadQueueGuard(filePath, "ttl_expired");
	}, Math.max(1, ttlMs));
	timer.unref?.();
	guardReg.entries.set(filePath, {
		key: filePath,
		filePath,
		sessionId,
		endpoint,
		items: [...items],
		bindSignals,
		timer,
	});
	if (!guardReg.exitListenersBound) {
		process.on("beforeExit", guardReg.onBeforeExit);
		process.on("exit", guardReg.onExit);
		guardReg.exitListenersBound = true;
	}
	if (bindSignals && !guardReg.signalListenersBound) {
		process.on("SIGINT", guardReg.onSigint);
		process.on("SIGTERM", guardReg.onSigterm);
		guardReg.signalListenersBound = true;
	}
	log.info("reload_queue_persisted", {
		sessionId,
		project,
		count: items.length,
		ttlMs,
		filePath,
	});
	return filePath;
}

async function discardReloadQueue(
	reg: ComsRegistry,
	project: string,
	sessionId: string,
	reason: string,
): Promise<void> {
	let filePath: string;
	try {
		filePath = reg.reloadQueuePath(project, sessionId);
	} catch {
		return;
	}
	disarmReloadQueueGuard(filePath);
	const payload = claimReloadQueueFile(filePath);
	if (!payload) return;
	log.info("reload_queue_discarded", {
		reason,
		sessionId: payload.session_id,
		project,
		count: payload.items.length,
	});
	await notifyClosedReloadItems(payload.session_id, payload.endpoint, payload.items);
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

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function bindEndpoint(
	endpoint: string,
	connHandler: (socket: net.Socket) => void,
	cwd = process.cwd(),
): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		const verdict = await probeStaleSocket(endpoint, undefined, cwd);
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
				// The response is complete. Destroy the outbound client now instead of
				// waiting for the peer's half-close, which can outlive a test session.
				try { sock.destroy(); } catch { /* ignore */ }
				log.debug("coms_envelope_sent", { type: envelope.type, has_msg_id: !!envelope.msg_id });
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

export const PENDING_REPLY_CLEANUP_DELAY_MS = 60_000;

const HEADLESS_PEER_ASK_USER_GUIDANCE =
	"Headless COMS peer: `ask_user` is blocked/unavailable because no interactive TUI is attached. " +
	"Never call `ask_user` — whenever you need user input, decisions, clarifications, or approvals, " +
	"ask the main LLM / requesting peer via `coms_send` (or in your reply to an inbound coms message).";

function isHeadlessOrSupervisedPeer(peerCtx?: ExtensionContext | null): boolean {
	if (process.env.PI_COMS_SUPERVISED_PEER === "1") return true;
	if (!peerCtx || !isLiveExtensionCtx(peerCtx)) return false;
	if (!peerCtx.hasUI) return true;
	if (peerCtx.mode !== undefined && peerCtx.mode !== "tui") return true;
	return false;
}

// ━━ Compact TUI Message Renderers (#1454) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function renderComsPeerJoinedMessage(
	message: CompactCustomMessage<ComsPeerEventDetails>,
	options: CompactMessageRenderOptions,
	theme: Theme,
): Component {
	const body = extractMessageText(message.content);
	if (options.expanded) {
		return createExpandedCustomBox(COMS_PEER_JOINED_CUSTOM_TYPE, body, options.outputPad, theme);
	}
	const details = message.details && typeof message.details === "object"
		? (message.details as Partial<ComsPeerEventDetails>)
		: undefined;
	const rawPeer = details?.peer || body.match(/Peer joined:\s*([^\s(\[]+)/)?.[1] || "peer";
	const peer = sanitizeComsName(rawPeer);
	const prefix = `${theme.fg("accent", "📡")} ${theme.fg("success", "+")} ${theme.bold(peer)} ${theme.fg("dim", "joined")}`;
	return createCompactOneLineComponent({ prefix, outputPad: options.outputPad });
}

export function renderComsPeerLeftMessage(
	message: CompactCustomMessage<ComsPeerEventDetails>,
	options: CompactMessageRenderOptions,
	theme: Theme,
): Component {
	const body = extractMessageText(message.content);
	if (options.expanded) {
		return createExpandedCustomBox(COMS_PEER_LEFT_CUSTOM_TYPE, body, options.outputPad, theme);
	}
	const details = message.details && typeof message.details === "object"
		? (message.details as Partial<ComsPeerEventDetails>)
		: undefined;
	const rawPeer = details?.peer || body.match(/Peer left:\s*([^\s\[]+)/)?.[1] || "peer";
	const peer = sanitizeComsName(rawPeer);
	const prefix = `${theme.fg("dim", "📡")} ${theme.fg("warning", "-")} ${theme.fg("muted", peer)} ${theme.fg("dim", "left")}`;
	return createCompactOneLineComponent({ prefix, outputPad: options.outputPad });
}

export function renderComsResponseMessage(
	message: CompactCustomMessage<ComsResponseDetails>,
	options: CompactMessageRenderOptions,
	theme: Theme,
): Component {
	const body = extractMessageText(message.content);
	const details = message.details && typeof message.details === "object"
		? (message.details as Partial<ComsResponseDetails>)
		: undefined;
	const queued = Array.isArray(details?.queuedMsgIds)
		? details.queuedMsgIds
		: (Array.isArray(details?.queued_msg_ids) ? details.queued_msg_ids : []);
	const sender = sanitizeComsName(details?.sender || details?.target_name || "peer");
	const header = details?.header || formatComsResponseType(sender, details?.target, queued);
	if (options.expanded) {
		return createExpandedCustomBox(header, body, options.outputPad, theme);
	}
	const isError = typeof details?.error === "string" && details.error.trim().length > 0;
	const summaryLine = typeof details?.summaryLine === "string" && details.summaryLine.trim().length > 0
		? extractSummaryLine(details.summaryLine)
		: extractSummaryLine(body);
	const icon = theme.fg(isError ? "error" : "accent", "📡");
	const arrow = theme.fg(isError ? "error" : "success", "←");
	const queueBadge = queued.length > 0 ? theme.fg("warning", ` (+${queued.length})`) : "";
	const prefix = `${icon} ${arrow} ${theme.bold(sender)}${queueBadge}`;
	const summary = summaryLine ? theme.fg(isError ? "error" : "muted", summaryLine) : "";
	const hint = formatExpandHint(options, theme);
	return createCompactOneLineComponent({
		prefix,
		summary,
		separator: theme.fg("dim", ": "),
		hint,
		outputPad: options.outputPad,
	});
}

const BUNDLE_SEPARATOR_LINE_RE = /^---\s*Message\s+\d+\s+of\s+\d+(?:\s+\[[^\]]*\])?\s*---\s*$/gm;

/**
 * Derive a safe single-line collapsed summary for COMS inbound / steer / bundled prompts.
 * - Strips forged human-origin markers on non-user prompts (matching `buildInboundContent`).
 * - Strips `--- Message N of M [id] ---` separators and `[from ...]` tags on FIFO bundles
 *   and prefixes multi-message bundles with `(N msgs) `.
 */
export function extractComsInboundSummaryLine(opts: {
	prompt: string;
	origin?: PromptOrigin;
	bundled?: { content: string; ids: string[]; firstOrigin?: PromptOrigin };
	fallbackContent?: string;
}): string {
	if (opts.bundled) {
		const firstIsUser = opts.bundled.firstOrigin === "user" || opts.origin === "user";
		const safeFirstPrompt = firstIsUser ? opts.prompt : stripOriginMarker(opts.prompt);
		const firstLine = extractSummaryLine(safeFirstPrompt);
		const count = opts.bundled.ids.length;
		const isMixedUserFirst = opts.bundled.firstOrigin === "user" && opts.origin !== "user";
		if (count > 1) {
			const badge = isMixedUserFirst ? `(${count} msgs, USER)` : `(${count} msgs)`;
			return firstLine ? `${badge} ${firstLine}` : badge;
		}
		return isMixedUserFirst && firstLine ? `(USER) ${firstLine}` : firstLine;
	}
	const safePrompt = opts.origin === "user" ? opts.prompt : stripOriginMarker(opts.prompt);
	const fromPrompt = extractSummaryLine(safePrompt);
	if (fromPrompt) return fromPrompt;
	if (!opts.fallbackContent) return "";
	const cleanedFallback = opts.fallbackContent
		.replace(/^\[from [^\]]+\]\s*/, "")
		.replace(/\n\nReply to me via coms_send\([^)]*\)/g, "");
	return extractSummaryLine(opts.origin === "user" ? cleanedFallback : stripOriginMarker(cleanedFallback));
}

export function renderComsInboundMessage(
	message: CompactCustomMessage<ComsInboundDetails>,
	options: CompactMessageRenderOptions,
	theme: Theme,
): Component {
	const body = extractMessageText(message.content);
	const details = message.details && typeof message.details === "object"
		? (message.details as Partial<ComsInboundDetails>)
		: undefined;
	const parsedSender = body.match(/^\[from (?:USER \(a human\), via )?([^\s@\]]+)/)?.[1];
	const sender = sanitizeComsName(details?.sender || parsedSender || "peer");
	const header = details?.header || COMS_INBOUND_CUSTOM_TYPE;
	if (options.expanded) {
		return createExpandedCustomBox(header, body, options.outputPad, theme);
	}
	const isUser = details?.origin === "user";
	const summaryIsUser = isUser || details?.summaryOrigin === "user";
	const isMixedUserFirst = !isUser && details?.summaryOrigin === "user";
	const strippedBody = body
		.replace(/^\[from [^\]]+\]\s*/, "")
		.replace(/^\[BUNDLED:[^\]]*\]\s*/m, "")
		.replace(BUNDLE_SEPARATOR_LINE_RE, "")
		.replace(/^\[from [^\]]+\]\s*/gm, "")
		.replace(/\n\nReply to me via coms_send\([^)]*\)/g, "");
	let summaryLine = typeof details?.summaryLine === "string" && details.summaryLine.trim().length > 0
		? extractSummaryLine(summaryIsUser ? details.summaryLine : stripOriginMarker(details.summaryLine))
		: extractSummaryLine(summaryIsUser ? strippedBody : stripOriginMarker(strippedBody));
	const bundledCount = Array.isArray(details?.bundled_msg_ids) ? details.bundled_msg_ids.length : 0;
	if (bundledCount > 1 && !summaryLine.startsWith(`(${bundledCount} msgs`)) {
		const badge = isMixedUserFirst ? `(${bundledCount} msgs, USER)` : `(${bundledCount} msgs)`;
		summaryLine = summaryLine ? `${badge} ${summaryLine}` : badge;
	} else if (bundledCount <= 1 && isMixedUserFirst && !summaryLine.startsWith("(USER)")) {
		summaryLine = summaryLine ? `(USER) ${summaryLine}` : "(USER)";
	}
	const tags: string[] = [];
	if (isUser) tags.push(theme.fg("warning", "USER"));
	if (details?.steer) tags.push(theme.fg("warning", "steer"));
	const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
	const prefix = `${theme.fg("accent", "📡")} ${theme.fg("accent", "←")} ${theme.bold(sender)}${tagSuffix}`;
	const summary = summaryLine ? theme.fg("muted", summaryLine) : "";
	const hint = formatExpandHint(options, theme);
	return createCompactOneLineComponent({
		prefix,
		summary,
		separator: theme.fg("dim", ": "),
		hint,
		outputPad: options.outputPad,
	});
}

export function registerComsMessageRenderers(pi: ExtensionAPI): void {
	if (typeof pi.registerMessageRenderer !== "function") return;
	pi.registerMessageRenderer<ComsPeerEventDetails>(COMS_PEER_JOINED_CUSTOM_TYPE, renderComsPeerJoinedMessage);
	pi.registerMessageRenderer<ComsPeerEventDetails>(COMS_PEER_LEFT_CUSTOM_TYPE, renderComsPeerLeftMessage);
	pi.registerMessageRenderer<ComsResponseDetails>(COMS_RESPONSE_CUSTOM_TYPE, renderComsResponseMessage);
	pi.registerMessageRenderer<ComsInboundDetails>(COMS_INBOUND_CUSTOM_TYPE, renderComsInboundMessage);
	log.debug("registered_coms_message_renderers", {
		types: [
			COMS_PEER_JOINED_CUSTOM_TYPE,
			COMS_PEER_LEFT_CUSTOM_TYPE,
			COMS_RESPONSE_CUSTOM_TYPE,
			COMS_INBOUND_CUSTOM_TYPE,
		],
	});
}

// ━━ Instantiable Peer Runtime & Default Export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function createComsPeerRuntime(
	pi: ExtensionAPI,
	options: ComsPeerRuntimeOptions = {},
): ComsPeerRuntime {
	const gatedToolNames = new Set<string>();
	if (process.env.PI_SUBAGENT_CHILD === "1" && !options.allowSubagentChild) {
		return {
			start: async () => null,
			stop: async () => {},
			getSelf: () => null,
			isActive: () => false,
			sendAsUser: async () => ({ ok: false, message: "coms is disabled in subagent child sessions." }),
			openQueueOverlay: async (_args: string, ctx: any) => {
				try { ctx?.ui?.notify?.("📡 coms not active — no queue. Activate coms with coms_start first.", "info"); } catch { /* ignore */ }
			},
			gatedToolNames,
		};
	}
	const deferred = options.deferred === true;
	const inactiveMessage = options.inactiveMessage ?? "⚠️ coms not active. Call `coms_start` first.";
	const registerSignalHandlers = options.registerSignalHandlers !== false;

	// Per-instance runtime configuration & registry (zero module-level mutable globals).
	let runtimeCwd = process.cwd();
	let registry = new ComsRegistry(options.comsDir || resolveComsDir(runtimeCwd));
	let maxHops = 5;
	let timeoutMs = 1_800_000;
	let signalsBound = false;

	registerComsMessageRenderers(pi);

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

	function readEffectiveCliFlags(startFlags?: ComsPeerFlagOverrides): CliFlags {
		const pick = (key: keyof ComsPeerFlagOverrides): unknown => {
			if (startFlags && startFlags[key] !== undefined) return startFlags[key];
			if (options.getFlag) {
				const fromOpt = options.getFlag(key);
				if (fromOpt !== undefined) return fromOpt;
			}
			return pi.getFlag(key);
		};
		const name = pick("cname") as string | undefined;
		const purpose = pick("purpose") as string | undefined;
		const project = pick("project") as string | undefined;
		const color = pick("color") as string | undefined;
		const explicit = pick("explicit") as boolean | undefined;
		return {
			name: name && name.length > 0 ? name : undefined,
			purpose: purpose && purpose.length > 0 ? purpose : undefined,
			project: project && project.length > 0 ? project : undefined,
			color: color && color.length > 0 ? color : undefined,
			explicit: explicit === true,
		};
	}

	const registerPeerTool: ExtensionAPI["registerTool"] = (tool) => {
		if (typeof tool?.name === "string" && tool.name) {
			gatedToolNames.add(tool.name);
		}
		const enriched = {
			...tool,
			exposure: tool.exposure ?? ("codemode" as const),
			namespace: tool.namespace ?? TOOL_NAMESPACES.coms,
		};
		if (!deferred) {
			pi.registerTool(enriched);
			return;
		}
		const origExecute = enriched.execute;
		pi.registerTool({
			...enriched,
			defaultActive: false,
			execute: async (callId, params, signal, onUpdate, ctx) => {
				if (!identity) {
					return {
						content: [{ type: "text" as const, text: inactiveMessage }],
						details: {} as any,
					};
				}
				return origExecute(callId, params, signal, onUpdate, ctx);
			},
		});
	};

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
		origin?: string | null;
		pi_session_id: string;
		task_store_path: string | null;
	} | null = null;
	const initialPiTasks = process.env.PI_TASKS;
	const initialTaskScope: "session" | "project" = process.env.PI_TASK_SCOPE === "project" ? "project" : "session";
	const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
	let welcomeShown = false;
	const knownPeerSessions: Map<string, string> = new Map(); // session_id → name
	const pendingReplies: Map<string, PendingReply> = new Map();
	/** Track pending (unresponded) outbound msg_ids per target name. */
	const pendingOutbound: Map<string, Set<string>> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	/** Destructive recovery is valid only after an explicit, short-lived inspect preview. */
	const queueRecoveryPreviews = new Map<string, { targetSession: string; itemIds: string[]; expiresAt: number }>();

	function pruneQueueRecoveryPreviews(now = Date.now()): void {
		let removed = 0;
		for (const [previewId, preview] of queueRecoveryPreviews) {
			if (preview.expiresAt <= now) {
				queueRecoveryPreviews.delete(previewId);
				removed++;
			}
		}
		if (removed) log.debug("recovery_previews_pruned", { removed, remaining: queueRecoveryPreviews.size });
	}

	function retainQueueRecoveryPreview(previewId: string, targetSession: string, itemIds: string[]): void {
		pruneQueueRecoveryPreviews();
		const sessionPreviews = [...queueRecoveryPreviews.entries()].filter(([, preview]) => preview.targetSession === targetSession);
		for (const [expiredId] of sessionPreviews.slice(0, Math.max(0, sessionPreviews.length - MAX_RECOVERY_PREVIEWS_PER_SESSION + 1))) queueRecoveryPreviews.delete(expiredId);
		queueRecoveryPreviews.set(previewId, { targetSession, itemIds, expiresAt: Date.now() + RECOVERY_PREVIEW_TTL_MS });
		log.debug("recovery_preview_retained", { session: targetSession, count: itemIds.length, active: queueRecoveryPreviews.size });
	}
	let server: net.Server | null = null;
	const connections = new Set<net.Socket>();
	let fsWatcher: fs.FSWatcher | null = null;
	let pingWorker: Worker | null = null;
	let pingWorkerReady = false;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	let staleCheckTimer: NodeJS.Timeout | null = null;
	const pendingReplyCleanupTimers = new Set<NodeJS.Timeout>();
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	/** Inbound msg_id deferred on agent_end while malformed-response recovery runs (#1333). */
	let deferredRecoveryInboundId: string | null = null;
	let deferredRecoveryCtx: ExtensionContext | null = null;
	let recoverySessionKey: string = DEFAULT_BRIDGE_SESSION_KEY;
	let unsubMalformedRecoveryAborted: (() => void) | null = null;
	/** True once Pi emits message_start for currentInbound (#1226). */
	let inboundDelivered = false;
	/** Re-entrancy guard while finalizeCurrentInbound is awaiting I/O (#1226). */
	let finalizingInbound = false;
	/** Monotonic generation incremented on session_start and cleanShutdown (#1226). */
	let sessionGeneration = 0;
	/** msg_ids whose response send is already owned by an in-flight finalizer (#1226). */
	const finalizingMsgIds = new Set<string>();
	/** Undelivered inbound msg_ids closed by cleanShutdown() whose followUp copy may still sit in Pi's queue (#1226). */
	const closedInboundMsgIds = new Set<string>();
	/** Delivered inbound msg_ids that had pending followUp steers when cleanShutdown() ran (#1226). */
	const closedSteerTargetIds = new Set<string>();
	/** #1429/#1430: minimum active inject_attempt per msg_id so older queued followUp copies are suppressed. */
	const supersededInboundAttempts = new Map<string, number>();
	const MAX_CLOSED_INBOUND_IDS = 500;
	const reloadQueueTtlMs = options.reloadQueueTtlMs ?? RELOAD_QUEUE_TTL_MS;
	let reloadDrainTimer: NodeJS.Timeout | null = null;
	let lastReloadHandoff: { project: string; sessionId: string } | null = null;
	let lastTurnStopReason: string | null = null;
	let pendingSettledAction:
		| { kind: "reinject"; inbound: InboundContext; gen: number; ctx?: ExtensionContext | null }
		| { kind: "drain"; gen: number; ctx?: ExtensionContext | null }
		| null = null;
	/** True while an agent run is active (agent_start -> agent_end) (#1226). */
	let agentRunning = false;
	/** True only during the pre-run window between before_agent_start and agent_start/agent_end/agent_settled (#1466). */
	let beforeAgentStartPending = false;
	/** Last peer-visible busy value published to registry/card (#1466). */
	let lastReportedBusy = false;
	let bundledInbounds: InboundContext[] = [];
	let processingInbound = false;
	/** Set when the active inbound is killed mid-turn so agent_end drains queued follow-ups (#1384). */
	let pendingDrainAfterKill = false;

	function rememberClosedId(target: Set<string>, msgId: string): void {
		if (!msgId || target.has(msgId)) return;
		if (target.size >= MAX_CLOSED_INBOUND_IDS) {
			const oldest = target.values().next().value;
			if (oldest !== undefined) target.delete(oldest);
		}
		target.add(msgId);
	}

	function rememberSupersededAttempt(msgId: string, minAttempt: number): void {
		if (!msgId || minAttempt <= 0) return;
		const existing = supersededInboundAttempts.get(msgId);
		if (existing !== undefined && existing >= minAttempt) return;
		if (existing === undefined && supersededInboundAttempts.size >= MAX_CLOSED_INBOUND_IDS) {
			const oldest = supersededInboundAttempts.keys().next().value;
			if (oldest !== undefined) supersededInboundAttempts.delete(oldest);
		}
		supersededInboundAttempts.set(msgId, minAttempt);
	}

	function isSupersededComsMessage(msg: any): boolean {
		if (msg?.role !== "custom" || !msg?.details || typeof msg.details !== "object") return false;
		const d = msg.details;
		const attempt = typeof d.inject_attempt === "number" ? d.inject_attempt : 0;
		if (typeof d.msg_id === "string") {
			const minAttempt = supersededInboundAttempts.get(d.msg_id);
			if (minAttempt !== undefined && attempt < minAttempt) return true;
		}
		if (Array.isArray(d.bundled_msg_ids)) {
			for (const id of d.bundled_msg_ids) {
				if (typeof id !== "string") continue;
				const minAttempt = supersededInboundAttempts.get(id);
				if (minAttempt !== undefined && attempt < minAttempt) return true;
			}
		}
		return false;
	}

	function isClosedComsMessage(msg: any): boolean {
		if (msg?.role !== "custom" || !msg?.details || typeof msg.details !== "object") return false;
		const d = msg.details;
		if (typeof d.msg_id === "string" && closedInboundMsgIds.has(d.msg_id)) return true;
		if (
			d.steer === true
			&& typeof d.target_msg_id === "string"
			&& (closedInboundMsgIds.has(d.target_msg_id) || closedSteerTargetIds.has(d.target_msg_id))
		) {
			return true;
		}
		if (
			Array.isArray(d.bundled_msg_ids)
			&& d.bundled_msg_ids.some((id: unknown) => typeof id === "string" && closedInboundMsgIds.has(id))
		) {
			return true;
		}
		return false;
	}

	function extractAssistantText(message: any): string {
		if (!message || message.role !== "assistant") return "";
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("\n");
		}
		return "";
	}

	function isAutoCaptureReplyBlocked(targetSession: string): boolean {
		return (
			processingInbound
			&& inboundDelivered
			&& !userMessageDuringInbound
			&& currentInbound !== null
			&& !currentInbound.fulfilled
			&& targetSession === currentInbound.sender_session
		);
	}

	/** Busy state is peer-visible (#924 §3): rewrite the registry entry the
	 *  moment processingInbound flips so peers' ⚙busy indicators track the
	 *  transition immediately, not on the next 30s keepalive heartbeat. */
	function setProcessingInbound(value: boolean): void {
		if (processingInbound === value) return;
		processingInbound = value;
		log.debug("busy_transition", value);
		writeLiveRegistry();
	}

	/** True while Pi is executing an agent turn. Prefers live ctx.isIdle() when available so a
	 *  missed agent_end/agent_settled or failed before_agent_start self-heals; falls back to
	 *  lifecycle flags (agentRunning || beforeAgentStartPending) when ctx.isIdle is unavailable (#1466). */
	function isAgentBusy(ctx?: ExtensionContext | null): boolean {
		const activeCtx = typeof ctx?.isIdle === "function" ? ctx : currentCtx;
		if (activeCtx && isLiveExtensionCtx(activeCtx) && typeof activeCtx.isIdle === "function") {
			try {
				const idle = activeCtx.isIdle();
				if (typeof idle === "boolean") return !idle;
			} catch {
				// Fall through to lifecycle flags if ctx.isIdle() throws.
			}
		}
		return agentRunning || beforeAgentStartPending;
	}

	/** Refresh the live registry + ping card whenever peer-visible busy transitions (or forced) (#1466). */
	function syncBusyState(
		ctx?: ExtensionContext | null,
		opts?: { force?: boolean; syncRegistry?: boolean; reason?: string },
	): void {
		const busyNow = processingInbound || isAgentBusy(ctx);
		const busyChanged = busyNow !== lastReportedBusy;
		if (busyChanged) {
			log.debug("agent_busy_transition", {
				busy: busyNow,
				agentRunning,
				beforeAgentStartPending,
				processingInbound,
				...(opts?.reason ? { reason: opts.reason } : {}),
			});
		}
		if (opts?.syncRegistry === false) return;
		if (identity && !shuttingDown && (opts?.force || busyChanged)) {
			writeLiveRegistry(ctx);
		}
	}

	/** #1083: this peer's own active workload — agents from the orchestrator bridge, tasks from
	 *  the published task store, crons from the orchestrator (session crons exist ONLY there).
	 *  Null when any source is absent: a partial count would be a guess, and the viewer must show
	 *  `unknown` instead. No filesystem fallback: this reads own in-process state only. */
	function ownWorkload(): { counts: PeerWorkloadCounts; active: ActiveWorkload; tasksSummary: TasksSummary | null } | null {
		const sessionKey = resolveOwnPiSessionId(currentCtx) || undefined;
		const sources = publishedWorkloadSources(sessionKey);
		const store = publishedTaskStore(sessionKey) as { list?: () => unknown[] } | null;
		if (!sources || typeof store?.list !== "function") {
			log.debug("workload_sources_missing", { agentsAndCrons: !!sources, tasks: typeof store?.list === "function" });
			return null;
		}
		try {
			const all = (store.list() ?? []) as any[];
			// #1084: a blocker that is completed (or gone from the store) no longer holds the task,
			// so the flag is derived from the blocker's own status, not from the ids alone.
			const statusById = new Map(all.map((t) => [String(t?.id ?? ""), String(t?.status ?? "")]));
			const tasks: WorkloadTask[] = all.map((t) => ({
				id: String(t?.id ?? "?"),
				status: String(t?.status ?? ""),
				subject: String(t?.subject ?? ""),
				// #1084: the requester's detail pane shows owner and description; both are the
				// peer's own fields, so they travel with the projection instead of a second request.
				owner: String(t?.owner ?? ""),
				description: String(t?.description ?? ""),
				// #1082: the drilldown marks blocked tasks, so the open blockers survive the projection.
				blockedBy: openBlockers(Array.isArray(t?.blockedBy) ? t.blockedBy.map(String) : [], statusById),
				// #1090: the drilldown tags the owner's rows; the agent-task count ignores them.
				assignee: String(t?.assignee ?? "llm"),
			}));
			return { ...collectWorkload(sources.agents(), tasks, sources.crons()), tasksSummary: summarizeTaskList(all) };
		} catch (err) {
			log.warn("workload_collect_failed", err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	/** #1080: resolve this peer's own Pi session ID from its ExtensionContext first, before
	 *  orchestrator's session_start sets `__piConfigSessionId` (coms loads alphabetically earlier). */
	function resolveOwnPiSessionId(ctx?: ExtensionContext | null): string {
		const fromCtx = ctx?.sessionManager?.getSessionId?.();
		if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim();
		if (identity?.pi_session_id) return identity.pi_session_id;
		const fromGlobal = (globalThis as any).__piConfigSessionId;
		return typeof fromGlobal === "string" ? fromGlobal.trim() : "";
	}

	/** #1080: compute the exact TaskStore file path this peer's pitasks instance reads/watches.
	 *  Prefer the live published TaskStore's own filePath first so mid-session PI_TASKS /
	 *  PI_TASK_SCOPE mutations never desync advertised task_store_path from pitasks. */
	function resolveOwnTaskStorePath(piSessionId: string, cwd: string): string | null {
		const liveStore = publishedTaskStore(piSessionId || undefined) as { filePath?: string } | null;
		const publishedFilePath = typeof liveStore?.filePath === "string" && liveStore.filePath.trim()
			? liveStore.filePath.trim()
			: null;
		if (publishedFilePath) {
			log.debug("own_task_store_path_resolved", {
				source: "published_task_store",
				hasPiSessionId: Boolean(piSessionId),
				hasStorePath: true,
			});
			return publishedFilePath;
		}
		const storePath = resolveStorePath(piSessionId || undefined, {
			cwd,
			piTasks: initialPiTasks,
			taskScope: initialTaskScope,
		}) ?? null;
		log.debug("own_task_store_path_resolved", {
			source: "fallback_store_path",
			hasPiSessionId: Boolean(piSessionId),
			hasStorePath: Boolean(storePath),
		});
		return storePath;
	}

	/** Write a live registry entry snapshot (shared by the keepalive timer and
	 *  busy transitions). Fail-soft. */
	function writeLiveRegistry(busyCtx?: ExtensionContext | null): void {
		if (!identity || shuttingDown) return;
		try {
			const ctx = currentCtx;
			const piSessionId = resolveOwnPiSessionId(ctx);
			const taskStorePath = resolveOwnTaskStorePath(piSessionId, identity.cwd);
			identity.pi_session_id = piSessionId;
			identity.task_store_path = taskStorePath;
			const workload = ownWorkload();
			const busy = processingInbound || isAgentBusy(busyCtx ?? ctx);
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
				context_used_pct: Math.round(ctx?.getContextUsage?.()?.percent ?? 0),
				queue_depth: getPendingInboundCount(),
				busy,
				heartbeat_at: nowIso(),
				pi_session_id: piSessionId,
				task_store_path: taskStorePath,
				// Rebuilt fields win: this writer rewrites the whole entry on every heartbeat, so a
				// field missing here vanishes from the registry a few seconds after activation.
				origin: identity.origin ?? null,
				// #1083: counted from THIS peer's own state. A missing source is reported as no
				// field at all, so a viewer shows `unknown` instead of a fabricated 0.
				workload: workload?.counts ?? null,
			};
			registry.writeEntryAtomic(live, identity.project);
			lastReportedBusy = busy;
			void updatePingWorkerCard({ workloadCounts: workload?.counts ?? null, tasksSummary: workload?.tasksSummary, busy });
		} catch (err) {
			log.warn("live_registry_write_failed", err instanceof Error ? err.message : String(err));
		}
	}

	function announcePeerLeft(sid: string, fallbackName?: string): boolean {
		if (!knownPeerSessions.has(sid)) return false;
		const name = knownPeerSessions.get(sid) ?? fallbackName ?? sid;
		knownPeerSessions.delete(sid);
		if (!shouldAnnouncePeerLeft(peerCards.values(), name)) return false;
		const content = `📡 Peer left: ${name} [${new Date().toISOString()}]`;
		try { pi.sendMessage({ customType: COMS_PEER_LEFT_CUSTOM_TYPE, content, display: true, details: { peer: name } }, { triggerTurn: false }); } catch {}
		try { pi.events.emit("pidash:coms-peer-event", { customType: COMS_PEER_LEFT_CUSTOM_TYPE, content }); } catch {}
		return true;
	}

	function isPiStreaming(ctx?: ExtensionContext | null): boolean {
		const activeCtx = ctx ?? currentCtx;
		if (!activeCtx || !isLiveExtensionCtx(activeCtx)) return agentRunning;
		if (typeof activeCtx.isIdle === "function") {
			return !activeCtx.isIdle();
		}
		return agentRunning;
	}

	function fulfillBundledInbounds(items: InboundContext[], ident: typeof identity, errorReason = "bundled"): void {
		for (const bi of items) {
			if (bi.fulfilled) continue;
			// Fire-and-forget — don't await, don't block finalization
			if (ident) {
				sendEnvelope(bi.sender_endpoint, {
					type: "response",
					msg_id: bi.msg_id,
					sender_session: ident.coms_session_id,
					sender_endpoint: ident.endpoint,
					hops: 0,
					timestamp: nowIso(),
					response: null,
					error: errorReason,
					queued_msg_ids: [],
				}).catch(() => { /* best-effort */ });
			}
			bi.fulfilled = true;
			inboundQueue.delete(bi.msg_id);
		}
	}

	/**
	 * #1442: Guard every `triggerTurn: true` sendMessage call so empty/whitespace
	 * content can never reach the LLM API (Gemini rejects requests ending on a
	 * `role: "model"` turn when empty custom_message content is omitted).
	 */
	function sendTurnMessage(
		msg: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
		fallback: "(no response)" | "(empty message)",
	): void {
		let content = msg.content;
		if (typeof content !== "string" || content.trim().length === 0) {
			log.warn("empty_turn_message_fallback", { customType: msg.customType, fallback });
			content = fallback;
		}
		pi.sendMessage({ ...msg, content }, { deliverAs: "followUp", triggerTurn: true });
	}

	function injectInbound(
		ib: InboundContext,
		opts: {
			header?: string;
			bundled?: { header: string; content: string; origin?: PromptOrigin; ids: string[]; attempt?: number };
			streaming?: boolean;
			ctx?: ExtensionContext | null;
		} = {},
	): void {
		const origin = opts.bundled ? opts.bundled.origin : ib.origin;
		const selfName = sanitizeComsName(identity?.name ?? "?");
		const sender = sanitizeComsName(ib.sender_name);
		const header = formatComsInboundType(ib.sender_name, selfName, ib.sender_cwd, origin);
		const content = opts.bundled
			? buildInboundContent(opts.bundled.header, opts.bundled.content, null, ib.sender_name, ib.sender_cwd, opts.bundled.origin, ib.sender_session, true)
			: buildInboundContent(opts.header ?? "", ib.prompt, ib.tasks ?? null, ib.sender_name, ib.sender_cwd, ib.origin, ib.sender_session);
		const summaryLine = extractComsInboundSummaryLine({
			prompt: ib.prompt,
			origin,
			bundled: opts.bundled ? { content: opts.bundled.content, ids: opts.bundled.ids, firstOrigin: ib.origin } : undefined,
			fallbackContent: content,
		});
		const attempt = opts.bundled?.attempt ?? (ib.injectAttempt ?? 0);
		const queuedAsFollowUp = opts.streaming === true || (opts.streaming !== false && isPiStreaming(opts.ctx));
		sendTurnMessage(
			{
				customType: COMS_INBOUND_CUSTOM_TYPE,
				content,
				display: true,
				details: {
					msg_id: ib.msg_id,
					header,
					sender,
					target: selfName,
					sender_session: ib.sender_session,
					sender_cwd: ib.sender_cwd,
					...(origin ? { origin } : {}),
					...(opts.bundled && ib.origin ? { summaryOrigin: ib.origin } : {}),
					response_schema: ib.response_schema ?? null,
					summaryLine,
					...(attempt > 0 ? { inject_attempt: attempt } : {}),
					...(opts.bundled ? { bundled_msg_ids: opts.bundled.ids } : {}),
				},
			},
			"(empty message)",
		);
		ib.followUpQueued = queuedAsFollowUp;
	}

	async function drainNextInbound(
		opts: { bundle: boolean; onFail: "reset" | "drop" | "fail_orphans"; streaming?: boolean; ctx?: ExtensionContext | null },
		expectedGen?: number,
	): Promise<void> {
		const isStale = () => shuttingDown || !identity || (expectedGen !== undefined && sessionGeneration !== expectedGen);
		if (isStale()) return;
		const allPending = [...inboundQueue.values()].filter((i) => !i.fulfilled);
		if (allPending.length === 0) {
			if (opts.bundle) bundledInbounds = [];
			currentInbound = null;
			inboundDelivered = false;
			setProcessingInbound(false);
			return;
		}
		const failOrphanPending = async (orphans: InboundContext[]): Promise<boolean> => {
			const ident = identity!;
			for (let idx = 0; idx < orphans.length; idx++) {
				if (isStale()) return false;
				const orphan = orphans[idx];
				orphan.fulfilled = true;
				inboundQueue.delete(orphan.msg_id);
				finalizingMsgIds.add(orphan.msg_id);
				try {
					await sendEnvelope(orphan.sender_endpoint, {
						type: "response", msg_id: orphan.msg_id,
						sender_session: ident.coms_session_id, sender_endpoint: ident.endpoint,
						hops: 0, timestamp: nowIso(),
						response: null, error: "injection_failed",
						queued_msg_ids: orphans.slice(idx + 1).map(r => r.msg_id),
					});
				} catch (e: any) {
					log.error("orphan_cleanup_failed", orphan.msg_id, e?.message);
				} finally {
					finalizingMsgIds.delete(orphan.msg_id);
				}
			}
			return !isStale();
		};
		if (!opts.bundle) {
			const next = allPending[0];
			currentInbound = next;
			inboundDelivered = false;
			setProcessingInbound(true);
			try {
				injectInbound(next, { streaming: opts.streaming, ctx: opts.ctx });
				writeLiveRegistry();
				maybeRefreshWidget();
			} catch (drainErr: any) {
				if (opts.onFail === "fail_orphans") {
					log.error("fifo_drain_failed", next.msg_id, drainErr?.message);
					if (!(await failOrphanPending(allPending))) return;
				}
				currentInbound = null;
				inboundDelivered = false;
				setProcessingInbound(false);
			}
			return;
		}

		const senderPending = selectSenderBundle(allPending);
		if (senderPending.length === 1) {
			const next = senderPending[0];
			currentInbound = next;
			inboundDelivered = false;
			bundledInbounds = [];
			setProcessingInbound(true);
			log.debug("agent_end_fifo_next", next.msg_id, "from", next.sender_name);
			try {
				injectInbound(next, { streaming: opts.streaming, ctx: opts.ctx });
				writeLiveRegistry();
				maybeRefreshWidget();
			} catch (err: any) {
				if (opts.onFail === "fail_orphans") {
					log.error("fifo_drain_failed", next.msg_id, err?.message);
					if (!(await failOrphanPending(allPending))) return;
				} else if (opts.onFail === "drop") {
					log.error("fifo_drain_failed", next.msg_id, err?.message);
					next.fulfilled = true;
					inboundQueue.delete(next.msg_id);
				}
				currentInbound = null;
				inboundDelivered = false;
				bundledInbounds = [];
				setProcessingInbound(false);
			}
			return;
		}

		const primary = senderPending[0];
		currentInbound = primary;
		inboundDelivered = false;
		bundledInbounds = senderPending.slice(1);
		setProcessingInbound(true);
		const bundle = buildBundledContent(primary.sender_name, senderPending);
		const bundleAttempt = Math.max(...senderPending.map((ib) => ib.injectAttempt ?? 0));
		log.debug("fifo_bundle", senderPending.length, "from", primary.sender_name, "origins", senderPending.map((ib) => ib.origin ?? "peer").join(","));
		try {
			injectInbound(primary, { bundled: { ...bundle, ids: senderPending.map(i => i.msg_id), attempt: bundleAttempt }, streaming: opts.streaming, ctx: opts.ctx });
			writeLiveRegistry();
			maybeRefreshWidget();
		} catch (err: any) {
			if (opts.onFail === "fail_orphans") {
				log.error("fifo_bundle_failed", primary.msg_id, err?.message);
				if (!(await failOrphanPending(allPending))) return;
			} else if (opts.onFail === "drop") {
				log.error("fifo_bundle_failed", primary.msg_id, err?.message);
				for (const ib of senderPending) {
					ib.fulfilled = true;
					inboundQueue.delete(ib.msg_id);
				}
			}
			currentInbound = null;
			inboundDelivered = false;
			bundledInbounds = [];
			setProcessingInbound(false);
		}
	}
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
		if (!currentCtx || !isLiveExtensionCtx(currentCtx) || !currentCtx.hasUI) return;
		const pc = getPendingInboundCount();
		// Include busy state and pending-reply progress notes in the refresh key
		// so a progress envelope or busy transition re-renders the pool (#924).
		const busyKey = [...peerCards.entries()].map(([k, v]) => `${k}:${v.staleCount}:${v.busy ? 1 : 0}`).sort().join(",");
		const progressKey = [...pendingReplies.entries()]
			.filter(([, pr]) => pr.progress)
			.map(([id, pr]) => `${id}@${pr.progress!.at}`)
			.sort()
			.join(",");
		const key = `pending=${pc}|busy=${busyKey}|prog=${progressKey}`;
		if (key === lastPoolSnapshot) return;
		lastPoolSnapshot = key;
		emitComsPeers();
		try { installPoolWidget(currentCtx); } catch {}
	}

	function schedulePendingReplyCleanup(msgId: string): void {
		const timer = setTimeout(() => {
			pendingReplyCleanupTimers.delete(timer);
			pendingReplies.delete(msgId);
			maybeRefreshWidget();
		}, PENDING_REPLY_CLEANUP_DELAY_MS);
		timer.unref?.();
		pendingReplyCleanupTimers.add(timer);
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

	/** Return the peer's verified project when it belongs to this session's discovered project peers. */
	function resolveVerifiedPeerProject(sessionId: string | undefined): string | undefined {
		if (!sessionId || !identity) return undefined;
		if (peerCards.has(sessionId)) return identity.project;
		return undefined;
	}

	/** #924 §5: append to the local coms history trail. Fail-soft — delivery
	 *  never waits on history. Every record is stamped with this session's id
	 *  and owner project so project-scoped activity views stay isolated on the shared file;
	 *  `peer_project` is set separately only when the remote peer's project is verified. */
	function appendComsHistory(record: Omit<HistoryRecord, "ts" | "owner"> & { ts?: string }): void {
		appendHistoryRecord(registry.historyPath(), {
			ts: record.ts ?? nowIso(),
			owner: identity?.coms_session_id,
			project: identity?.project,
			...record,
		});
	}

	/** #924 §6: progress signal from the peer processing our prompt. Annotates
	 *  the pending reply — NEVER resolves it — and refreshes the widget. */
	function handleProgress(socket: net.Socket, env: ProgressEnvelope): void {
		ackOk(socket, env.msg_id);
		const pending = pendingReplies.get(env.msg_id);
		if (pending) {
			pending.progress = { note: env.note, at: env.timestamp };
			log.debug("progress_received", env.msg_id, env.note);
			maybeRefreshWidget();
		} else {
			log.debug("progress_orphan", env.msg_id, "from", env.sender_name);
		}
	}

	function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
		// 1. Hop limit check
		if (typeof env.hops !== "number" || env.hops >= maxHops) {
			nack(socket, env.msg_id, "hops exceeded");
			return;
		}

		// 1b. STEER (#924 §1): inject into the receiver's IN-FLIGHT turn — never
		// queued, never fulfilled, FIFO state untouched. The running turn's
		// agent_end response (to the ORIGINAL msg_id) naturally reflects the
		// steer. Capped per turn; over-cap steers fall back to the normal queue
		// path so a buggy sender loop cannot flood one turn's context.
		if (env.steer && processingInbound && currentInbound && !currentInbound.fulfilled && identity) {
			if (shouldAcceptSteer(currentInbound.steerCount ?? 0)) {
				currentInbound.steerCount = (currentInbound.steerCount ?? 0) + 1;
				// Inject FIRST — only report success (ack, history, terminal
				// receipt) after the injection actually landed. A steer that fails
				// to inject must not be recorded as delivered.
				let injected = false;
				try {
					const steerSender = sanitizeComsName(env.sender_name);
					const steerTarget = sanitizeComsName(identity.name);
					const steerOrigin = inboundOrigin(env);
					const steerHeader = `steer from ${steerSender} → ${steerTarget} @ ${sanitizeComsName(env.sender_cwd || "?")}${steerOrigin === "user" ? " (from the USER)" : ""}`;
					sendTurnMessage(
						{
							customType: COMS_INBOUND_CUSTOM_TYPE,
							content: buildInboundContent(
								`[STEER from ${steerSender} — mid-turn course correction. Read this BEFORE continuing your current work; it may change instructions.]`,
								env.prompt,
								null,
								env.sender_name,
								env.sender_cwd,
								steerOrigin,
								env.sender_session,
							),
							display: true,
							details: {
								msg_id: env.msg_id,
								header: steerHeader,
								sender: steerSender,
								target: steerTarget,
								...(steerOrigin ? { origin: steerOrigin } : {}),
								steer: true,
								target_msg_id: currentInbound.msg_id,
								summaryLine: extractComsInboundSummaryLine({
									prompt: env.prompt,
									origin: steerOrigin,
								}),
							},
						},
						"(empty message)",
					);
					injected = true;
				} catch (err) {
					log.warn("steer_inject_failed", env.msg_id, err instanceof Error ? err.message : String(err));
				}
				if (injected) {
					currentInbound.pendingSteers = (currentInbound.pendingSteers ?? 0) + 1;
					ackOk(socket, env.msg_id);
					log.info("steer_injected", env.msg_id, "into", currentInbound.msg_id, "from", env.sender_name, "count", currentInbound.steerCount);
					appendComsHistory({
						direction: "steer",
						msg_id: env.msg_id,
						peer: env.sender_name,
						...(resolveVerifiedPeerProject(env.sender_session) ? { peer_project: resolveVerifiedPeerProject(env.sender_session) } : {}),
						session: env.sender_session,
						preview: truncatePreview(env.prompt),
						status: `injected into ${currentInbound.msg_id}`,
						origin: inboundOrigin(env),
					});
					// Terminal receipt for the sender's pending entry: the steer was
					// delivered mid-turn; no separate response will ever come for it.
					void sendEnvelope(env.sender_endpoint, {
						type: "response", msg_id: env.msg_id,
						sender_session: identity.coms_session_id, sender_endpoint: identity.endpoint,
						hops: 0, timestamp: nowIso(),
						response: null, error: "steered",
					}).catch(() => { /* best-effort receipt */ });
					return;
				}
				// Injection failed — give the cap slot back and fall through to
				// the normal queue path so the correction still arrives (late)
				// and the sender's pending entry resolves via the normal reply.
				currentInbound.steerCount = Math.max(0, (currentInbound.steerCount ?? 1) - 1);
				appendComsHistory({
					direction: "steer",
					msg_id: env.msg_id,
						peer: env.sender_name,
						...(resolveVerifiedPeerProject(env.sender_session) ? { peer_project: resolveVerifiedPeerProject(env.sender_session) } : {}),
						session: env.sender_session,
						preview: truncatePreview(env.prompt),
						status: "steer_failed — queued normally",
						origin: inboundOrigin(env),
					});
				log.warn("steer_failed_queued", env.msg_id, "from", env.sender_name);
			} else {
				log.warn("steer_cap_exceeded", env.msg_id, "from", env.sender_name, "— queuing normally");
			}
			// fall through to the normal queue path
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
			conversation_id: env.conversation_id ?? null,
			response_schema: env.response_schema ?? null,
			queued_at: nowIso(),
			fulfilled: false,
			...(env.priority ? { priority: true } : {}),
			origin: inboundOrigin(env),
		};
		// PRIORITY (#924 §4): priority prompts jump ahead of the first
		// non-priority pending inbound; arrival order is preserved among
			// priorities and everything else. The map is rebuilt because Map
			// insertion order IS the FIFO order the agent_end drain walks.
		if (env.priority && inboundQueue.size > 0) {
			const rebuilt = insertInboundByPriority([...inboundQueue.values()], inbound);
			inboundQueue.clear();
			for (const ib of rebuilt) inboundQueue.set(ib.msg_id, ib);
			log.info("inbound_priority_enqueued", env.msg_id, "from", env.sender_name, "depth", getPendingInboundCount());
		} else {
			inboundQueue.set(env.msg_id, inbound);
		}
		appendComsHistory({
			direction: "in",
			msg_id: env.msg_id,
			peer: env.sender_name,
			...(resolveVerifiedPeerProject(env.sender_session) ? { peer_project: resolveVerifiedPeerProject(env.sender_session) } : {}),
			session: env.sender_session,
			preview: truncatePreview(env.prompt),
			status: env.priority ? "queued (priority)" : "queued",
			origin: inboundOrigin(env),
		});
		log.debug("recovery_inbound_enqueued", { msgId: env.msg_id, sender: env.sender_name, state: "queued" });
		maybeRefreshWidget();

		// 3. If already processing another inbound, just queue — turn_end/agent_end will drain FIFO.
		if (processingInbound) {
			writeLiveRegistry();
			ackOk(socket, env.msg_id);

			log.debug("inbound_queued", env.msg_id, "from", env.sender_name, "depth", getPendingInboundCount());
			return;
		}

		// 4. Not busy — inject immediately.
		// If the agent is already running (user turn), this inbound arrives
		// mid-turn via followUp — mark as mixed turn until message_start delivers it (#731, #1226).
		inboundSetDuringUserTurn = agentRunningUserTurn;
		currentInbound = inbound;
		inboundDelivered = false;
		setProcessingInbound(true);
		try {
			injectInbound(inbound);
		} catch (err) {
			const errIb = inboundQueue.get(env.msg_id);
			if (errIb) errIb.fulfilled = true;
			inboundQueue.delete(env.msg_id);
			maybeRefreshWidget();
			currentInbound = null;
			inboundDelivered = false;
			setProcessingInbound(false);
			nack(socket, env.msg_id, "internal error");
			return;
		}

		// 5. Ack + audit log
		ackOk(socket, env.msg_id);

		log.debug("inbound_prompt", env.msg_id, "from", env.sender_name, "hops", env.hops);
	}

	function handleResponse(socket: net.Socket, env: ResponseEnvelope): void {
		const pending = pendingReplies.get(env.msg_id);
		if (pending?.internal) {
			if (pending.timer) {
				try { clearTimeout(pending.timer); } catch { /* ignore */ }
				pending.timer = null;
			}
			pendingReplies.delete(env.msg_id);
			log.debug("internal_response_received", { msgId: env.msg_id, hasError: Boolean(env.error) });
			ackOk(socket, env.msg_id);
			pending.resolve?.({ response: env.response, error: env.error ?? null });
			return;
		}
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
				pending.resolve?.(pending.result);
			} catch (e: any) {
				log.error("resolve_failed", env.msg_id, e?.message);
			}
			// A resolved entry stops rendering its ⏳ progress note — refresh
			// NOW so the widget drops it the moment the reply lands, instead of
			// waiting for the next registry/fs-watch event.
			maybeRefreshWidget();
			log.debug("handleResponse", env.msg_id, "from", env.sender_session.slice(-8), "error", env.error ?? "none");
			appendComsHistory({
				direction: "response_in",
				msg_id: env.msg_id,
				peer: pending.target_name ?? env.sender_session,
				...(pending.target_project ? { peer_project: pending.target_project } : {}),
				preview: truncatePreview(typeof env.response === "string" ? env.response : JSON.stringify(env.response ?? "")),
				status: env.error ? `error: ${env.error}` : "replied",
				error: env.error ?? null,
			});

			// Skip display for bundled/cleared/steered responses — not user-visible.
			// Ack FIRST: the receiver's sendEnvelope is still waiting on this
			// socket's ack — returning before acking would strand its connection
			// open until its probe timeout.
			if (env.error === "bundled" || env.error === "queue_cleared" || env.error === "steered") {
				ackOk(socket, env.msg_id);
				schedulePendingReplyCleanup(env.msg_id);
				return;
			}

			// Auto-deliver response as followUp so the LLM sees it without polling
			const targetName = pending.target_name ?? "peer";
			const selfName = sanitizeComsName(identity?.name ?? "?");
			const senderName = sanitizeComsName(targetName);
			const responseHeader = formatComsResponseType(targetName, selfName, queuedMsgIds);
			let responseBody = formatComsResponseBody(env.response, env.error ?? null);
			const yourPending = Array.isArray(env.your_pending) ? env.your_pending : [];
			if (yourPending.length > 0) {
				responseBody += `\n\nPeer still has ${yourPending.length} of your messages queued:\n` +
					yourPending.filter((p: any) => p && typeof p === "object").map((p: any, i: number) => `  ${i + 1}. [${p.msg_id ?? "?"}] "${p.preview ?? ""}…"`).join("\n");
			}
			const summaryLine = extractSummaryLine(responseBody);
			try {
				sendTurnMessage(
					{
						customType: COMS_RESPONSE_CUSTOM_TYPE,
						content: responseBody,
						display: true,
						details: {
							msg_id: env.msg_id,
							header: responseHeader,
							sender: senderName,
							target: selfName,
							target_name: targetName,
							error: env.error ?? null,
							queued_msg_ids: queuedMsgIds,
							queuedMsgIds,
							summaryLine,
						},
					},
					"(no response)",
				);
			} catch { /* best-effort */ }

			// Clean up immediately since response was delivered
			schedulePendingReplyCleanup(env.msg_id);
		} else {
			log.warn("orphan_response", env.msg_id);
		}
		ackOk(socket, env.msg_id);
	}

	async function buildAgentCard(snapshot?: { workloadCounts?: PeerWorkloadCounts | null; tasksSummary?: TasksSummary | null; busy?: boolean }): Promise<AgentCard> {
		const ctx = isLiveExtensionCtx(currentCtx) ? currentCtx : null;
		const ident = identity;
		const pct = ctx ? Math.round(ctx.getContextUsage?.()?.percent ?? 0) : 0;
		log.debug("build_agent_card", { hasIdentity: !!ident });
		const workload = snapshot && snapshot.workloadCounts !== undefined ? null : ownWorkload();
		const workloadCounts = snapshot && snapshot.workloadCounts !== undefined ? snapshot.workloadCounts : (workload?.counts ?? null);
		const tasksSummary = snapshot && snapshot.tasksSummary !== undefined
			? snapshot.tasksSummary
			: workload
				? workload.tasksSummary
				: await readTaskSummary(currentCtx?.cwd ?? process.cwd(), currentCtx?.sessionManager?.getSessionId?.());
		return {
			name: ident?.name ?? "unknown",
			purpose: ident?.purpose ?? "",
			model: ctx?.model?.id ?? ident?.model ?? "unknown",
			color: ident?.color ?? "#36F9F6",
			context_used_pct: pct,
			queue_depth: getPendingInboundCount(),
			busy: snapshot?.busy ?? (processingInbound || isAgentBusy(ctx)),
			tasks_summary: tasksSummary,
			workload: workloadCounts,
		};
	}

	/** Push current agent card to ping worker so it can respond independently */
	async function updatePingWorkerCard(snapshot?: { workloadCounts?: PeerWorkloadCounts | null; tasksSummary?: TasksSummary | null; busy?: boolean; card?: AgentCard }): Promise<void> {
		log.debug("update_ping_worker_card", { ready: pingWorkerReady });
		if (!pingWorker || !pingWorkerReady) return;
		try {
			const card = snapshot?.card ?? await buildAgentCard(snapshot);
			const pong: Pong = { type: "pong", msg_id: "", agent_card: card };
			pingWorker.postMessage({ type: "update_card", pong });
		} catch { /* ignore */ }
	}

	function startPingWorker(pingEndpoint: string): void {
		try {
			pingWorker = createPingWorker(pingEndpoint);
			pingWorker.on("message", (msg: any) => {
				if (msg.type === "ready") {
					pingWorkerReady = true;
					void updatePingWorkerCard();
				}
				if (msg.type === "error") log.warn("ping_worker_error", msg.message);
			});
			pingWorker.on("error", () => { pingWorkerReady = false; });
			pingWorker.on("exit", () => { pingWorkerReady = false; pingWorker = null; });
		} catch (err) {
			log.warn("ping_worker_start_failed", err instanceof Error ? err.message : String(err));
		}
	}

	/** #1083: the drilldown answer, built from this peer's own state — never from files. The
	 *  payload is projected (no job output, no worker dirs); a peer whose sources are missing
	 *  answers `detail: null`, which the requester renders as `unknown` — not as `none active`. */
	function handleDescribe(socket: net.Socket, env: DescribeEnvelope): void {
		const workload = ownWorkload();
		const detail = workload ? toDescribeDetail(workload.active) : null;
		log.debug("describe_in", { msgId: env.msg_id, answered: workload !== null, agents: detail?.agents.length, tasks: detail?.tasks.length, crons: detail?.crons.length });
		try {
			socket.write(JSON.stringify({ type: "describe_reply", msg_id: env.msg_id, detail }) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	async function handlePing(socket: net.Socket, env: PingEnvelope): Promise<void> {
		log.debug("handle_ping", { msgId: env.msg_id });
		const card = await buildAgentCard();
		const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
		try {
			socket.write(JSON.stringify(pong) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
		// Also update worker with latest card
		await updatePingWorkerCard({ card });
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
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
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
					void handlePing(socket, parsed as PingEnvelope).catch(() => nack(socket, parsed.msg_id, "internal error"));
				} else if (parsed.type === "describe") {
					handleDescribe(socket, parsed as DescribeEnvelope);
				} else if (parsed.type === "task_update") {
					handleTaskUpdate(socket, parsed as TaskUpdateEnvelope);
				} else if (parsed.type === "queue_manage") {
					handleQueueManage(socket, parsed as QueueManageEnvelope);
				} else if (parsed.type === "task_manage") {
					handleTaskManage(socket, parsed as TaskManageEnvelope);
				} else if (parsed.type === "presence") {
					handlePresence(socket, parsed as PresenceEnvelope);
				} else if (parsed.type === "progress") {
					handleProgress(socket, parsed as ProgressEnvelope);
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
			// Match the session that is actually leaving, not every session sharing that name.
			// On /reload the outgoing session broadcasts this ~200ms AFTER the incoming one has
			// already registered, so matching by name alone evicted the live session: the peer
			// showed as disconnected until something forced it to re-register.
			for (const [sid, card] of peerCards.entries()) {
				const sameSession = shouldEvictOnLeaving(sid, card.name, env.sender_name, env.sender_session);
				if (sameSession) {
					peerCards.delete(sid);
					// Also clean up knownPeerSessions and fire notification
					if (knownPeerSessions.has(sid)) {
						log.info("presence_leaving_received", "from", env.sender_name, "sid", sid);
						announcePeerLeft(sid, card.name);
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
		pruneQueueRecoveryPreviews();
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
			const preview = env.preview_id ? queueRecoveryPreviews.get(env.preview_id) : undefined;
			const ib = inboundQueue.get(env.target_msg_id);
			if (!env.preview_id) { error = "preview_required"; }
			else if (!preview || preview.targetSession !== env.sender_session || !preview.itemIds.includes(env.target_msg_id)) { error = "invalid_preview"; }
			else if (!ib) { error = "not_found"; }
			else if (!isOwned(ib)) { error = "not_owned"; }
			else { dropInbound(ib); queueRecoveryPreviews.delete(env.preview_id); affected++; }
		} else if (action === "edit" && env.target_msg_id && typeof env.new_content === "string") {
			const ib = inboundQueue.get(env.target_msg_id);
			if (!ib) { error = "not_found"; }
			else if (!isOwned(ib)) { error = "not_owned"; }
			else { ib.prompt = env.new_content; affected++; }
		} else if (action === "clear") {
			if (!env.preview_id) {
				error = "preview_required";
			} else {
				const storedPreview = queueRecoveryPreviews.get(env.preview_id);
				if (!storedPreview || storedPreview.targetSession !== env.sender_session) {
					error = "invalid_preview";
					try { socket.write(JSON.stringify({ type: "ack", msg_id: env.msg_id, affected, error }) + "\n"); socket.end(); } catch {}
					log.warn("recovery_clear_denied", { sender: env.sender_name, reason: error });
					return;
				}
				const items = [...inboundQueue.values()].filter(isOwned).map((ib, index): QueueRecoveryItem => ({
					id: ib.msg_id, sender: ib.sender_name, target: identity?.name ?? "local", queuedAt: ib.queued_at,
					position: index + 1, deliveryState: "queued",
				}));
				const outcome = clearLocalQueue(items, storedPreview.itemIds);
				if (outcome.outcome === "partial") {
					error = "preview_stale";
				} else {
					for (const item of outcome.cleared) {
						const inbound = inboundQueue.get(item.id);
						if (inbound && isOwned(inbound)) { dropInbound(inbound); affected++; }
					}
				}
				queueRecoveryPreviews.delete(env.preview_id);
			}
		} else if (action === "inspect") {
			const items = [...inboundQueue.values()].filter(isOwned).map((ib, index): QueueRecoveryItem => ({
				id: ib.msg_id, sender: ib.sender_name, target: identity?.name ?? "local", queuedAt: ib.queued_at,
				position: index + 1, deliveryState: "queued",
			}));
			const preview = buildQueuePreview("local", items, Date.now(), ulid());
			retainQueueRecoveryPreview(preview.previewId, env.sender_session, preview.items.map(item => item.id));
			try { socket.write(JSON.stringify({ type: "ack", msg_id: env.msg_id, affected: 0, error: null, preview }) + "\n"); socket.end(); } catch {}
			log.info("recovery_preview", { provider: "local", sender: env.sender_name, count: preview.items.length });
			return;
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
			socket.end();
		} catch { /* ignore */ }

		maybeRefreshWidget();
		const recoveryLog = error === "preview_required" || error === "invalid_preview" || error === "preview_stale" ? log.warn : error ? log.error : log.info;
		recoveryLog("recovery_local_result", { action, affected, outcome: error ? "failure" : "success", error });
	}

	// ━━ task_manage handler — remote task operations from peers ━━━━━━━━━━━
	async function handleTaskManage(socket: net.Socket, env: TaskManageEnvelope): Promise<void> {
		ackOk(socket, env.msg_id);
		let result: any = null;
		let error: string | null = null;

		try {
			const { createTask, getTask, listTasks, updateTask, deleteTask } = await loadPitasks();
			switch (env.action) {
				case "create":
					if (!env.sender_session) {
						error = "missing sender_session";
					} else if (env.subject) {
						const createdBy = {
							type: "coms" as const,
							origin: env.sender_name || "",
							session: env.sender_session,
							project: "",
						};
						const meta = {
							...(env.metadata && typeof env.metadata === "object" ? env.metadata : {}),
							...(env.sender_endpoint ? { sender_endpoint: env.sender_endpoint } : {}),
						};
						result = createTask(env.subject, env.description ?? "", createdBy, meta);
					} else {
						error = "missing subject";
					}
					break;
				case "get":
					if (env.task_id) result = getTask(env.task_id);
					else error = "missing task_id";
					break;
				case "list":
					result = listTasks();
					break;
				case "update":
					if (env.task_id && env.fields && typeof env.fields === "object" && !Array.isArray(env.fields)) {
						const t = getTask(env.task_id);
						if (!t) {
							error = `Task #${env.task_id} not found`;
						} else if (isPeerTaskCreator(t.createdBy, env.sender_session)) {
							const updateRes = updateTask(env.task_id, env.fields);
							const deletedByUpdate = env.fields.status === "deleted"
								&& Array.isArray(updateRes?.changedFields)
								&& updateRes.changedFields.includes("deleted");
							if (!updateRes?.task && !deletedByUpdate) {
								error = `Task #${env.task_id} not found`;
							} else {
								result = updateRes;
							}
						} else {
							error = "ownership_denied — can only update tasks you created";
						}
					} else error = "missing task_id or fields";
					break;
				case "delete":
					if (env.task_id) {
						const t = getTask(env.task_id);
						if (isPeerTaskCreator(t?.createdBy, env.sender_session)) {
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

	// ━━ #924 §6: progress-signal timer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let progressSignalTimer: NodeJS.Timeout | null = null;
	const PROGRESS_SIGNAL_INTERVAL_MS = 60_000;

	function resolveComsRecoverySessionKey(ctx?: ExtensionContext | null, fallbackSessionId?: string): string {
		const fromCtx = resolveBridgeSessionKey(ctx);
		if (fromCtx !== DEFAULT_BRIDGE_SESSION_KEY) return fromCtx;
		if (typeof fallbackSessionId === "string" && fallbackSessionId.trim()) return fallbackSessionId.trim();
		if (identity?.pi_session_id?.trim()) return identity.pi_session_id.trim();
		return DEFAULT_BRIDGE_SESSION_KEY;
	}

	function subscribeMalformedRecoveryAborted(sessionKey: string): void {
		if (unsubMalformedRecoveryAborted && recoverySessionKey === sessionKey) return;
		unsubMalformedRecoveryAborted?.();
		recoverySessionKey = sessionKey;
		unsubMalformedRecoveryAborted = onMalformedRecoveryAborted(() => {
			if (shuttingDown || !identity || !currentInbound || !inboundDelivered || finalizingInbound) return;
			if (deferredRecoveryInboundId !== currentInbound.msg_id) return;
			const ctx = deferredRecoveryCtx ?? currentCtx;
			deferredRecoveryInboundId = null;
			deferredRecoveryCtx = null;
			if (!ctx) return;
			log.warn("malformed_recovery_aborted_finalize", currentInbound.msg_id);
			void finalizeCurrentInbound(ctx);
		}, recoverySessionKey);
	}

	function getSelf(): ComsPeerSelf | null {
		if (!identity) return null;
		const origin: ComsActivationOrigin =
			identity.origin === "tool" || identity.origin === "cli" ? identity.origin : "slash";
		return {
			sessionId: identity.coms_session_id,
			name: identity.name,
			project: identity.project,
			endpoint: identity.endpoint,
			origin,
			registryFile: identity.registryFile,
		};
	}

	// ━━ Peer startup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	async function restoreReloadQueue(
		reg: ComsRegistry,
		project: string,
		sessionId: string,
		isReload: boolean,
	): Promise<InboundContext[]> {
		let filePath: string;
		try {
			filePath = reg.reloadQueuePath(project, sessionId);
		} catch {
			return [];
		}
		disarmReloadQueueGuard(filePath);
		const payload = claimReloadQueueFile(filePath);
		if (!payload) return [];
		const expired = Date.now() > payload.expires_at_ms;
		const sessionMismatch = payload.session_id !== sessionId;
		const foreignOrphan = !isReload && payload.pid !== process.pid;
		if (expired || sessionMismatch || foreignOrphan) {
			log.warn("reload_queue_discarded_on_start", {
				sessionId,
				project,
				count: payload.items.length,
				expired,
				sessionMismatch,
				foreignOrphan,
			});
			await notifyClosedReloadItems(payload.session_id, payload.endpoint, payload.items);
			return [];
		}
		const restored: InboundContext[] = [];
		for (const saved of payload.items) {
			if (!saved || typeof saved.msg_id !== "string" || typeof saved.sender_endpoint !== "string") continue;
			const nextAttempt = saved.wasInjected ? (saved.injectAttempt ?? 0) + 1 : (saved.injectAttempt ?? 0);
			if (saved.wasInjected && nextAttempt > 0) {
				rememberSupersededAttempt(saved.msg_id, nextAttempt);
			}
			restored.push({
				msg_id: saved.msg_id,
				hops: typeof saved.hops === "number" ? saved.hops : 0,
				sender_endpoint: saved.sender_endpoint,
				sender_session: saved.sender_session,
				sender_name: saved.sender_name,
				sender_cwd: saved.sender_cwd,
				prompt: saved.prompt,
				tasks: Array.isArray(saved.tasks) ? saved.tasks : null,
				conversation_id: saved.conversation_id ?? null,
				response_schema: saved.response_schema ?? null,
				queued_at: saved.queued_at || nowIso(),
				fulfilled: false,
				...(saved.priority ? { priority: true } : {}),
				...(saved.origin ? { origin: saved.origin } : {}),
				...(nextAttempt > 0 ? { injectAttempt: nextAttempt } : {}),
			});
		}
		log.info("reload_queue_restored", { sessionId, project, count: restored.length });
		return restored;
	}

	async function startPeer(ctx: ExtensionContext, startOptions?: ComsPeerStartOptions): Promise<ComsPeerSelf | null> {
		applyExtensionDefaults(import.meta.url, ctx);
		unsubMalformedRecoveryAborted?.();
		unsubMalformedRecoveryAborted = null;
		deferredRecoveryInboundId = null;
		deferredRecoveryCtx = null;
		recoverySessionKey = DEFAULT_BRIDGE_SESSION_KEY;
		if (reloadDrainTimer) { try { clearTimeout(reloadDrainTimer); } catch { /* ignore */ } reloadDrainTimer = null; }
		lastReloadHandoff = null;
		nonReloadStopReason = null;
		pendingSettledAction = null;
		lastTurnStopReason = null;
		currentCtx = ctx;
		sessionGeneration++;
		const startGen = sessionGeneration;
		shuttingDown = false;
		finalizingInbound = false;
		agentRunning = false;
		beforeAgentStartPending = false;
		lastReportedBusy = false;
		peerCards.clear();
		welcomeShown = false;
		knownPeerSessions.clear();

		// 1. Resolve identity from explicit start flags > CLI flags > frontmatter > defaults.
		const flags = readEffectiveCliFlags(startOptions?.flags);
		const fm = readFrontmatterFromArgv(process.argv);
		const project = flags.project || "default";
		const explicit = flags.explicit === true;
		const comsSessionId = (startOptions?.sessionId ?? options.sessionId ?? (globalThis as any).__piConfigSessionId) || ulid();

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
		runtimeCwd = cwd;

		// Resolve coms settings from project settings (scoped to this runtime instance).
		const resolvedComsDir = options.comsDir || resolveComsDir(cwd);
		registry = new ComsRegistry(resolvedComsDir);
		maxHops = getSetting(cwd, "coms_max_hops");
		timeoutMs = getSetting(cwd, "coms_timeout_ms");
		const TASK_HEARTBEAT_MS: number = getSetting(cwd, "coms_task_heartbeat_ms") ?? 300_000;

		const endpoint = registry.makeEndpoint(comsSessionId);
		const model = ctx.model?.id ?? "unknown";

		// 2. Ensure storage dirs exist.
		try {
			registry.ensureProjectDirs(project);
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`, "error");
			return null;
		}

		// 2b. Reject duplicate names — each peer must have a unique name in the project.
		const existingEntries = registry.readEntries(project);
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

					registry.removeEntry(project, existing.coms_session_id);
				} else {
					// No valid endpoint — remove stale entry
					registry.removeEntry(project, existing.coms_session_id);
				}
			}
		}

		// 3. Bind the endpoint.
		try {
			server = await bindEndpoint(endpoint, connHandler, runtimeCwd);
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: bind failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			return null;
		}

		// 3b. Start ping worker on separate socket for liveness checks
		const pingEndpoint = `${endpoint}.ping`;
		startPingWorker(pingEndpoint);

		// 4. Build + write registry entry atomically.
		const piSessionId = resolveOwnPiSessionId(ctx);
		const taskStorePath = resolveOwnTaskStorePath(piSessionId, cwd);
		/** Which entry point activated coms: the `coms_start` tool, `/coms start`, or `pi --coms`. */
		const activationOrigin: ComsActivationOrigin =
			startOptions?.origin === "tool" || startOptions?.origin === "cli" ? startOptions.origin : "slash";
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
			task_store_path: taskStorePath,
			origin: activationOrigin,
		};
		let registryFile: string;
		try {
			registryFile = registry.writeEntryAtomic(entry, project);
		} catch (err) {
			ctx.ui?.notify?.(`📡 coms: registry write failed — ${err instanceof Error ? err.message : String(err)}`, "error");
			try { server?.close(); } catch { /* ignore */ }
			return null;
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
			task_store_path: taskStorePath,
			origin: activationOrigin,
		};
		if (registerSignalHandlers && !signalsBound) {
			process.on("SIGINT", handleSigint);
			process.on("SIGTERM", handleSigterm);
			signalsBound = true;
		}

		// 5. Audit log: boot.
		setLogFilePrefix("coms", identity.name);
		try { pi.events.emit("pidash:coms-identity", { name: identity.name, purpose: identity.purpose || "", project: identity.project || "" }); } catch {}
		log.info("boot", name, project);

		// 6. Surface presence in the UI + install the live pool widget.
		registerPoolVisibilityListeners();
		deferredRecoveryInboundId = null;
		deferredRecoveryCtx = null;
		subscribeMalformedRecoveryAborted(resolveComsRecoverySessionKey(ctx, piSessionId));
		try {
			ctx.ui.setStatus("coms", `📡 ${name}@${project}`);
			installPoolWidget(ctx);
			ctx.ui.notify(
				`📡 coms ready · ${name}@${project} · ${project} pool`,
				"info",
			);
		} catch {
			// hasUI may be false in some contexts — non-fatal.
		}

		// 7. Start timers (skip in one-shot modes).
		if (isLiveExtensionCtx(ctx) && ctx.mode !== "print" && ctx.mode !== "json") {

		// Seed peerCards from existing registry entries
		const existingPeers = registry.readEntries(project);
		for (const entry of existingPeers) {
			if (entry.coms_session_id === identity.coms_session_id) continue;
			if (entry.explicit) continue;
			peerCards.set(entry.coms_session_id, {
				name: entry.name,
				endpoint: entry.endpoint,
				purpose: entry.purpose,
				model: entry.model,
				color: entry.color,
				context_used_pct: entry.context_used_pct ?? 0,
				queue_depth: entry.queue_depth ?? 0,
				busy: entry.busy ?? false,
				tasks_summary: null,
				staleCount: 0,
				workload: entry.workload ?? null,
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
			const headless = isHeadlessOrSupervisedPeer(currentCtx ?? ctx);
			const headlessLine = headless ? `\n- ${HEADLESS_PEER_ASK_USER_GUIDANCE}` : "";
			const welcomeMsg = `📡 Connected to coms · You are "${identity.name}" on project "${identity.project}"

## How to reply
- Your assistant text IS your reply — auto-captured when your turn ends (do not call coms_send to reply).
- When prompted with tasks, check TaskList, work in order with TaskUpdate, and report completion when done.${headlessLine}

## Connected peers
${peerList}
Do not respond to this message.`;

			// Seed knownPeerSessions for every current peer so the retroactive
			// welcome does not also trigger duplicate "peer joined" cards.
			for (const [sid, card] of peerCards) knownPeerSessions.set(sid, card.name);

			log.info("welcome_shown", { peers: peerCards.size, headless });
			try {
				pi.sendMessage({
					customType: "coms-welcome",
					content: welcomeMsg,
					display: true,
				}, { triggerTurn: false });
			} catch {}
		};

		// Show welcome if peers found on boot
		showWelcomeIfNeeded();

		const upsertPeerFromEntry = (entry: RegistryEntry, opts: { refreshOnUpdate: boolean; requireEndpoint: boolean }): void => {
			if (!entry || !entry.coms_session_id) return;
			if (opts.requireEndpoint && !entry.endpoint) return;
			if (peerCards.has(entry.coms_session_id)) {
				const existing = peerCards.get(entry.coms_session_id)!;
				existing.endpoint = entry.endpoint || existing.endpoint;
				existing.context_used_pct = entry.context_used_pct ?? existing.context_used_pct;
				existing.queue_depth = entry.queue_depth ?? existing.queue_depth;
				existing.busy = entry.busy ?? existing.busy;
				existing.model = entry.model ?? existing.model;
				// #1083: `null` is a real answer (sources missing) and must overwrite a
				// previous count — a stale number is worse than `unknown`.
				existing.workload = entry.workload ?? null;
				existing.staleCount = 0;
				log.debug(opts.refreshOnUpdate ? "fs_watch_heartbeat_rename" : "fs_watch_heartbeat", entry.name, "ctx", entry.context_used_pct, "busy", existing.busy);
				if (opts.refreshOnUpdate) maybeRefreshWidget();
				else emitComsPeers();
				return;
			}
			const card: AgentCard & { staleCount: number } = {
				name: entry.name, endpoint: entry.endpoint, purpose: entry.purpose, model: entry.model,
				color: entry.color, context_used_pct: entry.context_used_pct ?? 0,
				queue_depth: entry.queue_depth ?? 0, busy: entry.busy ?? false, tasks_summary: null, staleCount: 0,
				workload: entry.workload ?? null,
			};
			peerCards.set(entry.coms_session_id, card);
			log.info(opts.refreshOnUpdate ? "fs_watch_peer_added" : "fs_watch_peer_added_via_change", entry.name, entry.coms_session_id);
			maybeRefreshWidget();
			if (!welcomeShown) {
				log.debug("welcome_retroactive", entry.name);
				showWelcomeIfNeeded();
			}
			if (welcomeShown && !knownPeerSessions.has(entry.coms_session_id)) {
				knownPeerSessions.set(entry.coms_session_id, entry.name);
				const content = `📡 Peer joined: ${entry.name} (${entry.model})${entry.purpose ? ` — ${entry.purpose}` : ""} [${new Date().toISOString()}]`;
				try {
					pi.sendMessage({
						customType: COMS_PEER_JOINED_CUSTOM_TYPE,
						content,
						display: true,
						details: {
							peer: entry.name,
							model: entry.model,
							...(entry.purpose ? { purpose: entry.purpose } : {}),
						},
					}, { triggerTurn: false });
				} catch {}
				try { pi.events.emit("pidash:coms-peer-event", { customType: COMS_PEER_JOINED_CUSTOM_TYPE, content }); } catch {}
			}
		};

		// Watch registry directory for peer changes (fs.watch)
		const agentsDir = registry.projectAgentsDir(project);
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
							upsertPeerFromEntry(entry, { refreshOnUpdate: true, requireEndpoint: true });
						} catch {}
					} else {
						if (peerCards.has(sessionId)) {
							const card = peerCards.get(sessionId);
							const name = knownPeerSessions.get(sessionId) ?? card?.name ?? sessionId;
							// A peer can reload with a STABLE coms_session_id, so the outgoing session's
							// cleanup unlinks the very file the incoming session just re-created. Deleting on
							// that unlink evicted the live peer and announced a peer-left ~200ms after the
							// join. Re-read the registry and match on the SESSION's own id, never the
							// name: two sessions may legitimately share a name, and a name-only check
							// would let the surviving twin keep a card whose session is genuinely gone.
							const stillRegistered = isSessionStillRegistered(
								registry.readEntries(identity.project),
								sessionId,
							);
							if (stillRegistered) {
								log.info("fs_watch_peer_unlink_ignored", name, sessionId);
								maybeRefreshWidget();
								return;
							}
							peerCards.delete(sessionId);
							log.info("fs_watch_peer_removed", card?.name ?? sessionId);
							maybeRefreshWidget();
							announcePeerLeft(sessionId, name);
						}
					}
				} else if (eventType === "change") {
					try {
						const entry = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RegistryEntry;
						upsertPeerFromEntry(entry, { refreshOnUpdate: false, requireEndpoint: false });
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

		// #924 §6: while processing an inbound, periodically tell the sender
		// we are still working. The signal ANNOTATES their pending reply —
		// it never fulfills it. sendEnvelope only (no ctx access), so no
		// live-ctx guard is required; cleared on shutdown.
		if (progressSignalTimer) { try { clearInterval(progressSignalTimer); } catch { /* ignore */ } }
		progressSignalTimer = setInterval(() => {
			if (!identity || shuttingDown || !processingInbound || !currentInbound || currentInbound.fulfilled) return;
			const nowMs = Date.now();
			if (currentInbound.lastProgressAt && nowMs - currentInbound.lastProgressAt < PROGRESS_SIGNAL_INTERVAL_MS) return;
			currentInbound.lastProgressAt = nowMs;
			const elapsedSec = Math.max(0, Math.round((nowMs - new Date(currentInbound.queued_at).getTime()) / 1000));
			log.debug("progress_signal_sent", currentInbound.msg_id, "to", currentInbound.sender_name, "elapsed", elapsedSec);
			void sendEnvelope(currentInbound.sender_endpoint, {
				type: "progress",
				msg_id: currentInbound.msg_id,
				sender_session: identity.coms_session_id,
				sender_endpoint: identity.endpoint,
				hops: 0,
				timestamp: nowIso(),
				note: `still processing (${elapsedSec}s since queued)`,
				sender_name: identity.name,
			}).catch(() => { /* best-effort */ });
		}, PROGRESS_SIGNAL_INTERVAL_MS);
		try { (progressSignalTimer as any).unref?.(); } catch {}

		// Keepalive — write registry heartbeat + socket self-heal
		keepaliveTimer = setInterval(async () => {
			if (!identity) return;
			if (shuttingDown) return;
			try {
				if (!shuttingDown && process.platform !== "win32" && !fs.existsSync(identity.endpoint)) {
					try {
						log.warn("self_heal_socket_missing", identity.coms_session_id, identity.endpoint);
						if (server) { try { server.close(); } catch {} server = null; }
						server = await bindEndpoint(identity.endpoint, connHandler, runtimeCwd);
						if (pingWorker) {
							const oldWorker = pingWorker;
							oldWorker.removeAllListeners();
							try { oldWorker.postMessage({ type: "shutdown" }); } catch {}
							try { oldWorker.terminate(); } catch {}
							pingWorker = null;
							pingWorkerReady = false;
						}
						const pingEndpoint = `${identity.endpoint}.ping`;
						startPingWorker(pingEndpoint);
					} catch (err) {
						log.error("self_heal_socket_failed", identity.coms_session_id, err instanceof Error ? err.message : String(err));
					}
				}
				if ((agentRunning || beforeAgentStartPending) && currentCtx && isLiveExtensionCtx(currentCtx) && typeof currentCtx.isIdle === "function") {
					try {
						if (currentCtx.isIdle() === true) {
							log.debug("agent_busy_self_healed", { agentRunning, beforeAgentStartPending });
							agentRunning = false;
							beforeAgentStartPending = false;
						}
					} catch {}
				}
				const missingBeforeWrite = !fs.existsSync(identity.registryFile);
				writeLiveRegistry();
				if (missingBeforeWrite) {
					log.warn("self_heal_registry", identity.coms_session_id);
					if (!fs.existsSync(identity.registryFile)) {
						writeLiveRegistry();
					}
				}
			} catch {}
		}, KEEPALIVE_INTERVAL_MS);
		try { (keepaliveTimer as any).unref?.(); } catch {}

		// Stale peer detection — runs every 60s, confirms with socket probe
		const STALE_THRESHOLD_MS = 90_000;
		if (staleCheckTimer) { try { clearInterval(staleCheckTimer); } catch { /* ignore */ } }
		staleCheckTimer = setInterval(async () => {
			if (!identity || shuttingDown) return;
			for (const [sid, card] of peerCards.entries()) {
				if (sid === identity.coms_session_id) continue;
				const regFile = registry.registryFilePath(identity.project, sid);
				try {
					const stat = fs.statSync(regFile);
					const age = Date.now() - stat.mtimeMs;
					if (age > STALE_THRESHOLD_MS) {
						log.debug("stale_check", card.name, "age", Math.round(age / 1000), "s");
						if (card.endpoint) {
							const alive = await probeAlive(card.endpoint);
							if (!alive) {
								log.info("stale_confirmed_dead", card.name, sid);
								peerCards.delete(sid);
								announcePeerLeft(sid, card.name);
								registry.removeEntry(identity.project, sid);
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

		// #1430: restore any inbound messages persisted across a `/reload` boundary for this session.
		const restoredInbounds = await restoreReloadQueue(
			registry,
			project,
			comsSessionId,
			startOptions?.reload === true,
		);
		if (restoredInbounds.length > 0 && !shuttingDown && sessionGeneration === startGen && identity) {
			for (const ib of restoredInbounds) {
				inboundQueue.set(ib.msg_id, ib);
			}
			// Mark busy immediately so newly arriving prompts queue behind restored items
			// until the next-tick drain injects the head of the queue (after session_start
			// finishes enabling coms_* tools and rebuilding extension resources).
			setProcessingInbound(true);
			maybeRefreshWidget();
			const drainCtx = ctx;
			reloadDrainTimer = setTimeout(() => {
				reloadDrainTimer = null;
				if (shuttingDown || !identity || sessionGeneration !== startGen) return;
				void drainNextInbound({ bundle: true, onFail: "fail_orphans", streaming: false, ctx: drainCtx }, startGen);
			}, 0);
			reloadDrainTimer.unref?.();
		}

		return getSelf();
	}

	if (!deferred) {
		pi.on("session_start", async (event: any, ctx) => {
			await startPeer(ctx, event?.reason === "reload" ? { reload: true } : undefined);
		});
	}

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
			/** #1083: own-report of active work; null renders `unknown`, never 0. */
			workload: PeerWorkloadCounts | null;
			queue_depth: number;
			busy: boolean;
			progress?: string;
		}
		const rows: Row[] = [];

		// Latest progress note per target peer from our pending replies (#924 §6).
		// Entries keep living ~60s after their reply (coms_get grace period) —
		// a result already set means the reply landed, so the ⏳ note must not
		// linger for that whole window.
		const progressByPeer = new Map<string, { note: string; at: string }>();
		for (const pr of pendingReplies.values()) {
			if (!pr.progress || !pr.target_name || pr.result) continue;
			const existing = progressByPeer.get(pr.target_name);
			// Compare timestamp-vs-timestamp (Qodo e4a2a85b): the stored value
			// is {note, at}, never the note text.
			if (!existing || pr.progress.at > existing.at) progressByPeer.set(pr.target_name, { note: pr.progress.note, at: pr.progress.at });
		}

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
				workload: card.workload ?? null,
				queue_depth: card.queue_depth ?? 0,
				busy: card.busy ?? false,
				progress: progressByPeer.get(card.name)?.note,
			});
		}

		const widgetCwd = identity?.cwd || currentCtx?.cwd || process.cwd();
		const widgetMode = getWidgetMode("coms", widgetCwd);
		// Advertise only the binding accepted at registration (never an unbound settings edit).
		const shortcutHint = getRegisteredWidgetShortcut("widget_coms_shortcut");
		if (widgetMode === "collapsed") {
			const busyCount = rows.filter((r) => !r.stale && r.busy).length;
			return [
				formatComsCollapsedHeader({
					width: Math.max(0, width),
					identity,
					pendingCount: getPendingInboundCount(),
					shortcutHint,
					peerCount: rows.length,
					busyCount,
					theme,
					colorizeName: hexFg,
				}),
			];
		}

		// Border helpers — sandwich the body with single-line box-drawing rules
		// so the widget reads as its own block above the minimal footer. The
		// top border carries a branded ` coms ` tag so the widget reads as its
		// own block; bottom border stays a plain rule for minimalism.
		const safeWidth = Math.max(0, width);
		const topBorder = formatComsTopBorder({
			width: safeWidth,
			identity,
			pendingCount: getPendingInboundCount(),
			shortcutHint,
			theme,
			colorizeName: hexFg,
		});
		const bottomBorder = safeWidth < 12
			? theme.fg("dim", "━".repeat(safeWidth))
			: theme.fg("dim", "┗" + "━".repeat(safeWidth - 2) + "┛");

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
				const dimRow = `✗ ${sanitizePeerText(r.name, 40).padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${sanitizePeerText(r.purpose, 120)}`;
				out.push(truncateToWidth(" " + theme.fg("dim", dimRow), width));
				continue;
			}

			const swatch = r.pending ? theme.fg("dim", "●") : hexFg(r.color, "●");
			const namePart = theme.fg("accent", sanitizePeerText(r.name, 40).padEnd(12));
			const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
			const barFill = r.pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(r.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
			const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
			const pctPart = " " + theme.fg("accent", pctLabel.padStart(4));
			const sep = theme.fg("dim", "  —  ");
			// #1084: peer text is another process's input — never let it drive the terminal.
			const purposePart = theme.fg("muted", sanitizePeerText(r.purpose, 120));

			// #1083: active work the peer counted itself. The legacy `tasks_summary` part is
			// replaced by this suffix: `✓N` is the same number, active-only, so showing both
			// was one fact twice — and `unknown` must never sit next to a fabricated count.
			const workloadPart = renderWorkloadPart(r.workload, theme);
			const queuePart = renderQueuePart(r.queue_depth, theme);
			const busyPart = r.busy ? " " + theme.fg("warning", "⚙busy") : "";
			const progressPart = r.progress ? " " + theme.fg("dim", `⏳${r.progress}`) : "";
			const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + workloadPart + queuePart + busyPart + progressPart + sep + purposePart;
			out.push(truncateToWidth(line, width));
		}

		out.push(bottomBorder);
		return out;
	}

	let unsubPoolVisibility: Array<() => void> = [];

	function clearPoolVisibilityListeners(): void {
		for (const unsub of unsubPoolVisibility) {
			try { unsub(); } catch { /* ignore */ }
		}
		unsubPoolVisibility = [];
	}

	function registerPoolVisibilityListeners(): void {
		clearPoolVisibilityListeners();
		const refresh = (): void => {
			if (!currentCtx || !isLiveExtensionCtx(currentCtx)) return;
			lastPoolSnapshot = "";
			installPoolWidget(currentCtx);
		};
		try {
			unsubPoolVisibility.push(pi.events.on(TOGGLE_ALL_WIDGETS_EVENT, () => refresh()));
			unsubPoolVisibility.push(pi.events.on(WIDGET_MODE_CHANGED_EVENT, (data: unknown) => {
				const evt = data as Partial<WidgetModeChangedEvent> | undefined;
				if (evt?.widget && evt.widget !== "coms") return;
				refresh();
			}));
		} catch (e: any) {
			log.warn("coms_pool_visibility_subscribe_failed", { error: e?.message });
		}
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!isLiveExtensionCtx(ctx) || !ctx.hasUI) return;
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
	async function resolveTargetWithProject(target: string): Promise<{ entry: RegistryEntry; project: string } | null> {
		// Prefer exact session_id match first (unambiguous).
		if (identity) {
			const localEntries = await registry.pruneDeadEntries(identity.project, runtimeCwd);
			// Try session_id match first (always unambiguous)
			const bySession = localEntries.find((e) => e.coms_session_id === target);
			if (bySession) { log.debug("resolveTarget", target, "→", bySession.name, "by_session"); return { entry: bySession, project: identity.project }; }
			// Name match — warn if ambiguous
			const byName = localEntries.filter((e) => e.name === target);
			if (byName.length === 1) { log.debug("resolveTarget", target, "→", byName[0].name, "by_name"); return { entry: byName[0], project: identity.project }; }
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
				return { entry: byName[0], project: identity.project };
			}
		}
		const otherProjects = identity
			? registry.listProjects().filter((p) => p !== identity!.project)
			: registry.listProjects();
		const cachedEntries: Array<{ project: string; entries: RegistryEntry[] }> = [];
		// Fall back to scanning other projects by session_id.
		for (const proj of otherProjects) {
			const entries = await registry.pruneDeadEntries(proj, runtimeCwd);
			cachedEntries.push({ project: proj, entries });
			const bySession = entries.find((e) => e.coms_session_id === target);
			if (bySession) return { entry: bySession, project: proj };
		}
		// Fall back to name match across those cached project entries.
		for (const { project: proj, entries } of cachedEntries) {
			const byName = entries.find((e) => e.name === target);
			if (byName) return { entry: byName, project: proj };
		}
		log.debug("resolveTarget", target, "→ not_found");
		return null;
	}

	async function resolveTarget(target: string): Promise<RegistryEntry | null> {
		const hit = await resolveTargetWithProject(target);
		return hit?.entry ?? null;
	}

	async function resolveLiveTarget(ref: string): Promise<RegistryEntry> {
		const target = await resolveTarget(ref);
		if (!target) throw new Error(`coms: no live agent matching "${ref}"`);
		return target;
	}

	async function resolveLiveTargetWithProject(ref: string): Promise<{ entry: RegistryEntry; project: string }> {
		const hit = await resolveTargetWithProject(ref);
		if (!hit) throw new Error(`coms: no live agent matching "${ref}"`);
		return hit;
	}

	/** #1080: resolve a peer's TaskStore file path or fail explicitly — never fall back to coms_session_id. */
	function requirePeerTaskStorePath(target: RegistryEntry): string {
		const storePath = resolvePeerTaskStorePath(target);
		if (!storePath) {
			log.error("peer_task_store_unavailable", {
				peer: target.name,
				comsSessionId: target.coms_session_id,
				hasPiSessionId: Boolean(target.pi_session_id),
				advertisedStorePath: target.task_store_path ?? null,
			});
			throw new Error(`peer "${target.name}" has no addressable task store (missing pi_session_id or tasks disabled)`);
		}
		return storePath;
	}

	/** #1080: query a peer's live in-memory TaskStore over its socket via task_manage(list).
	 *  Required when an older peer lacks task_store_path in its registry entry, so reading a
	 *  guessed session file on disk cannot prove the peer's TaskStore reads that file. */
	async function requestPeerTaskListOverSocket(target: RegistryEntry): Promise<any[]> {
		if (!identity) throw new Error("coms not initialised");
		if (!target.endpoint) {
			log.error("peer_task_manage_list_no_endpoint", { peer: target.name, comsSessionId: target.coms_session_id });
			throw new Error(`peer "${target.name}" has no task_store_path and no live endpoint to confirm tasks`);
		}
		const timeoutMs = getSetting(identity.cwd, "coms_probe_timeout_ms");
		const msg_id = ulid();
		let resolveReply!: (value: { response?: any; error?: string | null }) => void;
		const replyPromise = new Promise<{ response?: any; error?: string | null }>((res) => {
			resolveReply = res;
		});
		const timer = setTimeout(() => {
			pendingReplies.delete(msg_id);
			// Resolve, never reject: this timer can fire while sendEnvelope is still in flight,
			// and an unawaited rejection would surface as an unhandled rejection instead of the
			// documented failure.
			resolveReply({ error: `timed out waiting for task_manage list from "${target.name}"` });
		}, timeoutMs);
		try { (timer as any).unref?.(); } catch { /* ignore */ }
		pendingReplies.set(msg_id, {
			internal: true,
			resolve: resolveReply,
			timer,
			target_name: target.name,
			created_at: nowIso(),
		});
		try {
			await sendEnvelope(target.endpoint, {
				type: "task_manage",
				msg_id,
				sender_session: identity.coms_session_id,
				sender_endpoint: identity.endpoint,
				sender_name: identity.name,
				hops: 0,
				timestamp: nowIso(),
				action: "list",
			});
			const reply = await replyPromise;
			if (reply.error) {
				throw new Error(reply.error);
			}
			if (!Array.isArray(reply.response)) {
				throw new Error("invalid task_manage list response");
			}
			log.debug("peer_task_manage_listed", { peer: target.name, count: reply.response.length });
			return reply.response;
		} catch (error) {
			clearTimeout(timer);
			pendingReplies.delete(msg_id);
			const reason = error instanceof Error ? error.message : String(error);
			log.error("peer_task_manage_list_failed", { peer: target.name, error: reason });
			throw new Error(`peer "${target.name}" did not confirm live TaskStore via task_manage: ${reason}`);
		}
	}

	/** #1080: shared peer task read path used by both coms_task_list and coms_tasks_create post-write verification. */
	async function listPeerTasksByTarget(targetOrRef: string | RegistryEntry): Promise<{ target: RegistryEntry; storePath: string; tasks: any[] }> {
		const target = typeof targetOrRef === "string" ? await resolveLiveTarget(targetOrRef) : targetOrRef;
		const storePath = requirePeerTaskStorePath(target);
		if (!target.task_store_path) {
			const tasks = await requestPeerTaskListOverSocket(target);
			log.debug("peer_tasks_listed", { peer: target.name, storePath, source: "task_manage_rpc", count: tasks.length });
			return { target, storePath, tasks };
		}
		const { listTasksAtStorePath } = await loadPitasks();
		const tasks = listTasksAtStorePath(storePath) || [];
		log.debug("peer_tasks_listed", { peer: target.name, storePath, source: "store_path", count: tasks.length });
		return { target, storePath, tasks };
	}

	/** Shared prompt delivery (#924 §2): builds the envelope (with the sender's
	 *  task reminder appended), registers the pending reply, sends, auto-creates
	 *  tasks, and appends to history. Used by coms_send and coms_broadcast. */
	async function deliverPrompt(
		target: RegistryEntry,
		params: {
			prompt: string;
			conversation_id?: string;
			response_schema?: object;
			tasks?: Array<{ subject: string; description: string }>;
			steer?: boolean;
			priority?: boolean;
			/** #1077: set ONLY by the command layer (`/coms tell`, peers overlay). The coms_* tools
			 *  never pass it, so tool input cannot claim human authority. */
			userAuthored?: boolean;
			/** Target peer's project when explicitly known (e.g. cross-project user send). */
			targetProject?: string;
		},
	): Promise<{ msg_id: string; hops: number }> {
		if (!identity) throw new Error("coms not initialised");
		const origin = resolvePromptOrigin(params.userAuthored);
		// A human typing `/coms tell` starts a conversation: it does not inherit the hop depth of the
		// peer message this session happens to be answering, so the cap cannot refuse the user.
		const hops = params.userAuthored === true ? 0 : currentInbound ? currentInbound.hops + 1 : 0;
		if (hops >= maxHops) {
			throw new Error(`coms: hop limit reached (${hops} >= ${maxHops})`);
		}
		const msg_id = ulid();
		// Append sender's active tasks for this peer to the prompt
		let promptText = params.prompt;
		const reminderStorePath = resolvePeerTaskStorePath(target);
		if (reminderStorePath) {
			try {
				const { listTasksAtStorePath } = await loadPitasks();
				const allTasks = listTasksAtStorePath(reminderStorePath) || [];
				const myTasks = allTasks.filter((t: any) =>
					(t.status === "pending" || t.status === "in_progress") &&
					t.createdBy?.session === identity!.coms_session_id
				);
				if (myTasks.length > 0) {
					const taskLines = myTasks.map((t: any) => `#${t.id} [${t.status}] ${t.subject}`).join("\n");
					promptText += `\n\n---\nReminder - Tasks assigned to you by ${identity!.name}:\n${taskLines}`;
					log.debug("outbound_task_reminder_attached", { msg_id, target: target.name, count: myTasks.length });
				}
			} catch (error) {
				log.debug("outbound_task_reminder_skipped", {
					msg_id,
					target: target.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
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
			...(params.steer ? { steer: true } : {}),
			...(params.priority ? { priority: true } : {}),
			origin,
		};

		// Register before sending. A peer may acknowledge and respond before
		// task creation's dynamic import completes.
		let resolveFn!: (v: { response?: any; error?: string | null }) => void;
		let rejectFn!: (e: Error) => void;
		const promise = new Promise<{ response?: any; error?: string | null }>((res, rej) => {
			resolveFn = res;
			rejectFn = rej;
		});
		const verifiedTargetProject = params.targetProject ?? resolveVerifiedPeerProject(target.coms_session_id);
		const entry: PendingReply = {
			resolve: resolveFn,
			reject: rejectFn,
			timer: null,
			promise,
			target_name: target.name,
			target_project: verifiedTargetProject,
			created_at: nowIso(),
		};
		// Steers use the FULL timeout, same as normal sends (Qodo ccd126a8):
		// the receiver decides at arrival time whether to inject or queue, and
		// the sender cannot know which happened. An injected steer resolves in
		// milliseconds via the terminal "steered" receipt; a queued steer
		// (idle peer, cap reached, injection failure) is answered by the real
		// reply, which can legitimately take longer than any short timeout.
		// A short steer-specific timeout would orphan those late replies. The
		// only cost of the full timeout is a lingering entry when the receipt
		// is lost — one small object for at most timeoutMs.
		entry.timer = setTimeout(() => {
			if (entry.result) return;
			entry.result = { error: "timeout" };
			try { entry.resolve?.(entry.result); } catch { /* ignore */ }
			// Clean up timed-out entry from both maps
			const pSet = pendingOutbound.get(target.name);
			if (pSet) { pSet.delete(msg_id); if (pSet.size === 0) pendingOutbound.delete(target.name); }
			schedulePendingReplyCleanup(msg_id);
		}, timeoutMs);
		// Don't keep the event loop alive solely for this timer.
		try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
		pendingReplies.set(msg_id, entry);

		const targetKey = target.name;
		if (!pendingOutbound.has(targetKey)) pendingOutbound.set(targetKey, new Set());
		pendingOutbound.get(targetKey)!.add(msg_id);

		try {
			await sendEnvelope(target.endpoint, env);
		} catch (error) {
			pendingReplies.delete(msg_id);
			pendingOutbound.get(targetKey)?.delete(msg_id);
			if (pendingOutbound.get(targetKey)?.size === 0) pendingOutbound.delete(targetKey);
			if (entry.timer) clearTimeout(entry.timer);
			throw error;
		}
		// A user-authored send is not the agent replying: guarding it would suppress the agent's own
		// reply to the same peer in this turn (the human's message and the answer are different
		// messages). Only tool/auto-capture sends claim "already replied".
		if (params.userAuthored !== true) comsSendCalledThisTurn.add(target.coms_session_id);

		if (params.tasks && params.tasks.length > 0 && target.coms_session_id) {
			const autoStorePath = resolvePeerTaskStorePath(target);
			if (!autoStorePath) {
				log.error("tasks_auto_create_skipped", { msg_id, target: target.name, reason: "peer_task_store_unavailable" });
			} else {
				try {
					const count = await createComsInboundTasks(
						params.tasks,
						{ sender_session: identity.coms_session_id, sender_name: identity.name, sender_endpoint: identity.endpoint },
						target.pi_session_id ?? "",
						target.cwd,
						autoStorePath,
					);
					if (count > 0) log.info("tasks_auto_created", msg_id, "to", target.name, "count", count);
				} catch (error) {
					log.error("tasks_auto_create_failed", { msg_id, target: target.name, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}

		appendComsHistory({
			direction: "out",
			msg_id,
			peer: target.name,
			...(entry.target_project ? { peer_project: entry.target_project } : {}),
			session: target.coms_session_id,
			preview: truncatePreview(promptText),
			status: [params.steer ? "steer" : null, params.priority ? "priority" : null].filter(Boolean).join("+") || "sent",
			origin,
		});
		log.debug("outbound_prompt", msg_id, "to", target.name, "hops", hops);
		return { msg_id, hops };
	}

	/** #1077: the user path refuses ambiguity — a human aiming at one peer must never land on
	 *  another, so unlike the agent tools (which pick the freshest match) this returns a message
	 *  that names the candidates and points at `--project`. */
	async function resolveUserTarget(name: string, project?: string): Promise<{ target?: RegistryEntry; project?: string; error?: string }> {
		if (!identity) return { error: "coms is not active — run /coms start first." };
		if (project) {
			// The value is joined under the coms root by pruneDeadEntries, so it is validated exactly
			// like the spawn path (no separators, no "..", no control chars) BEFORE anything is read.
			const problem = projectProblem(project);
			if (problem) {
				log.warn("user_send_project_refused", { project, reason: problem });
				return { error: `invalid --project: ${problem}` };
			}
		}
		const ident = identity;
		const projects = project ? [project] : [ident.project, ...registry.listProjects().filter((p) => p !== ident.project)];
		const matches: Array<{ project: string; entry: RegistryEntry }> = [];
		for (const proj of projects) {
			let entries: RegistryEntry[] = [];
			try { entries = await registry.pruneDeadEntries(proj, runtimeCwd); } catch (err) {
				// One unreadable project must not abort the scan, and must not vanish either.
				log.warn("user_target_scan_failed", { project: proj, error: err instanceof Error ? err.message : String(err) });
				continue;
			}
			for (const entry of entries) {
				if (entry.coms_session_id === name || entry.name === name) matches.push({ project: proj, entry });
			}
			// A session id is unique by construction: stop before a name scan reaches other projects.
			if (matches.some((m) => m.entry.coms_session_id === name)) break;
		}
		const bySession = matches.filter((m) => m.entry.coms_session_id === name);
		const found = bySession.length > 0 ? bySession : matches;
		const problem = userTargetProblem(found.map((m) => ({ name: m.entry.name, project: m.project })), name, project);
		if (problem) {
			log.warn("user_send_refused", { target: name, matches: found.length, reason: problem });
			return { error: problem };
		}
		return { target: found[0].entry, project: found[0].project };
	}

	/** #1077 command-layer send: `/coms tell` and the peers overlay composer deliver through the
	 *  SAME path as coms_send, but they are the only callers that stamp origin "user" — exposed
	 *  directly on `ComsPeerRuntime` instead of a global side channel. Returns structured result
	 *  and never throws, so a delivery failure reaches the user instead of being dropped. */
	async function sendAsUser(params: ComsUserSendParams): Promise<ComsUserSendResult> {
		if (!identity) {
			return { ok: false, message: "coms is not active — run /coms start first." };
		}
		const resolved = await resolveUserTarget(params.target, params.project);
		if (!resolved.target) {
			// The decision and its one warn live in resolveUserTarget; this is the send path's trail.
			log.debug("user_send_target_missing", { target: params.target, project: params.project ?? null });
			tellLog.debug("tell_target_unresolved", { reason: resolved.error ?? "no match" });
			return { ok: false, message: resolved.error ?? `no live peer "${params.target}"` };
		}
		const target = resolved.target;
		if (params.expectedEndpoint !== undefined && target.endpoint !== params.expectedEndpoint) {
			log.warn("user_send_identity_changed", { target: params.target });
			return { ok: false, message: "peer session changed since selection; select the peer again" };
		}
		const safeTarget = sanitizePeerText(target.name, 40);
		try {
			const { msg_id } = await deliverPrompt(target, {
				prompt: params.prompt,
				userAuthored: true,
				targetProject: resolved.project ?? params.project,
			});
			log.info("user_send", msg_id, "to", target.name, "chars", params.prompt.length);
			tellLog.debug("tell_completion", { count: 1 });
			return { ok: true, message: `sent to ${safeTarget} (${msg_id})` };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			log.error("user_send_failed", target.name, reason);
			return { ok: false, message: `delivery to ${safeTarget} failed: ${reason}` };
		}
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	registerPeerTool({
		name: "coms_list",
		label: "Coms List",
		annotations: READ_ONLY_LOCAL_ANNOTATIONS,
		description:
			"List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
			"Use project=\"*\" to scan all projects. include_explicit=true reveals agents marked --explicit.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name, or \"*\" for all projects. Defaults to caller's project." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
		}),
		async execute(_callId, params) {
			const projectFilter = params.project ?? identity?.project ?? "default";

			// Drop cards whose socket is gone BEFORE listing: a killed peer must not be advertised.
			for (const deadId of deadPeerCardIds(peerCards as Map<string, { endpoint?: string | null }>, (p) => fs.existsSync(p))) {
				const card: any = peerCards.get(deadId);
				peerCards.delete(deadId);
				log.debug("coms_list dropped dead peer", { peer: card?.name ?? deadId, endpoint: card?.endpoint });
			}
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
					busy: card.busy ?? false,
					color: card.color,
				}));

			const lines = agents.length === 0
				? "No peer agents found."
				: agents.map((a) => {
					const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
					const live = a.alive ? "●" : "✗";
					const queueStr = formatQueueStr(a.queue_depth);
					const busyStr = formatBusyStr(a.busy);
					return `${live} ${a.name} (${a.model})${ctxStr}${queueStr}${busyStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
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
				const busy = a.busy ? ` ${theme.fg("warning", "⚙busy")}` : "";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}${busy}`;
			}).join("\n");
			return new Text(header + "\n" + rows, 0, 0);
		},
	});

	registerPeerTool({
		name: "coms_send",
		label: "Coms Send",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			"Send a prompt to a peer; returns msg_id on ack. Reply auto-delivers as a followUp (use coms_get to poll). Throws if unreachable or rejected.\n\n" +
			"- `tasks`: structured items added to the peer's task list.\n" +
			"- `steer=true`: inject into peer's IN-FLIGHT turn for course correction only (acked, never separately answered; cap 5/turn, excess queues). Do not steer idle peers or multi-part briefs.\n" +
			"- `priority=true`: jump peer's queued backlog for urgent messages.\n\n" +
			"⚠️ DO NOT call this to REPLY to a `[from <peer>]` inbound — your final assistant text auto-sends as the reply.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (this project) or session_id (global)." }),
			prompt: Type.String({ description: "Prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema for expected reply." })),
			tasks: Type.Optional(Type.Array(Type.Object({
				subject: Type.String({ description: "Task title" }),
				description: Type.String({ description: "Task details" }),
			}), { description: "Structured tasks to add to peer's list." })),
			steer: Type.Optional(Type.Boolean({ description: "Inject into in-flight turn (course correction only). Default false." })),
			priority: Type.Optional(Type.Boolean({ description: "Jump queued backlog (urgent). Default false." })),
		}),
		// #951: explicit result type so the blocked and delivered details shapes form
		// one union instead of racing TDetails inference.
		async execute(_callId, params): Promise<AgentToolResult<ComsSendDetails>> {
			if (!identity) {
				throw new Error("coms not initialised");
			}
			const { entry: target, project: targetProject } = await resolveLiveTargetWithProject(params.target);
			// Block coms_send to the sender when processing their delivered, non-interrupted inbound — auto-capture handles the reply (#1226)
			if (isAutoCaptureReplyBlocked(target.coms_session_id)) {
				log.info("coms_send_blocked", "to", target.name, "auto-capture will reply");
				return {
					content: [{ type: "text" as const, text: `coms_send blocked: you are responding to ${target.name}'s inbound message. Your assistant text will be auto-captured and sent back. Do NOT use coms_send to reply.` }],
					details: { blocked: true, reason: "processing_inbound", target: target.name },
				};
			}
			// Clear sender's prior pending messages on the receiver before delivering
			if ((params as any).clearPrevious) {
				throw new Error("coms_send clearPrevious is no longer allowed. Inspect with coms_queue_inspect, then explicitly clear with its preview_id.");
			}
			const { msg_id, hops } = await deliverPrompt(target, {
				prompt: params.prompt,
				conversation_id: params.conversation_id,
				response_schema: params.response_schema as object | undefined,
				tasks: params.tasks,
				steer: params.steer === true,
				priority: params.priority === true,
				targetProject,
			});
			const targetKey = target.name;

			// Peer status from peerCards
			const peerCard = peerCards.get(target.coms_session_id);
			const peer_queue_depth = peerCard?.queue_depth ?? 0;
			const peer_status = currentInbound && !currentInbound.fulfilled ? "processing" : "idle";

			// Warn if pending messages exist
			const pendingCount = (pendingOutbound.get(targetKey)?.size ?? 1) - 1; // exclude this one
			const pendingWarn = pendingCount > 0
				? `\n⚠️ You have ${pendingCount} pending message(s) to ${targetKey} that haven't been answered yet. Wait for responses or use coms_queue_inspect + coms_queue_clear to replace them.`
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

	registerPeerTool({
		name: "coms_broadcast",
		label: "Coms Broadcast",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			"Broadcast one prompt to multiple peers at once; returns per-peer msg_id or error (partial failures reported). " +
			"Replies auto-deliver as followUps. Use targets=[\"*\"] for all non-explicit peers in this project.",
		parameters: Type.Object({
			targets: Type.Array(Type.String(), { minItems: 1, description: "Peer names, session_ids, or [\"*\"] for all project peers (excl. explicit)." }),
			prompt: Type.String({ description: "Prompt to send." }),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema for each reply." })),
			tasks: Type.Optional(Type.Array(Type.Object({
				subject: Type.String({ description: "Task title" }),
				description: Type.String({ description: "Task details" }),
			}), { description: "Structured tasks to add to each peer's list." })),
			priority: Type.Optional(Type.Boolean({ description: "Jump each peer's queued backlog. Default false." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms not initialised");
			}
			// Resolve target list. "*" expands to every registry peer in the
			// project — those entries are reused directly (no per-id
			// re-resolve, which would re-probe every socket N times).
			const resolved = new Map<string, { entry: RegistryEntry; project: string }>();
			if (params.targets.includes("*")) {
				const localEntries = await registry.pruneDeadEntries(identity.project, runtimeCwd);
				for (const e of localEntries) {
					if (e.coms_session_id === identity.coms_session_id) continue;
					if (e.explicit) continue;
					resolved.set(e.coms_session_id, { entry: e, project: identity.project });
				}
			}
			// Named targets resolve individually; an unresolvable name is
			// reported as a per-target error (never silently dropped).
			const sendResults: BroadcastTargetResult[] = [];
			for (const t of params.targets) {
				if (t === "*") continue;
				const hit = await resolveTargetWithProject(t);
				if (!hit) {
					log.warn("broadcast_target_unresolved", t);
					sendResults.push({ target: t, status: "error", error: `no live agent matching "${t}"` });
					continue;
				}
				resolved.set(hit.entry.coms_session_id, hit);
			}
			if (resolved.size === 0) {
				const detail = sendResults.map((r) => r.error).join("; ");
				throw new Error(`coms_broadcast: no live agent matching [${params.targets.join(", ")}]${detail ? ` — ${detail}` : ""}`);
			}
			// Same-sender inbound block applies per target: auto-capture replies.
			await Promise.allSettled([...resolved.values()].map(async ({ entry: target, project: targetProject }) => {
				if (isAutoCaptureReplyBlocked(target.coms_session_id)) {
					sendResults.push({ target: target.name, status: "error", error: "blocked: auto-capture will reply to this peer" });
					return;
				}
				try {
					const { msg_id, hops } = await deliverPrompt(target, {
						prompt: params.prompt,
						response_schema: params.response_schema as object | undefined,
						tasks: params.tasks,
						priority: params.priority === true,
						targetProject,
					});
					sendResults.push({ target: target.name, msg_id, hops, status: "sent" });
				} catch (error) {
					sendResults.push({ target: target.name, status: "error", error: error instanceof Error ? error.message : String(error) });
				}
			}));
			const summary = summarizeBroadcast(sendResults);
			log.info("broadcast_sent", "targets", resolved.size, "sent", summary.sent, "failed", summary.failed);
			return {
				content: [{ type: "text" as const, text: summary.text }],
				details: { results: sendResults, sent: summary.sent, failed: summary.failed, targets: [...resolved.keys()] },
			};
		},
		renderCall(args, theme) {
			const tgts = (args as any).targets;
			const list = Array.isArray(tgts) ? tgts.join(",") : String(tgts ?? "?");
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_broadcast")) + theme.fg("dim", ` ${list}`),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!options.expanded || !d) return new Text(theme.fg("accent", `📡 ${d?.sent ?? 0}/${(d?.results ?? []).length} sent`), 0, 0);
			const rows = (d.results as BroadcastTargetResult[]).map((r) =>
				r.status === "sent"
					? `${theme.fg("success", "✓")} ${theme.fg("accent", r.target)} ${theme.fg("dim", r.msg_id ?? "")}`
					: `${theme.fg("error", "✗")} ${theme.fg("accent", r.target)} ${theme.fg("dim", r.error ?? "error")}`,
			).join("\n");
			return new Text(theme.fg("accent", `📡 ${d.sent}/${d.results.length} sent`) + "\n" + rows, 0, 0);
		},
	});

	registerPeerTool({
		name: "coms_history",
		label: "Coms History",
		annotations: READ_ONLY_LOCAL_ANNOTATIONS,
		description:
			"Query local coms message history (prompts, steers, replies, status), newest last. Previews are truncated.",
		parameters: Type.Object({
			peer: Type.Optional(Type.String({ description: "Filter by peer name." })),
			direction: Type.Optional(Type.Union([Type.Literal("out"), Type.Literal("in"), Type.Literal("steer"), Type.Literal("response_out"), Type.Literal("response_in")], { description: "out|in|steer|response_out|response_in (sent|received|mid-turn steer|replies sent|replies received)." })),
			msg_id: Type.Optional(Type.String({ description: "Filter by msg_id." })),
			since: Type.Optional(Type.String({ description: "Inclusive ISO timestamp lower bound." })),
			status: Type.Optional(Type.String({ description: "Case-insensitive substring match on status (e.g. queued, replied, error)." })),
			all_sessions: Type.Optional(Type.Boolean({ description: "Include all sessions on this machine. Default false." })),
			limit: Type.Optional(Type.Number({ description: "Max records (default 50, max 500)." })),
		}),
		async execute(_callId, params) {
			const records = queryHistoryRecords(registry.historyPath(), {
				peer: params.peer,
				direction: params.direction,
				msg_id: params.msg_id,
				since: params.since,
				status: params.status,
				owner: params.all_sessions === true ? undefined : identity?.coms_session_id,
				limit: params.limit,
			});
			const lines = records.map((r) =>
				`${r.ts} [${r.direction}] ${r.peer}${r.origin === "user" ? " (USER)" : ""} — ${r.preview}${r.status ? ` (${r.status})` : ""} [${r.msg_id}]`);
			const text = records.length === 0
				? "No matching coms history records."
				: `${records.length} record(s) (newest last):\n${lines.join("\n")}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { records, count: records.length },
			};
		},
		renderCall(args, theme) {
			const peer = (args as any).peer;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_history")) + theme.fg("dim", peer ? ` ${peer}` : ""),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const d = result.details as any;
			return new Text(theme.fg("accent", `🕘 ${d?.count ?? 0} record(s)`), 0, 0);
		},
	});

	registerPeerTool({
		name: "coms_get",
		label: "Coms Get",
		annotations: READ_ONLY_LOCAL_ANNOTATIONS,
		description:
			"Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
		}),
		async execute(_callId, params): Promise<AgentToolResult<ComsGetDetails>> {
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
			// #924 §6: surface the latest progress signal, if any — it annotates
			// the pending reply and never resolves it.
			const progressText = entry.progress
				? ` — ${entry.progress.note} (at ${entry.progress.at})`
				: "";
			return {
				content: [{ type: "text" as const, text: `coms_get: pending${progressText}` }],
				details: { status: "pending", progress: entry.progress ?? null },
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
	async function sendQueueManage(target: { name: string; endpoint: string }, action: string, targetMsgId?: string, newContent?: string, previewId?: string): Promise<{ affected?: number; error?: string | null; preview?: unknown }> {
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
			preview_id: previewId,
			sender_name: identity.name,
		});
		return { affected: ack?.affected, error: ack?.error, preview: ack?.preview };
	}

	async function runQueueManage(
		ref: string,
		action: QueueManageEnvelope["action"],
		opts: { targetMsgId?: string; newContent?: string; previewId?: string } = {},
	): Promise<{ target: RegistryEntry; affected?: number; preview?: unknown }> {
		const target = await resolveLiveTarget(ref);
		const result = await sendQueueManage(target, action, opts.targetMsgId, opts.newContent, opts.previewId);
		if (result.error) throw new Error(`coms_queue_${action} failed: ${result.error}`);
		return { target, affected: result.affected, preview: result.preview };
	}

	registerPeerTool({
		name: "coms_queue_inspect",
		label: "Coms Queue Inspect",
		annotations: READ_ONLY_LOCAL_ANNOTATIONS,
		description: "Preview your queued inbound messages on a peer before any irreversible recovery. Returns IDs, sender, target, age, FIFO position, and delivery state, never full message bodies. Pass preview_id to coms_queue_clear.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
		}),
		async execute(_callId, params) {
			const { target, preview: rawPreview } = await runQueueManage(params.target, "inspect");
			const preview = rawPreview as QueueRecoveryPreview | undefined;
			if (!preview || preview.outcome !== "supported" || !preview.previewId || !Array.isArray(preview.items)) {
				throw new Error("coms_queue_inspect failed: malformed preview");
			}
			log.info("recovery_inspect_requested", { target: target.name, previewId: preview.previewId, count: preview.items.length });
			const itemLines = preview.items.map(item =>
				`- id: ${item.id} | sender: ${item.sender} | target: ${item.target} | age_ms: ${item.ageMs} | position: ${item.position} | delivery_state: ${item.deliveryState}`,
			);
			return {
				content: [{
					type: "text" as const,
					text: [
						`coms_queue_inspect → ${target.name}`,
						"Review this preview before clearing. No message bodies are shown.",
						`preview_id: ${preview.previewId}`,
						`items: ${preview.items.length}`,
						...itemLines,
					].join("\n"),
				}],
				details: preview,
			};
		},
	});

	registerPeerTool({
		name: "coms_queue_delete",
		label: "Coms Queue Delete",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		description: "Irreversibly delete one of your messages shown by coms_queue_inspect. Only the owner may delete it.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			msg_id: Type.String({ description: "The inspected msg_id to delete from the peer's queue." }),
			preview_id: Type.String({ description: "previewId returned by coms_queue_inspect for this peer." }),
		}),
		async execute(_callId, params) {
			const { target } = await runQueueManage(params.target, "delete", { targetMsgId: params.msg_id, previewId: params.preview_id });
			return { content: [{ type: "text" as const, text: `coms_queue_delete → ${target.name}\nmsg_id: ${params.msg_id}` }], details: undefined };
		},
	});

	registerPeerTool({
		name: "coms_queue_edit",
		label: "Coms Queue Edit",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		description: "Replace the content of your queued message on a peer. Only works on your own pending messages.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			msg_id: Type.String({ description: "The msg_id to edit." }),
			new_content: Type.String({ description: "New prompt content to replace the existing message." }),
		}),
		async execute(_callId, params) {
			const { target } = await runQueueManage(params.target, "edit", { targetMsgId: params.msg_id, newContent: params.new_content });
			return { content: [{ type: "text" as const, text: `coms_queue_edit → ${target.name}\nmsg_id: ${params.msg_id}` }], details: undefined };
		},
	});

	registerPeerTool({
		name: "coms_queue_clear",
		label: "Coms Queue Clear",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		description: "Irreversibly clear only the messages shown by a preceding coms_queue_inspect preview. Ownership is enforced by the peer; untouched messages retain FIFO order.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			preview_id: Type.String({ description: "previewId returned by coms_queue_inspect for this peer." }),
		}),
		async execute(_callId, params) {
			const { target, affected } = await runQueueManage(params.target, "clear", { previewId: params.preview_id });
			log.info("recovery_clear_requested", { target: target.name, affected: affected ?? 0 });
			return { content: [{ type: "text" as const, text: `coms_queue_clear → ${target.name}\ncleared: ${affected ?? 0}` }], details: { affected: affected ?? 0, preview_id: params.preview_id } };
		},
	});

	registerPeerTool({
		name: "coms_queue_prioritize",
		label: "Coms Queue Prioritize",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description: "Move your message to the front of a peer's queue. Only works on your own pending messages.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			msg_id: Type.String({ description: "The msg_id to prioritize." }),
		}),
		async execute(_callId, params) {
			const { target } = await runQueueManage(params.target, "prioritize", { targetMsgId: params.msg_id });
			return { content: [{ type: "text" as const, text: `coms_queue_prioritize → ${target.name}\nmsg_id: ${params.msg_id}` }], details: undefined };
		},
	});

	interface LocalQueueItem {
		id: string;
		msg_id: string;
		sender_name: string;
		prompt: string;
		status: "processing" | "pending";
		receivedAt: number;
	}

	function listLocalInboundQueue(): LocalQueueItem[] {
		const items: LocalQueueItem[] = [];
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
	}

	async function killLocalInboundQueueItem(
		msgId: string,
	): Promise<{ killed: true; msg_id: string; sender_name: string } | { killed: false }> {
		const ib =
			inboundQueue.get(msgId)
			?? (currentInbound?.msg_id === msgId ? currentInbound : undefined)
			?? bundledInbounds.find((b) => b.msg_id === msgId);
		if (!ib || ib.fulfilled) return { killed: false };
		const wasActive = currentInbound?.msg_id === msgId;
		const gen = sessionGeneration;
		ib.fulfilled = true;
		inboundQueue.delete(msgId);
		rememberClosedId(closedInboundMsgIds, msgId);
		let bundledToCancel: InboundContext[] = [];
		if (wasActive) {
			if ((ib.pendingSteers ?? 0) > 0) {
				rememberClosedId(closedSteerTargetIds, ib.msg_id);
			}
			currentInbound = null;
			inboundDelivered = false;
			bundledToCancel = bundledInbounds;
			bundledInbounds = [];
			pendingDrainAfterKill = true;
		} else {
			bundledInbounds = bundledInbounds.filter((b) => b.msg_id !== msgId);
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
			if (bundledToCancel.length > 0 && sessionGeneration === gen) {
				for (const b of bundledToCancel) rememberClosedId(closedInboundMsgIds, b.msg_id);
				fulfillBundledInbounds(bundledToCancel, identity, "killed_by_user");
			}
		}
		log.info("queue_kill", msgId, "sender", ib.sender_name, "wasActive", wasActive);
		// If killed between turns (agent idle), drain next queued inbound immediately;
		// if killed mid-turn, defer draining until agent_end so we never inject into the running turn.
		if (wasActive && !agentRunning && pendingDrainAfterKill && sessionGeneration === gen && !shuttingDown && identity) {
			pendingDrainAfterKill = false;
			await drainNextInbound({ bundle: true, onFail: "drop", ctx: currentCtx }, gen);
		}
		return { killed: true, msg_id: ib.msg_id, sender_name: ib.sender_name };
	}

	registerPeerTool({
		name: "coms_local_queue",
		label: "Coms Local Queue",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		description:
			"Inspect or kill messages in THIS session's own inbound coms queue (equivalent to /coms → q). Use action='list' to view processing and pending inbound messages, or action='kill' with msg_id to cancel one and notify the sender.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("kill")], {
				description: "'list' to view this session's inbound coms queue; 'kill' to cancel a queued message by msg_id.",
			}),
			msg_id: Type.Optional(Type.String({ description: "Inbound msg_id to cancel (required when action='kill')." })),
		}),
		async execute(_callId, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			if (params.action === "list") {
				const items = listLocalInboundQueue();
				log.debug("coms_local_queue_list", { count: items.length });
				if (items.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No queued inbound coms messages." }],
						details: { action: "list", items: [] },
					};
				}
				const lines = items.map((item) => {
					const compact = item.prompt.replace(/\s+/g, " ").trim();
					const preview = compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
					return `- ${item.msg_id} | ${item.status} | from: ${item.sender_name} | ${preview}`;
				});
				return {
					content: [{ type: "text" as const, text: `Local inbound coms queue (${items.length}):\n${lines.join("\n")}` }],
					details: { action: "list", items },
				};
			}
			if (params.action === "kill") {
				const msgId = (params.msg_id ?? "").trim();
				if (!msgId) {
					return {
						content: [{ type: "text" as const, text: "Error: 'msg_id' is required when action is 'kill'." }],
						details: { action: "kill", killed: false },
					};
				}
				const res = await killLocalInboundQueueItem(msgId);
				if (!res.killed) {
					return {
						content: [{ type: "text" as const, text: `No queued inbound message found with msg_id "${msgId}".` }],
						details: { action: "kill", killed: false, msg_id: msgId },
					};
				}
				return {
					content: [{ type: "text" as const, text: `Killed inbound message ${res.msg_id} (from ${res.sender_name}).` }],
					details: { action: "kill", ...res },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Unknown action "${String(params.action)}". Use "list" or "kill".` }],
				details: { ok: false },
			};
		},
	});

	async function loadMutablePeerTask(
		storePath: string,
		targetName: string,
		taskId: string,
		action: "delete" | "update",
	): Promise<{ task: any } | { blocked: AgentToolResult<ComsTaskDeleteDetails> }> {
		const { getTaskAtStorePath } = await loadPitasks();
		const task = getTaskAtStorePath(storePath, taskId);
		if (!task) {
			throw new Error(action === "update" ? `Task #${taskId} not found on ${targetName}` : `Task #${taskId} not found`);
		}
		if (!isPeerTaskCreator(task.createdBy, identity?.coms_session_id)) {
			throw new Error(`Ownership denied — can only ${action} tasks you created`);
		}
		if (task.status === "in_progress") {
			return {
				blocked: {
					content: [{ type: "text" as const, text: `Cannot ${action} task #${taskId} — task is in_progress. Wait for the peer to finish.` }],
					details: { blocked: true, reason: "in_progress" },
				},
			};
		}
		return { task };
	}

	registerPeerTool({
		name: "coms_tasks_create",
		label: "Coms Tasks Create",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description: "Create multiple tasks on a peer's task list. Automatically adds a 'Report completion to sender' task blocked by all created tasks, and sends a message to the peer to start working.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			tasks: Type.Array(Type.Object({
				subject: Type.String({ description: "Brief task title" }),
				description: Type.String({ description: "Detailed task description" }),
			}), { description: "Tasks to create on the peer" }),
		}),
		async execute(_callId, params) {
			log.debug("coms_tasks_create_start", { target: params.target, count: params.tasks?.length ?? 0 });
			if (!identity) throw new Error("coms not initialised");
			if (!params.tasks || params.tasks.length === 0) throw new Error("coms_tasks_create requires at least one task");
			const target = await resolveLiveTarget(params.target);

			const createdBy = {
				type: "coms" as const,
				origin: identity.name,
				session: identity.coms_session_id,
				project: process.cwd(),
			};
			const meta: Record<string, any> = {};
			if (identity.endpoint) meta.sender_endpoint = identity.endpoint;

			try {
				const storePath = requirePeerTaskStorePath(target);
				const storeExistedBeforeWrite = fs.existsSync(storePath);
				const { createTasksAtStorePath, deleteTaskAtStorePath, getTaskAtStorePath, listTasksAtStorePath, updateTaskAtStorePath } = await loadPitasks();

				// Check if "Report completion to sender" already exists from this sender before mutating
				const existingTasks = listTasksAtStorePath(storePath) || [];
				const existingReport = existingTasks.find((t: any) =>
					t.createdBy?.session === identity!.coms_session_id &&
					t.subject === "Report completion to sender" &&
					t.status !== "completed" && t.status !== "deleted"
				);

				let created: any[] = [];
				let createdIds: string[] = [];
				let createdReportTaskId = "";
				let updatedReportTask: { id: string; addedBlockerIds: string[] } | null = null;

				const rollbackCreatedTasks = (reason: unknown): void => {
					if (createdIds.length === 0 && !createdReportTaskId && !updatedReportTask) return;
					try {
						for (const id of createdIds) {
							deleteTaskAtStorePath(storePath, id);
						}
						if (createdReportTaskId) {
							deleteTaskAtStorePath(storePath, createdReportTaskId);
						}
						if (updatedReportTask && updatedReportTask.addedBlockerIds.length > 0) {
							// The deletes above already stripped our IDs from every blockedBy list under the
							// store lock, so an unconditional array rewrite would only clobber blockers another
							// writer added meanwhile. Rewrite (bounded compare-and-set) only if one of our IDs
							// came back, and always recompute against the freshly read array.
							const rollbackReportId = updatedReportTask.id;
							const ourBlockerIds = new Set<string>(updatedReportTask.addedBlockerIds);
							for (let attempt = 1; attempt <= 3; attempt++) {
								const currentReport = getTaskAtStorePath(storePath, rollbackReportId);
								if (!currentReport) break;
								const snapshot: string[] = Array.isArray(currentReport.blockedBy) ? currentReport.blockedBy : [];
								if (!snapshot.some((id) => ourBlockerIds.has(id))) break;
								updateTaskAtStorePath(storePath, rollbackReportId, { blockedBy: snapshot.filter((id) => !ourBlockerIds.has(id)) });
								const confirmedReport = getTaskAtStorePath(storePath, rollbackReportId);
								const remaining: string[] = Array.isArray(confirmedReport?.blockedBy) ? confirmedReport.blockedBy : [];
								if (!remaining.some((id) => ourBlockerIds.has(id))) break;
								if (attempt === 3) log.warn("peer_report_rollback_unconfirmed", { taskId: rollbackReportId });
								else log.warn("peer_report_rollback_retry", { attempt });
							}
						}
						if (!storeExistedBeforeWrite) {
							const remaining = listTasksAtStorePath(storePath) || [];
							if (remaining.length === 0) {
								try { fs.unlinkSync(storePath); } catch { /* ignore */ }
							}
						}
						log.warn("coms_tasks_create_rolled_back", {
							target: target.name,
							storePath,
							rolledBackIds: createdIds,
							createdReportTaskId: createdReportTaskId || null,
							restoredReportTaskId: updatedReportTask?.id ?? null,
							reason: reason instanceof Error ? reason.message : String(reason),
						});
					} catch (rollbackErr: any) {
						log.error("coms_tasks_create_rollback_failed", {
							target: target.name,
							storePath,
							error: rollbackErr?.message ?? String(rollbackErr),
						});
					}
				};

				try {
					// Create all tasks in one batch
					const taskDefs = params.tasks.map(t => ({
						subject: t.subject,
						description: t.description,
						createdBy,
						metadata: { ...meta },
					}));
					created = createTasksAtStorePath(storePath, taskDefs);
					createdIds = created.map((t: any) => String(t.id));

					let reportTaskId = "";
					if (existingReport) {
						const priorBlockedBy = Array.isArray(existingReport.blockedBy) ? [...existingReport.blockedBy] : [];
						const newBlockedBy = [...new Set([...priorBlockedBy, ...createdIds])];
						updateTaskAtStorePath(storePath, existingReport.id, { blockedBy: newBlockedBy });
						reportTaskId = String(existingReport.id);
						updatedReportTask = { id: reportTaskId, addedBlockerIds: createdIds.filter((id) => !priorBlockedBy.includes(id)) };
					} else {
						const [reportTask] = createTasksAtStorePath(storePath, [{
							subject: "Report completion to sender",
							description: `When all tasks are done, use coms_send to report back to ${identity!.name}.`,
							createdBy,
							blockedBy: createdIds,
							metadata: { ...meta },
						}]);
						reportTaskId = String(reportTask?.id ?? "");
						createdReportTaskId = reportTaskId;
					}

					// #1080: verify created tasks are persisted and visible through the exact read path
					// coms_task_list uses before reporting success — never claim a silent false success.
					if (!fs.existsSync(storePath)) {
						throw new Error(`task store file was not persisted at ${storePath}`);
					}
					const verified = await listPeerTasksByTarget(params.target);
					if (verified.storePath !== storePath) {
						throw new Error(`write store (${storePath}) disagreed with read store (${verified.storePath})`);
					}
					const expectedTasks = new Map<string, string>(
						created.map((t: any) => [String(t.id), String(t.subject)]),
					);
					if (reportTaskId) {
						expectedTasks.set(reportTaskId, "Report completion to sender");
					}
					const visibleById = new Map(verified.tasks.map((t: any) => [String(t?.id), t]));
					const missingIds = [...expectedTasks.entries()]
						.filter(([id, subject]) => {
							const found = visibleById.get(id);
							return !found
								|| found.subject !== subject
								|| found.createdBy?.session !== identity!.coms_session_id;
						})
						.map(([id]) => id);
					if (created.length !== params.tasks.length || missingIds.length > 0) {
						throw new Error(`task write verification failed — missing task ID(s) on readback: ${missingIds.join(", ") || "count_mismatch"}`);
					}
				} catch (writeOrVerifyErr) {
					rollbackCreatedTasks(writeOrVerifyErr);
					throw writeOrVerifyErr;
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
					log.warn("coms_tasks_create_auto_prompt_failed", { target: target.name, error: e?.message ?? String(e) });
				}

				const lines = created.map((t: any) => `#${t.id}: ${t.subject}`);
				return {
					content: [{ type: "text" as const, text: `Created ${created.length} tasks on ${target.name}:\n${lines.join("\n")}` }],
					details: { target: target.name, count: created.length, taskIds: createdIds, storePath },
				};
			} catch (e: any) {
				log.error("coms_tasks_create_failed", { target: target.name, error: e?.message ?? String(e) });
				throw new Error(`Failed to create tasks on ${target.name}: ${e?.message}`);
			}
		},
	});

	registerPeerTool({
		name: "coms_task_delete",
		label: "Coms Task Delete",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		description: "Delete a task from a peer's task list. Only works on tasks you created (createdBy match).",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			task_id: Type.String({ description: "Task ID to delete." }),
		}),
		async execute(_callId, params): Promise<AgentToolResult<ComsTaskDeleteDetails>> {
			log.debug("coms_task_delete_start", { target: params.target, taskId: params.task_id });
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveLiveTarget(params.target);

			try {
				const storePath = requirePeerTaskStorePath(target);
				const loaded = await loadMutablePeerTask(storePath, target.name, params.task_id, "delete");
				if ("blocked" in loaded) return loaded.blocked;
				const { deleteTaskAtStorePath } = await loadPitasks();
				const deleted = deleteTaskAtStorePath(storePath, params.task_id);
				if (!deleted) throw new Error(`Task #${params.task_id} could not be deleted`);
				log.info("coms_task_delete", params.task_id, "on", target.name);
			} catch (e: any) {
				log.error("coms_task_delete_failed", { target: target.name, taskId: params.task_id, error: e?.message ?? String(e) });
				throw new Error(`Failed to delete task on ${target.name}: ${e?.message}`);
			}

			return {
				content: [{ type: "text" as const, text: `Task #${params.task_id} deleted from ${target.name}` }],
				details: { target: target.name, task_id: params.task_id },
			};
		},
	});

	registerPeerTool({
		name: "coms_task_list",
		label: "Coms Task List",
		annotations: READ_ONLY_LOCAL_ANNOTATIONS,
		description: "List tasks on a peer's task list without sending a message.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
		}),
		async execute(_callId, params) {
			log.debug("coms_task_list_start", { target: params.target });
			if (!identity) throw new Error("coms not initialised");
			const resolvedTarget = await resolveLiveTarget(params.target);

			try {
				const { target, storePath, tasks } = await listPeerTasksByTarget(resolvedTarget);
				log.debug("coms_task_list", target.name, "tasks", tasks.length);

				if (tasks.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No tasks found" }],
						details: { target: target.name, count: 0, taskIds: [] as string[], storePath },
					};
				}

				const taskById = new Map<string, any>(tasks.map((t: any) => [String(t.id), t]));
				const getTask = (id: string) => taskById.get(id);
				const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
				const sorted = [...tasks].sort((a: any, b: any) => {
					const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
					if (so !== 0) return so;
					return Number(a.id) - Number(b.id);
				});
				const lines = sorted.map((t: any) => {
					let line = `#${t.id} [${t.status}] ${t.subject}`;
					if (t.owner) line += ` (${t.owner})`;
					if (t.blockedBy?.length > 0) {
						const blockers = openTaskBlockers(t, getTask);
						if (blockers.length > 0) line += ` [blocked by ${blockers.map((id: string) => "#" + id).join(", ")}]`;
					}
					return line;
				});
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { target: target.name, count: sorted.length, taskIds: sorted.map((t: any) => String(t.id)), storePath },
				};
			} catch (e: any) {
				log.error("coms_task_list_failed", { target: resolvedTarget.name, error: e?.message ?? String(e) });
				throw new Error(`Failed to list tasks on ${resolvedTarget.name}: ${e?.message}`);
			}
		},
	});

	registerPeerTool({
		name: "coms_task_get",
		label: "Coms Task Get",
		annotations: READ_ONLY_LOCAL_ANNOTATIONS,
		description: "Get a specific task from a peer's task list without sending a message.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name or session_id." }),
			task_id: Type.String({ description: "Task ID to retrieve." }),
		}),
		async execute(_callId, params) {
			log.debug("coms_task_get_start", { target: params.target, taskId: params.task_id });
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveLiveTarget(params.target);

			try {
				const storePath = requirePeerTaskStorePath(target);
				const { getTaskAtStorePath, listTasksAtStorePath } = await loadPitasks();
				const task = getTaskAtStorePath(storePath, params.task_id);
				if (!task) throw new Error(`Task #${params.task_id} not found on ${target.name}`);

				log.debug("coms_task_get", target.name, "task", params.task_id);

				// Match local TaskGet format
				const desc = task.description || "(no description)";
				const lines: string[] = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`];
				if (task.owner) lines.push(`Owner: ${task.owner}`);
				lines.push(`Description: ${desc}`);
				if (task.blockedBy?.length > 0) {
					const allTasks = listTasksAtStorePath(storePath) || [];
					const taskById = new Map<string, any>(allTasks.map((t: any) => [String(t.id), t]));
					const blockers = openTaskBlockers(task, (id) => taskById.get(id));
					if (blockers.length > 0) lines.push(`Blocked by: ${blockers.map((id: string) => "#" + id).join(", ")}`);
				}
				if (task.blocks?.length > 0) lines.push(`Blocks: ${task.blocks.map((id: string) => "#" + id).join(", ")}`);

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: undefined,
				};
			} catch (e: any) {
				log.error("coms_task_get_failed", { target: target.name, taskId: params.task_id, error: e?.message ?? String(e) });
				throw new Error(`Failed to get task from ${target.name}: ${e?.message}`);
			}
		},
	});

	registerPeerTool({
		name: "coms_task_update",
		label: "Coms Task Update",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
			log.debug("coms_task_update_start", { target: params.target, taskId: params.task_id });
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveLiveTarget(params.target);

			try {
				const storePath = requirePeerTaskStorePath(target);
				const loaded = await loadMutablePeerTask(storePath, target.name, params.task_id, "update");
				if ("blocked" in loaded) return loaded.blocked;
				const { updateTaskAtStorePath } = await loadPitasks();

				const { target: _t, task_id: _tid, ...fields } = params;
				const result = updateTaskAtStorePath(storePath, params.task_id, fields);
				const deletedByUpdate = fields.status === "deleted"
					&& Array.isArray(result?.changedFields)
					&& result.changedFields.includes("deleted");
				if (!result?.task && !deletedByUpdate) {
					throw new Error(`Task #${params.task_id} not found on ${target.name}`);
				}
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
				log.error("coms_task_update_failed", { target: target.name, taskId: params.task_id, error: e?.message ?? String(e) });
				throw new Error(`Failed to update task on ${target.name}: ${e?.message}`);
			}
		},
	});

	// Refresh currentCtx on before_agent_start so describe/workload lookups stay aligned
	// with orchestrator and pitasks re-keying on watched-session switches (#1337).
	// On a watched-session switch, defer writeLiveRegistry() to agent_start so orchestrator and
	// pitasks finish republishing their bridges before the registry snapshot and pi_session_id
	// update; on same-session turns, publish busy immediately (#1466).
	pi.on("before_agent_start" as any, (event: any, ctx?: ExtensionContext) => {
		const sessionChanged = Boolean(ctx && identity && resolveOwnPiSessionId(ctx) !== identity.pi_session_id);
		if (ctx) currentCtx = ctx;
		beforeAgentStartPending = true;
		syncBusyState(ctx, { syncRegistry: !sessionChanged, reason: "before_agent_start" });
		const activeCtx = ctx ?? currentCtx;
		if (!identity || !isHeadlessOrSupervisedPeer(activeCtx)) return;
		const liveActiveCtx = isLiveExtensionCtx(activeCtx) ? activeCtx : null;
		const opts = event?.systemPromptOptions;
		const sections = opts?.sections;
		if (opts?.forceSystemPrompt === undefined && sections && typeof sections === "object") {
			sections.coms_headless_peer = HEADLESS_PEER_ASK_USER_GUIDANCE;
			log.debug("headless_peer_guidance_injected", {
				target: "section",
				mode: liveActiveCtx?.mode ?? null,
				hasUI: liveActiveCtx?.hasUI ?? null,
				supervised: process.env.PI_COMS_SUPERVISED_PEER === "1",
			});
			return;
		}
		if (typeof event?.systemPrompt === "string") {
			log.debug("headless_peer_guidance_injected", {
				target: "systemPrompt",
				mode: liveActiveCtx?.mode ?? null,
				hasUI: liveActiveCtx?.hasUI ?? null,
				supervised: process.env.PI_COMS_SUPERVISED_PEER === "1",
			});
			return { systemPrompt: `${event.systemPrompt}\n\n${HEADLESS_PEER_ASK_USER_GUIDANCE}` };
		}
	});

	// ━━ Track agent running state for mixed-turn detection (#731) ━━━━━━━━━
	// Only mark as "user turn" if NO coms inbound is active (processingInbound false).
	// When processingInbound is true, the agent is running a coms followUp — not a user turn.
	pi.on("agent_start" as any, (_event: any, ctx?: ExtensionContext) => {
		const sessionChanged = Boolean(ctx && identity && resolveOwnPiSessionId(ctx) !== identity.pi_session_id);
		if (ctx) currentCtx = ctx;
		agentRunning = true;
		beforeAgentStartPending = false;
		agentRunningUserTurn = !processingInbound;
		lastTurnStopReason = null;
		comsSendCalledThisTurn.clear();
		userMessageDuringInbound = false;
		syncBusyState(ctx, { force: sessionChanged, reason: "agent_start" });
		log.debug("agent_start", "userTurn", agentRunningUserTurn, "processingInbound", processingInbound, "currentInbound", currentInbound?.msg_id ?? "null");
	});

	// ━━ message_start: track inbound delivery boundary & detect user interrupts (#741, #1226) ━━
	// When Pi actually pulls currentInbound into context (role "custom" with matching msg_id),
	// flip inboundDelivered = true and reset per-inbound turn flags. Only flag a user message
	// as interrupting the inbound once that inbound has actually been delivered.
	pi.on("message_start" as any, (event: any) => {
		const msg = event?.message;
		if (isClosedComsMessage(msg)) {
			log.info("closed_inbound_suppressed", msg?.details?.msg_id ?? msg?.details?.target_msg_id ?? "unknown");
			return;
		}
		if (isSupersededComsMessage(msg)) {
			log.info("superseded_inbound_suppressed", msg?.details?.msg_id ?? "unknown", "attempt", msg?.details?.inject_attempt ?? 0);
			return;
		}
		if (shuttingDown || !identity) return;
		if (currentInbound && msg?.role === "custom" && msg?.details?.msg_id === currentInbound.msg_id) {
			inboundDelivered = true;
			currentInbound.followUpQueued = false;
			if (pendingSettledAction?.kind === "reinject" && pendingSettledAction.inbound === currentInbound) {
				pendingSettledAction = null;
			}
			inboundSetDuringUserTurn = false;
			userMessageDuringInbound = false;
			agentRunningUserTurn = false;
			comsSendCalledThisTurn.clear();
			log.debug("inbound_delivered", currentInbound.msg_id, "from", currentInbound.sender_name);
			return;
		}
		if (
			currentInbound
			&& msg?.role === "custom"
			&& msg?.details?.steer === true
			&& msg?.details?.target_msg_id === currentInbound.msg_id
		) {
			currentInbound.pendingSteers = Math.max(0, (currentInbound.pendingSteers ?? 0) - 1);
			log.debug("steer_delivered", msg.details.msg_id, "into", currentInbound.msg_id, "remaining", currentInbound.pendingSteers);
			return;
		}
		if (isUserMessageDuringInbound(processingInbound && inboundDelivered, msg?.role)) {
			userMessageDuringInbound = true;
			log.info("user_message_during_inbound", currentInbound?.msg_id ?? "null");
		}
	});

	// ━━ context: strip closed/superseded COMS follow-ups before any LLM call (#1226, #1429, #1430) ━━
	// Pi retains queued followUp messages across cleanShutdown() and programmatic aborts.
	// Strip prompts/steers whose senders already received session_closed or were superseded by a
	// newer delivery attempt, and abort the turn when no live user/peer prompt remains.
	pi.on("context" as any, (event: any, ctx?: ExtensionContext) => {
		if (closedInboundMsgIds.size === 0 && closedSteerTargetIds.size === 0 && supersededInboundAttempts.size === 0) return;
		const msgs = Array.isArray(event?.messages) ? event.messages : null;
		if (!msgs || msgs.length === 0) return;
		const shouldStrip = (m: any) => isClosedComsMessage(m) || isSupersededComsMessage(m);
		const filtered = msgs.filter((m: any) => !shouldStrip(m));
		if (filtered.length === msgs.length) return;
		const lastBefore = msgs[msgs.length - 1];
		const lastAfter = filtered[filtered.length - 1];
		if (shouldStrip(lastBefore) && (!lastAfter || lastAfter.role === "assistant")) {
			log.info("closed_inbound_abort_turn", { removed: msgs.length - filtered.length });
			try { ctx?.abort?.(); } catch { /* best-effort */ }
		}
		return { messages: filtered };
	});

	// ━━ Inbound finalization: capture reply, dispatch response, drain FIFO (#1226) ━━
	async function finalizeCurrentInbound(
		ctx: ExtensionContext,
		assistantMessage?: any,
		opts: { streaming?: boolean; abortError?: string } = {},
	): Promise<void> {
		if (shuttingDown || !currentInbound || !identity || finalizingInbound) return;
		const gen = sessionGeneration;
		const ident = identity;
		const isStale = () => shuttingDown || sessionGeneration !== gen;
		const ownedMsgIds: string[] = [];
		finalizingInbound = true;
		try {
			const inbound = currentInbound;
			currentInbound = null;
			deferredRecoveryInboundId = null;
			deferredRecoveryCtx = null;
			inboundDelivered = false;
			agentRunningUserTurn = false;

			// ── Mixed-turn detection (#731, #741, #1226) ─────────────────────
			// Evaluated BEFORE comsSendCalledThisTurn so a coms_send during a
			// user-interrupted turn cannot silently drop the peer's response envelope.
			const hasMixedTurn = computeMixedTurn(inboundSetDuringUserTurn, userMessageDuringInbound);
			if (userMessageDuringInbound && !inboundSetDuringUserTurn) {
				log.info("mixed_turn_user_interrupt", inbound.msg_id);
			}
			inboundSetDuringUserTurn = false;
			userMessageDuringInbound = false;

			const MAX_MIXED_RETRIES = 2;
			if (hasMixedTurn) {
				comsSendCalledThisTurn.clear();
				const retries = inbound.mixedTurnRetries ?? 0;
				if (retries < MAX_MIXED_RETRIES) {
					// Re-inject the inbound for a clean dedicated turn.
					inbound.mixedTurnRetries = retries + 1;
					log.info("mixed_turn_reinject", inbound.msg_id, "retry", inbound.mixedTurnRetries, "from", inbound.sender_name);
					try {
						injectInbound(inbound, {
							header: `[NOTE: your previous reply was not captured because a user message arrived in the same turn. ` +
								`This is a re-injection — please reply to this peer message now.]`,
							streaming: opts.streaming,
							ctx,
						});
					} catch (err: any) {
						// Re-injection failed — send error response to peer, then FIFO drain remaining
						log.error("mixed_turn_reinject_failed", inbound.msg_id, err?.message);
						inbound.fulfilled = true;
						inboundQueue.delete(inbound.msg_id);
						finalizingMsgIds.add(inbound.msg_id);
						ownedMsgIds.push(inbound.msg_id);
						bundledInbounds = [];
						maybeRefreshWidget();
						currentInbound = null;
						inboundDelivered = false;
						const queuedIds: string[] = [];
						for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound) queuedIds.push(i.msg_id);
						try {
							await sendEnvelope(inbound.sender_endpoint, {
								type: "response", msg_id: inbound.msg_id,
								sender_session: ident.coms_session_id, sender_endpoint: ident.endpoint,
								hops: 0, timestamp: nowIso(),
								response: null, error: "mixed_turn_conflict",
								queued_msg_ids: queuedIds,
							});
						} catch { /* best-effort */ }
						if (isStale()) return;
						await drainNextInbound({ bundle: false, onFail: "fail_orphans", streaming: opts.streaming, ctx }, gen);
						return;
					}
					// Re-injection succeeded — restore currentInbound (undelivered until message_start)
					currentInbound = inbound;
					inboundDelivered = false;
					return;
				}

				// Max retries exhausted — send error response to peer.
				log.warn("mixed_turn_exhausted", inbound.msg_id, "from", inbound.sender_name, "retries", retries);
				const queuedIds: string[] = [];
				for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound) queuedIds.push(i.msg_id);
				inbound.fulfilled = true;
				inboundQueue.delete(inbound.msg_id);
				finalizingMsgIds.add(inbound.msg_id);
				ownedMsgIds.push(inbound.msg_id);
				bundledInbounds = [];
				maybeRefreshWidget();
				currentInbound = null;
				inboundDelivered = false;
				try {
					await sendEnvelope(inbound.sender_endpoint, {
						type: "response", msg_id: inbound.msg_id,
						sender_session: ident.coms_session_id, sender_endpoint: ident.endpoint,
						hops: 0, timestamp: nowIso(),
						response: null, error: "mixed_turn_conflict",
						queued_msg_ids: queuedIds,
					});
				} catch { /* best-effort */ }
				if (isStale()) return;

				await drainNextInbound({ bundle: false, onFail: "fail_orphans", streaming: opts.streaming, ctx }, gen);
				return;
			}
			// ── End mixed-turn detection ─────────────────────────────────────

			// Skip auto-capture if LLM already replied via coms_send to the same peer
			const sentDirectlyToSender = comsSendCalledThisTurn.has(inbound.sender_session);
			comsSendCalledThisTurn.clear();
			if (sentDirectlyToSender) {
				log.info("agent_end_skip_autocapture", inbound.msg_id, "coms_send called this turn", "sender", inbound.sender_name);
				inbound.fulfilled = true;
				inboundQueue.delete(inbound.msg_id);
				const bundled = bundledInbounds;
				bundledInbounds = [];
				fulfillBundledInbounds(bundled, ident);
				maybeRefreshWidget();
				await drainNextInbound({ bundle: false, onFail: "reset", streaming: opts.streaming, ctx }, gen);
				return;
			}

			const bundledIds = new Set(bundledInbounds.map(bi => bi.msg_id));

			let payload: any = null;
			let error: string | null = opts.abortError ?? null;
			if (!error) {
				// Extract assistant text from turn_end's message, falling back to session branch walk for agent_end.
				let lastAssistantText = "";
				if (assistantMessage && assistantMessage.role === "assistant") {
					lastAssistantText = extractAssistantText(assistantMessage);
				} else {
					for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							lastAssistantText = extractAssistantText(entry.message);
						}
					}
				}

				payload = lastAssistantText;
				if (inbound.response_schema && typeof inbound.response_schema === "object") {
					try {
						payload = JSON.parse(lastAssistantText);
					} catch {
						error = "response not valid JSON";
						payload = null;
					}
				}
			}

			// Use inline count instead of getPendingInboundCount() — `inbound` (local param)
			// differs from `currentInbound` (module-scoped, already null at this point).
			const queuedIds: string[] = [];
			for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound && !bundledIds.has(i.msg_id)) queuedIds.push(i.msg_id);
			const respEnv: ResponseEnvelope = {
				type: "response",
				msg_id: inbound.msg_id,
				sender_session: ident.coms_session_id,
				sender_endpoint: ident.endpoint,
				hops: 0,
				timestamp: nowIso(),
				response: payload,
				error,
				queued_msg_ids: queuedIds,
			};
			// Compute your_pending at the last moment before send
			respEnv.your_pending = getSenderPending(inbound.sender_session, inbound.msg_id).filter(p => !bundledIds.has(p.msg_id));

			// Claim ownership before awaiting I/O so cleanShutdown cannot emit a conflicting
			// session_closed envelope for this msg_id while its normal reply is in flight (#1226).
			inbound.fulfilled = true;
			inboundQueue.delete(inbound.msg_id);
			finalizingMsgIds.add(inbound.msg_id);
			ownedMsgIds.push(inbound.msg_id);

			try {
				await sendEnvelope(inbound.sender_endpoint, respEnv);
				log.debug("outbound_response", inbound.msg_id, "error", error);
				appendComsHistory({
					direction: "response_out",
					msg_id: inbound.msg_id,
					peer: inbound.sender_name,
					...(resolveVerifiedPeerProject(inbound.sender_session) ? { peer_project: resolveVerifiedPeerProject(inbound.sender_session) } : {}),
					preview: truncatePreview(typeof payload === "string" ? payload : JSON.stringify(payload ?? "")),
					status: error ? `error: ${error}` : "replied",
					error: error,
				});
			} catch (e: any) {
				log.error("outbound_response_failed", inbound.msg_id, e?.message);
			}

			// Abort continuation if shutdown or session restart happened while awaiting I/O.
			if (isStale()) return;

			const bundled = bundledInbounds;
			bundledInbounds = [];
			fulfillBundledInbounds(bundled, ident, opts.abortError ?? "bundled");

			maybeRefreshWidget();

			await drainNextInbound({ bundle: true, onFail: "drop", streaming: opts.streaming, ctx }, gen);
		} finally {
			for (const id of ownedMsgIds) finalizingMsgIds.delete(id);
			if (sessionGeneration === gen) {
				finalizingInbound = false;
			}
		}
	}

	// ━━ turn_end: finalize delivered inbound on zero-tool-call completion (#1226) ━━
	// Prevents queued followUp messages (async-agent results, coms responses) from
	// starving agent_end and wedging the inbound FIFO queue indefinitely.
	pi.on("turn_end" as any, async (event: any, ctx: ExtensionContext) => {
		const msg = event?.message;
		if (msg?.role === "assistant" && typeof msg.stopReason === "string") {
			lastTurnStopReason = msg.stopReason;
		}
		if (shuttingDown || !identity || !currentInbound || !inboundDelivered || finalizingInbound) return;
		if (msg && msg.role !== "assistant") return;
		// Let agent_end handle aborted/errored turns (runLoop exits immediately after turn_end).
		if (msg?.stopReason === "error" || msg?.stopReason === "aborted") return;
		const activeRecoveryKey = resolveComsRecoverySessionKey(
			ctx,
			recoverySessionKey !== DEFAULT_BRIDGE_SESSION_KEY ? recoverySessionKey : undefined,
		);
		if (hasStreamLoopAborted(activeRecoveryKey)) return;
		const toolResults = Array.isArray(event?.toolResults) ? event.toolResults : [];
		const hasToolCalls = Array.isArray(msg?.content) && msg.content.some((b: any) => b && b.type === "toolCall");
		if (toolResults.length > 0 || hasToolCalls) return;
		// Defer while mid-turn followUp steers targeting this inbound have not yet been delivered;
		// Pi delivers follow-ups right after a zero-tool-call turn_end.
		if ((currentInbound.pendingSteers ?? 0) > 0) {
			log.debug("turn_end_defer_pending_steer", currentInbound.msg_id, "pendingSteers", currentInbound.pendingSteers);
			return;
		}
		log.info("turn_end_finalize", currentInbound.msg_id, "stopReason", msg?.stopReason ?? "unknown");
		await finalizeCurrentInbound(ctx, msg, { streaming: true });
	});

	function resolveAgentEndStopReason(event: any): string | null {
		const msgs = Array.isArray(event?.messages) ? event.messages : null;
		if (msgs) {
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m?.role === "assistant" && typeof m.stopReason === "string") {
					return m.stopReason;
				}
			}
		}
		return lastTurnStopReason;
	}

	function reinjectUndeliveredInbound(
		inbound: InboundContext,
		ctx: ExtensionContext | null | undefined,
		opts: { streaming?: boolean } = {},
	): boolean {
		const retries = inbound.undeliveredRetries ?? 0;
		inbound.undeliveredRetries = retries + 1;
		inbound.followUpQueued = false;
		const nextAttempt = (inbound.injectAttempt ?? 0) + 1;
		inbound.injectAttempt = nextAttempt;
		rememberSupersededAttempt(inbound.msg_id, nextAttempt);
		for (const b of bundledInbounds) {
			b.injectAttempt = Math.max(b.injectAttempt ?? 0, nextAttempt);
			rememberSupersededAttempt(b.msg_id, b.injectAttempt);
		}
		log.warn("agent_end_undelivered_reinject", inbound.msg_id, "retry", inbound.undeliveredRetries, "attempt", nextAttempt, "from", inbound.sender_name);
		try {
			if (bundledInbounds.length > 0) {
				const senderPending = [inbound, ...bundledInbounds];
				const bundle = buildBundledContent(inbound.sender_name, senderPending);
				injectInbound(inbound, {
					bundled: { ...bundle, ids: senderPending.map(i => i.msg_id), attempt: nextAttempt },
					streaming: opts.streaming,
					ctx,
				});
			} else {
				injectInbound(inbound, { streaming: opts.streaming, ctx });
			}
			currentInbound = inbound;
			inboundDelivered = false;
			return true;
		} catch (err: any) {
			log.error("agent_end_undelivered_reinject_failed", inbound.msg_id, err?.message);
			return false;
		}
	}

	async function abortUndeliveredInboundAndDrain(
		inbound: InboundContext,
		ident: NonNullable<typeof identity>,
		ctx: ExtensionContext | null | undefined,
		gen: number,
		retries: number,
	): Promise<void> {
		log.warn("agent_end_undelivered_aborted", inbound.msg_id, "from", inbound.sender_name, "retries", retries);
		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		rememberClosedId(closedInboundMsgIds, inbound.msg_id);
		finalizingMsgIds.add(inbound.msg_id);
		bundledInbounds = [];
		maybeRefreshWidget();
		const queuedIds: string[] = [];
		for (const i of inboundQueue.values()) if (!i.fulfilled && i !== inbound) queuedIds.push(i.msg_id);
		try {
			await sendEnvelope(inbound.sender_endpoint, {
				type: "response",
				msg_id: inbound.msg_id,
				sender_session: ident.coms_session_id,
				sender_endpoint: ident.endpoint,
				hops: 0,
				timestamp: nowIso(),
				response: null,
				error: "aborted",
				queued_msg_ids: queuedIds,
			});
		} catch { /* best-effort */ } finally {
			finalizingMsgIds.delete(inbound.msg_id);
		}
		if (shuttingDown || sessionGeneration !== gen) return;
		if (queuedIds.length > 0 && isPiStreaming(ctx)) {
			pendingSettledAction = { kind: "drain", gen, ctx };
			log.debug("agent_end_drain_defer_settled", { queued: queuedIds.length });
			return;
		}
		await drainNextInbound({ bundle: true, onFail: "fail_orphans", ctx }, gen);
	}

	// ━━ agent_end: safety net for delivered & aborted-before-delivery inbounds ━━
	pi.on("agent_end", async (event, ctx) => {
		agentRunning = false;
		beforeAgentStartPending = false;
		syncBusyState(ctx, { reason: "agent_end" });
		const stopReason = resolveAgentEndStopReason(event);
		lastTurnStopReason = null;
		log.info("agent_end_enter", "currentInbound", currentInbound?.msg_id ?? "null", "delivered", inboundDelivered, "identity", !!identity, "processingInbound", processingInbound);
		if (finalizingInbound) {
			log.debug("agent_end_skip_finalizing");
			return;
		}
		if (!currentInbound || !identity) {
			const shouldDrainKilled = Boolean(identity && !shuttingDown && pendingDrainAfterKill);
			pendingDrainAfterKill = false;
			// Drain any orphaned inbounds — can't send responses without identity,
			// but must clear the queue to prevent permanent buildup
			if (!identity) {
				for (const [id, ib] of inboundQueue) {
					ib.fulfilled = true;
					inboundQueue.delete(id);
				}
				currentInbound = null;
				bundledInbounds = [];
			}
			inboundDelivered = false;
			agentRunningUserTurn = false;
			inboundSetDuringUserTurn = false;
			userMessageDuringInbound = false;
			comsSendCalledThisTurn.clear();
			if (shouldDrainKilled) {
				const gen = sessionGeneration;
				log.info("agent_end_drain_after_kill");
				await drainNextInbound({ bundle: true, onFail: "drop", ctx }, gen);
				return;
			}
			setProcessingInbound(false);
			log.debug("agent_end_early", "currentInbound", currentInbound?.msg_id ?? "null", "processingInbound", processingInbound);
			return;
		}

		if (inboundDelivered) {
			const activeRecoveryKey = resolveComsRecoverySessionKey(
				ctx,
				recoverySessionKey !== DEFAULT_BRIDGE_SESSION_KEY ? recoverySessionKey : undefined,
			);
			if (activeRecoveryKey !== recoverySessionKey) {
				subscribeMalformedRecoveryAborted(activeRecoveryKey);
			}
			if (consumeStreamLoopAborted(activeRecoveryKey)) {
				log.warn("agent_end_stream_loop_aborted", currentInbound.msg_id);
				await finalizeCurrentInbound(ctx, undefined, { abortError: "stream_repetition_loop_aborted" });
				return;
			}
			if (shouldDeferForMalformedRecovery((event as any)?.messages, activeRecoveryKey)) {
				deferredRecoveryInboundId = currentInbound.msg_id;
				deferredRecoveryCtx = ctx;
				log.info("agent_end_deferred_for_malformed_recovery", currentInbound.msg_id);
				return;
			}
			await finalizeCurrentInbound(ctx);
			return;
		}

		// #1429: An undelivered inbound (direct-run OR queued as followUp) reached agent_end
		// without Pi emitting message_start. On abort (e.g. Esc clears Pi's followUp queue)
		// or any completed turn finishing without delivering it, never return early forever
		// with processingInbound = true. Clear followUpQueued and enter bounded recovery:
		// re-inject once (deferred to agent_settled while Pi is still settling so it starts a
		// fresh run), or fail with "aborted" and drain FIFO so idle cannot stay wedged.
		const gen = sessionGeneration;
		const ident = identity;
		const inbound = currentInbound;
		const wasFollowUpQueued = inbound.followUpQueued === true;
		inbound.followUpQueued = false;
		agentRunningUserTurn = false;
		inboundSetDuringUserTurn = false;
		userMessageDuringInbound = false;
		comsSendCalledThisTurn.clear();

		if (wasFollowUpQueued) {
			log.warn("agent_end_followup_lost", inbound.msg_id, "from", inbound.sender_name, "stopReason", stopReason ?? "unknown");
		}

		const MAX_UNDELIVERED_RETRIES = 1;
		const retries = inbound.undeliveredRetries ?? 0;
		if (retries < MAX_UNDELIVERED_RETRIES) {
			if (isPiStreaming(ctx)) {
				pendingSettledAction = { kind: "reinject", inbound, gen, ctx };
				log.info("agent_end_undelivered_defer_settled", inbound.msg_id, "from", inbound.sender_name, "stopReason", stopReason ?? "unknown");
				return;
			}
			currentInbound = null;
			inboundDelivered = false;
			if (reinjectUndeliveredInbound(inbound, ctx)) return;
		}

		pendingSettledAction = null;
		currentInbound = null;
		inboundDelivered = false;
		await abortUndeliveredInboundAndDrain(inbound, ident, ctx, gen, retries);
	});

	// ━━ agent_settled: run deferred undelivered re-inject / FIFO drain once Pi is idle (#1429) ━━
	pi.on("agent_settled" as any, async (_event: any, ctx?: ExtensionContext) => {
		agentRunning = false;
		beforeAgentStartPending = false;
		syncBusyState(ctx, { reason: "agent_settled" });
		const action = pendingSettledAction;
		pendingSettledAction = null;
		if (!action) return;
		if (shuttingDown || !identity || sessionGeneration !== action.gen) return;
		const useCtx = ctx ?? action.ctx ?? currentCtx;
		if (action.kind === "reinject") {
			if (currentInbound !== action.inbound || inboundDelivered || action.inbound.fulfilled) return;
			currentInbound = null;
			inboundDelivered = false;
			if (reinjectUndeliveredInbound(action.inbound, useCtx, { streaming: false })) return;
			const retries = action.inbound.undeliveredRetries ?? 0;
			await abortUndeliveredInboundAndDrain(action.inbound, identity, useCtx, action.gen, retries);
			return;
		}
		if (action.kind === "drain") {
			if (currentInbound !== null) return;
			await drainNextInbound({ bundle: true, onFail: "fail_orphans", streaming: false, ctx: useCtx }, action.gen);
		}
	});

	// ━━ #968 part C: pidash browser bridge ─━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Peer list + messaging from the browser, routed through the SAME
	// resolveTarget/deliverPrompt path as coms_send — identical delivery
	// semantics, browser is just another transport.
	function emitComsPeers(): void {
		try {
			pi.events.emit("pidash:coms-peers", buildComsPeersPayload(
				peerCards.values(),
				identity ? { name: identity.name, purpose: identity.purpose, project: identity.project } : null,
			));
		} catch { /* pidash not loaded */ }
	}
	pi.events.on("pidash:coms-peers-request", () => emitComsPeers());
	pi.events.on("pidash:coms-send", async (data: unknown) => {
		const d = data as { requestId?: string; target?: string; prompt?: string; steer?: boolean; priority?: boolean };
		if (!d?.target || !d?.prompt) {
			pi.events.emit("pidash:coms-send-result", { requestId: d?.requestId, ok: false, error: "target and prompt required" });
			return;
		}
		try {
			if (!identity) throw new Error("coms not initialised");
			const target = await resolveTarget(d.target);
			if (!target) throw new Error(`peer not found: ${d.target}`);
			const { msg_id } = await deliverPrompt(target, {
				prompt: d.prompt,
				...(d.steer ? { steer: true } : {}),
				...(d.priority ? { priority: true } : {}),
			});
			log.info("pidash_coms_send", { target: target.name, msg_id, steer: !!d.steer });
			pi.events.emit("pidash:coms-send-result", { requestId: d.requestId, ok: true, msg_id, target: target.name });
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			log.warn("pidash_coms_send_failed", { target: d.target, error });
			pi.events.emit("pidash:coms-send-result", { requestId: d.requestId, ok: false, error });
		}
	});

	// ━━ Local inbound queue overlay (opened from /coms via `q`) ━━━━━━━━━━━
	const openQueueOverlay = async (_args: string, ctx: any): Promise<void> => {
		if (!identity) {
			try { ctx?.ui?.notify?.("📡 coms not active — no queue. Activate coms with coms_start first.", "info"); } catch { /* ignore */ }
			return;
		}
		await openListDetailOverlay(ctx, {
			emptyMessage: "No queued coms messages.",
			listSpec: {
				title: "Coms Queue",
				countLabel: (items) => `${items.length} message${items.length === 1 ? "" : "s"}`,
				borderTitle: (items) => {
					const processing = items.filter(i => i.status === "processing").length;
					return `queue · ${processing} processing / ${items.length}`;
				},
				footerHints: "↑↓/jk select · Space multi-select · Enter view · x kill · Esc back",
				listItems: listLocalInboundQueue,
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
				selectable: true,
				onX: (item) => { void killLocalInboundQueueItem(item.id); },
				onXSelected: (items) => {
					log.info("queue_bulk_kill", { count: items.length });
					// Kill pending items first so killing an active item never drains a selected pending item.
					const ordered = [...items].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));
					for (const item of ordered) void killLocalInboundQueueItem(item.id);
				},
			},
			createDetail: (item, tui, theme, done) => {
				return new OverlayScrollDetail(tui, theme, {
					followTail: false,
					emptyBody: "(no prompt)",
					footerHints: "↑↓/jk scroll · x kill · Esc back",
					onX: () => {
						void killLocalInboundQueueItem(item.id);
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
	};

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | null = null;
	let nonReloadStopReason: string | null = null;
	async function stopPingWorker(worker: Worker): Promise<void> {
		let timeout: NodeJS.Timeout | undefined;
		const exited = new Promise<boolean>((resolve) => worker.once("exit", () => resolve(true)));
		log.info("ping_worker_stop", { outcome: "shutdown_requested" });
		try { worker.postMessage({ type: "shutdown" }); } catch {}
		const graceful = await Promise.race([exited, new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 1_000); })]);
		if (timeout) clearTimeout(timeout);
		if (!graceful) try { await worker.terminate(); } catch {}
		log.info("ping_worker_stop", { outcome: graceful ? "graceful" : "terminated" });
	}
	async function cleanShutdown(stopOptions?: ComsPeerStopOptions): Promise<void> {
		const isReloadShutdown = stopOptions?.reason === "reload";
		if (shuttingDown) {
			if (!isReloadShutdown) {
				nonReloadStopReason = stopOptions?.reason ?? "stop";
				if (shutdownPromise) {
					await shutdownPromise;
				}
				const discardProject = stopOptions?.project ?? lastReloadHandoff?.project;
				const discardSessionId = stopOptions?.sessionId ?? lastReloadHandoff?.sessionId;
				lastReloadHandoff = null;
				if (discardProject && discardSessionId) {
					await discardReloadQueue(registry, discardProject, discardSessionId, nonReloadStopReason ?? "stop");
				}
			}
			return;
		}
		shuttingDown = true;
		nonReloadStopReason = isReloadShutdown ? null : (stopOptions?.reason ?? "stop");
		const runShutdown = async (): Promise<void> => {
		sessionGeneration++;
		if (reloadDrainTimer) { try { clearTimeout(reloadDrainTimer); } catch { /* ignore */ } reloadDrainTimer = null; }
		pendingSettledAction = null;
		lastTurnStopReason = null;
		try { pi.events.emit("pidash:coms-identity", { name: null, purpose: null }); } catch {}
		const ident = identity; // snapshot before nulling
		const shutdownCtx = currentCtx;
		currentCtx = null;
		identity = null; // null identity so old handlers from previous reload cycles exit via !identity check
		if (fsWatcher) { try { fsWatcher.close(); } catch { /* ignore */ } fsWatcher = null; }
		if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
		if (staleCheckTimer) { try { clearInterval(staleCheckTimer); } catch { /* ignore */ } staleCheckTimer = null; }
		if (taskHeartbeatTimer) { try { clearInterval(taskHeartbeatTimer); } catch { /* ignore */ } taskHeartbeatTimer = null; }
		if (progressSignalTimer) { try { clearInterval(progressSignalTimer); } catch { /* ignore */ } progressSignalTimer = null; }
		if (pendingReplyCleanupTimers.size > 0) {
			log.debug("pending_reply_cleanup_timers_cleared", { count: pendingReplyCleanupTimers.size });
		}
		for (const timer of pendingReplyCleanupTimers) {
			try { clearTimeout(timer); } catch { /* ignore */ }
		}
		pendingReplyCleanupTimers.clear();
		// Broadcast "leaving" presence to all known peers (fire-and-forget)
		if (ident) {
			let fallbackEntries: RegistryEntry[] | null = null;
			for (const [sid, card] of peerCards) {
				if (sid === ident.coms_session_id) continue;
				const endpoint = card.endpoint
					?? (fallbackEntries ??= registry.readEntries(ident.project))
						.find(e => e.name === card.name && e.coms_session_id !== ident!.coms_session_id)?.endpoint;
				if (endpoint) {
					log.info("shutdown_leaving_broadcast", "to", card.name, endpoint);
					try {
						const sock = net.createConnection({ path: endpoint });
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
			const activeServer = server;
			server = null;
			try {
				for (const connection of connections) connection.destroy();
				connections.clear();
				// #951: net.Server has no closeAllConnections at runtime or in @types/node —
				// the optional call is a graceful no-op; typed accordingly.
				(activeServer as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); activeServer.close(); activeServer.unref();
			} catch { /* ignore */ }
		}
		if (pingWorker) {
			const worker = pingWorker;
			pingWorker = null;
			pingWorkerReady = false;
			await stopPingWorker(worker);
			log.info("ping_worker_shutdown", { outcome: "graceful_or_terminated" });
		}
		if (ident) {
			if (process.platform !== "win32") {
				try { fs.unlinkSync(ident.endpoint); } catch { /* ignore */ }
			}
			try { registry.removeEntry(ident.project, ident.coms_session_id); } catch { /* ignore */ }
			log.info("shutdown", ident.coms_session_id, "reason", stopOptions?.reason ?? "stop");
		}
		for (const pending of pendingReplies.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.resolve) pending.resolve({ error: "session_closed" });
		}
		pendingReplies.clear();
		pendingOutbound.clear();
		queueRecoveryPreviews.clear();
		// Snapshot waiting inbound senders and reset all in-memory inbound queue state so
		// /coms stop -> /coms start (which reuses this closure) starts completely clean (#1226).
		// On `/reload` (#1430), persist unfulfilled queued/undelivered inbounds for the same
		// sessionId instead of replying `session_closed`, so the reloaded runtime drains them.
		const wasCurrentDelivered = inboundDelivered;
		const snapshotCurrent = currentInbound;
		const snapshotBundled = [...bundledInbounds];
		const waitingInbounds: InboundContext[] = [];
		const persistedInbounds: PersistedReloadInbound[] = [];
		const persistedIds = new Set<string>();
		const injectedBeforeReload = new Set<string>();
		if (snapshotCurrent && !wasCurrentDelivered) {
			injectedBeforeReload.add(snapshotCurrent.msg_id);
			for (const b of snapshotBundled) injectedBeforeReload.add(b.msg_id);
		}
		const toPersistedReloadInbound = (ib: InboundContext): PersistedReloadInbound => ({
			msg_id: ib.msg_id,
			hops: ib.hops,
			sender_endpoint: ib.sender_endpoint,
			sender_session: ib.sender_session,
			sender_name: ib.sender_name,
			sender_cwd: ib.sender_cwd,
			prompt: ib.prompt,
			tasks: ib.tasks ?? null,
			conversation_id: ib.conversation_id ?? null,
			response_schema: ib.response_schema ?? null,
			queued_at: ib.queued_at,
			...(ib.priority ? { priority: true } : {}),
			...(ib.origin ? { origin: ib.origin } : {}),
			...(ib.injectAttempt ? { injectAttempt: ib.injectAttempt } : {}),
			...(injectedBeforeReload.has(ib.msg_id) ? { wasInjected: true } : {}),
		});

		const effectiveReloadShutdown = isReloadShutdown && nonReloadStopReason === null;
		if (effectiveReloadShutdown && ident) {
			const deliveredBundleIds = new Set<string>();
			const persistCandidate = (ib: InboundContext | null | undefined) => {
				if (!ib || ib.fulfilled || finalizingMsgIds.has(ib.msg_id) || persistedIds.has(ib.msg_id)) return;
				ib.fulfilled = true;
				persistedIds.add(ib.msg_id);
				persistedInbounds.push(toPersistedReloadInbound(ib));
			};
			if (snapshotCurrent && !wasCurrentDelivered) {
				persistCandidate(snapshotCurrent);
				for (const b of snapshotBundled) persistCandidate(b);
			} else if (snapshotCurrent && wasCurrentDelivered) {
				for (const deliveredIb of [snapshotCurrent, ...snapshotBundled]) {
					deliveredBundleIds.add(deliveredIb.msg_id);
					if (!deliveredIb.fulfilled && !finalizingMsgIds.has(deliveredIb.msg_id)) {
						deliveredIb.fulfilled = true;
						waitingInbounds.push(deliveredIb);
					}
				}
			}
			for (const ib of inboundQueue.values()) {
				if (deliveredBundleIds.has(ib.msg_id)) continue;
				persistCandidate(ib);
			}
			if (persistedInbounds.length > 0) {
				try {
					persistReloadQueue(
						registry,
						ident.project,
						ident.coms_session_id,
						ident.endpoint,
						persistedInbounds,
						reloadQueueTtlMs,
						registerSignalHandlers,
					);
					lastReloadHandoff = { project: ident.project, sessionId: ident.coms_session_id };
				} catch (err: any) {
					log.error("reload_queue_persist_failed", {
						sessionId: ident.coms_session_id,
						count: persistedInbounds.length,
						error: err?.message ?? String(err),
					});
					// Fail-safe: if persistence failed, notify senders with session_closed so they never hang.
					for (const item of persistedInbounds) {
						waitingInbounds.push({
							msg_id: item.msg_id,
							hops: item.hops,
							sender_endpoint: item.sender_endpoint,
							sender_session: item.sender_session,
							sender_name: item.sender_name,
							sender_cwd: item.sender_cwd,
							prompt: item.prompt,
							queued_at: item.queued_at,
							fulfilled: true,
						});
					}
				}
			}
		} else {
			const seenInboundIds = new Set<string>();
			for (const ib of inboundQueue.values()) {
				if (!ib.fulfilled && !finalizingMsgIds.has(ib.msg_id)) {
					ib.fulfilled = true;
					waitingInbounds.push(ib);
					seenInboundIds.add(ib.msg_id);
				}
			}
			if (snapshotCurrent && !snapshotCurrent.fulfilled && !finalizingMsgIds.has(snapshotCurrent.msg_id) && !seenInboundIds.has(snapshotCurrent.msg_id)) {
				snapshotCurrent.fulfilled = true;
				waitingInbounds.push(snapshotCurrent);
			}
			const discardProject = stopOptions?.project ?? ident?.project ?? lastReloadHandoff?.project;
			const discardSessionId = stopOptions?.sessionId ?? ident?.coms_session_id ?? lastReloadHandoff?.sessionId ?? options.sessionId;
			lastReloadHandoff = null;
			if (discardProject && discardSessionId) {
				await discardReloadQueue(registry, discardProject, discardSessionId, stopOptions?.reason ?? "stop");
			}
		}

		// Record closed undelivered inbounds (and pending steers on delivered inbounds) BEFORE
		// sending session_closed so Pi cannot execute any retained followUp copy after stop/restart.
		for (const ib of waitingInbounds) {
			if (ib === snapshotCurrent && wasCurrentDelivered) {
				if ((ib.pendingSteers ?? 0) > 0) {
					rememberClosedId(closedSteerTargetIds, ib.msg_id);
				}
			} else {
				rememberClosedId(closedInboundMsgIds, ib.msg_id);
			}
		}
		inboundQueue.clear();
		comsSendCalledThisTurn.clear();
		bundledInbounds = [];
		currentInbound = null;
		inboundDelivered = false;
		finalizingInbound = false;
		processingInbound = false;
		pendingDrainAfterKill = false;
		if (agentRunning || beforeAgentStartPending) {
			log.debug("agent_busy_transition", { busy: false, agentRunning: false, beforeAgentStartPending: false, processingInbound: false, reason: "shutdown" });
		}
		agentRunning = false;
		beforeAgentStartPending = false;
		lastReportedBusy = false;
		agentRunningUserTurn = false;
		inboundSetDuringUserTurn = false;
		userMessageDuringInbound = false;
		if (ident && waitingInbounds.length > 0) {
			log.info("shutdown_notify_waiting_inbounds", { count: waitingInbounds.length });
			let notifyTimeout: NodeJS.Timeout | undefined;
			await Promise.race([
				Promise.allSettled(waitingInbounds.map((ib) =>
					sendEnvelope(ib.sender_endpoint, {
						type: "response",
						msg_id: ib.msg_id,
						sender_session: ident.coms_session_id,
						sender_endpoint: ident.endpoint,
						hops: 0,
						timestamp: nowIso(),
						response: null,
						error: "session_closed",
						queued_msg_ids: [],
					}).catch((err) => {
						log.debug("shutdown_notify_inbound_failed", ib.msg_id, err instanceof Error ? err.message : String(err));
					}),
				)),
				new Promise<void>((resolve) => {
					notifyTimeout = setTimeout(resolve, 500);
					notifyTimeout.unref?.();
				}),
			]);
			if (notifyTimeout) clearTimeout(notifyTimeout);
		}
		if (signalsBound) {
			process.off("SIGINT", handleSigint);
			process.off("SIGTERM", handleSigterm);
			signalsBound = false;
		}
		log.debug("recovery_previews_cleared", { reason: "shutdown" });
		clearPoolVisibilityListeners();
		unsubMalformedRecoveryAborted?.();
		unsubMalformedRecoveryAborted = null;
		recoverySessionKey = DEFAULT_BRIDGE_SESSION_KEY;
		deferredRecoveryInboundId = null;
		deferredRecoveryCtx = null;
		if (shutdownCtx && isLiveExtensionCtx(shutdownCtx) && shutdownCtx.hasUI) {
			try { shutdownCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
			try { shutdownCtx.ui.setStatus("coms", undefined); } catch { /* ignore */ }
		}
		};
		const activePromise = runShutdown().finally(() => {
			if (shutdownPromise === activePromise) shutdownPromise = null;
		});
		shutdownPromise = activePromise;
		await activePromise;
	}

	const handleSigint = () => { log.info("signal_received", { signal: "SIGINT" }); void cleanShutdown({ reason: "signal" }); };
	const handleSigterm = () => { log.info("signal_received", { signal: "SIGTERM" }); void cleanShutdown({ reason: "signal" }); };
	if (!deferred) {
		pi.on("session_shutdown", async (event?: any) => {
			await cleanShutdown({ reason: event?.reason });
		});
	}

	return {
		start: startPeer,
		stop: cleanShutdown,
		getSelf,
		isActive: () => identity !== null,
		sendAsUser,
		openQueueOverlay,
		gatedToolNames,
	};
}

export default function (pi: ExtensionAPI): ComsPeerRuntime | undefined {
	if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;
	return createComsPeerRuntime(pi, { deferred: false });
}
