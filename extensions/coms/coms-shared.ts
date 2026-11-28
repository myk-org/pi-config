/**
 * coms-shared.ts — Shared utilities for the COMS extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createLogger } from "../shared/logger.js";
import { resolveStorePath } from "../pitasks/task-store.js";
import { stripOriginMarker } from "./peer-text.js";

const log = createLogger("coms");
/** #1084: the tell helpers' own trail — parse/build/resolve outcomes, never message text. */
const tellLog = createLogger("coms-tell");

/**
 * Tokenize a command string respecting double and single quotes.
 * Quoted values are returned as single tokens with quotes stripped.
 */
export function tokenizeArgs(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    for (const ch of input) {
        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (/\s/.test(ch)) {
            if (current) { tokens.push(current); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

/**
 * Parse --key value pairs from command arguments into a Map.
 * Boolean flags (like --explicit) are set to true without consuming the next token.
 */
export function parseFlags(parts: string[], values: Map<string, any>): void {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.startsWith('--')) continue;
        const key = part.slice(2);
        if (key === 'explicit') {
            values.set(key, true);
            continue;
        }
        if (i + 1 < parts.length) {
            const val = parts[i + 1];
            if (val && !val.startsWith('--')) {
                values.set(key, val);
                i++;
            }
        }
    }
}

export interface ComsPersistedState {
    /** Whether the COMS peer runtime is active */
    active: boolean;
    /** Flag values persisted across reload */
    flagValues: Map<string, any>;
    /** Extra persisted metadata (e.g. activation origin) */
    extra?: Record<string, any>;
}

/**
 * Sync COMS-gated tools (the 15 P2P tools + coms_stop) in the active tool set.
 */
export function syncComsActiveTools(
    pi: ExtensionAPI,
    gatedTools: ReadonlySet<string>,
    active: boolean,
): void {
    if (!gatedTools || gatedTools.size === 0) return;
    const current = pi.getActiveTools();
    const allTools = pi.getAllTools();
    // Codemode is registered with defaultActive: false, so only treat it as reaching
    // codemode/deferred COMS tools when it is actually active in the current loadout.
    const codemodeActive =
        current.includes("codemode") &&
        (!Array.isArray(allTools) ||
            allTools.some((t: any) => t?.name === "codemode" && t?.exposure !== "hidden"));
    const exposureByName = new Map<string, string>();
    if (Array.isArray(allTools)) {
        for (const t of allTools) {
            if (typeof t?.name === "string" && typeof t?.exposure === "string") {
                exposureByName.set(t.name, t.exposure);
            }
        }
    }
    if (active) {
        // When Pi's codemode tool is active, keep exposure: "codemode" / "deferred"
        // tools out of the top-level active set so coms_start never promotes COMS schemas
        // back into direct model declarations (#1451).
        const toAdd = [...gatedTools].filter((name) => {
            if (current.includes(name)) return false;
            if (codemodeActive) {
                const exp = exposureByName.get(name);
                if (exp === "codemode" || exp === "deferred") return false;
            }
            return true;
        });
        if (toAdd.length === 0) return;
        pi.setActiveTools([...current, ...toAdd]);
        log.debug("coms_active_tools_added", { count: toAdd.length, tools: toAdd });
    } else {
        const next = current.filter((name) => !gatedTools.has(name));
        if (next.length === current.length) return;
        pi.setActiveTools(next);
        log.debug("coms_active_tools_removed", { count: current.length - next.length });
    }
}

/**
 * Persist coms activation state so it survives reload.
 */
export function persistState(pi: ExtensionAPI, persistKey: string, state: ComsPersistedState): void {
    try {
        const flags: Record<string, any> = {};
        for (const [k, v] of state.flagValues) flags[k] = v;
        pi.appendEntry(persistKey, { active: state.active, flags, extra: state.extra || {} });
    } catch (e: unknown) {
        log.warn("persist_state_failed", { error: e instanceof Error ? e.message : String(e) });
    }
}

// ━━ Shared helpers (used by coms-p2p.ts) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // pragma: allowlist secret

export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

export function hexFg(hex: string, s: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function fallbackColor(sessionId: string): string {
	const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

export function comsParseYamlFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			frontmatter[key] = val;
		}
	}
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		color: frontmatter.color,
		body: match[2],
	};
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function abbreviateModel(model: string): string {
	let m = model || "";
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.length > 14) m = m.slice(0, 14);
	return m;
}

export function findSystemPromptPath(argv: string[]): string | null {
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === flag && i + 1 < argv.length) {
				const candidate = argv[i + 1];
				if (candidate.endsWith(".md")) {
					try {
						if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
							return candidate;
						}
					} catch { /* fall through */ }
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

export function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
	const p = findSystemPromptPath(argv);
	if (!p) return {};
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const { name, description, color } = comsParseYamlFrontmatter(raw);
		return { name, description, color };
	} catch {
		return {};
	}
}

type PitasksModule = typeof import("../pitasks/index.js");
let _pitasksPromise: Promise<PitasksModule> | null = null;

/** Lazy-load pitasks once per process (retries if an import ever failed). */
export function loadPitasks(): Promise<PitasksModule> {
	return (_pitasksPromise ??= import("../pitasks/index.js").catch((err) => {
		_pitasksPromise = null;
		throw err;
	}));
}

export function summarizeTaskList(tasks: readonly any[] | null | undefined): TasksSummary | null {
	if (!tasks || tasks.length === 0) return null;
	let total = 0, completed = 0, in_progress = 0;
	for (const t of tasks) {
		total++;
		if (t?.status === "completed") completed++;
		else if (t?.status === "in_progress") in_progress++;
	}
	return { total, completed, in_progress };
}

export async function readTaskSummary(_cwd: string, _sessionId?: string): Promise<TasksSummary | null> {
	log.debug("read_task_summary", { hasSessionId: !!_sessionId });
	try {
		const { listTasks } = await loadPitasks();
		return summarizeTaskList(listTasks());
	} catch { return null; }
}

/** Who authored an inbound prompt: a human (only the command layer knows that) or another
 *  agent's model. "peer" is the default so a missing or unrecognised value can never claim
 *  human authority. */
export type PromptOrigin = "user" | "peer";

/** Decide the envelope `origin`. Only the CALLER'S ROLE produces `user`, and only as the literal
 *  boolean `true`: a value that merely looks like an origin (a JSON string from tool input, an
 *  absent field) degrades to `peer`, so a tool cannot spoof human authority (#1077). */
export function resolvePromptOrigin(userAuthored: unknown): PromptOrigin {
	return userAuthored === true ? "user" : "peer";
}

/** True when a received envelope claims human authorship — the receiver trusts the literal only. */
export function isUserOrigin(value: unknown): boolean {
	return value === "user";
}

/** The origin a RECEIVER reads off an envelope: only the exact literal "user" counts, so a missing
 *  field (older sender), a forged value, or a malformed one all read as a peer message. */
export function receivedPromptOrigin(value: unknown): PromptOrigin {
	return isUserOrigin(value) ? "user" : "peer";
}

/** One bundled inbound as it is rendered to the receiver. Origin is PER MESSAGE: a user message
 *  and another agent's message from the same peer arrive in one bundle, and labelling the whole
 *  bundle "from the user" would launder the agent's text as a human decision (#1077). */
export interface BundledInbound {
	msg_id: string;
	prompt: string;
	origin?: PromptOrigin;
}

/** Render a FIFO bundle: each message carries its own origin tag, and `origin` is returned only
 *  when EVERY message shares it (mixed bundles get no bundle-level marker). */
export function buildBundledContent(
	senderName: string,
	messages: BundledInbound[],
): { header: string; content: string; origin?: PromptOrigin } {
	const safeSender = sanitizeComsName(senderName);
	const origins = new Set(messages.map((m) => m.origin ?? "peer"));
	const shared = origins.size === 1 ? messages[0]?.origin ?? "peer" : undefined;
	const content = messages.map((m, idx) => {
		const msgOrigin = m.origin ?? "peer";
		const tag = msgOrigin === "user" ? `[from USER (a human), via ${safeSender}] ` : `[from ${safeSender}] `;
		// Origin is decided by the envelope's structured field; this tag is display only. A peer body
		// that printed the marker itself would read as a human line, so peer text loses it — the
		// human's own words are never rewritten.
		const body = msgOrigin === "user" ? m.prompt : stripOriginMarker(m.prompt);
		return `--- Message ${idx + 1} of ${messages.length} [${m.msg_id}] ---\n${tag}${body}`;
	}).join("\n\n");
	const mixed = shared === undefined
		? " ORIGINS ARE MIXED: messages tagged [from USER (a human), via …] are the human's words; the rest are another agent's. Weigh them differently."
		: "";
	// The only trace of WHY a bundle rendered its labels the way it did — a mixed bundle gets no
	// bundle-level marker, which looks like a missing one unless this line says otherwise.
	log.debug("bundle_origins", { messages: messages.length, shared: shared ?? "mixed", origins: [...origins].join(",") });
	const header = `[BUNDLED: ${messages.length} messages from ${safeSender}. Later messages may override earlier ones. Read ALL before acting.${mixed}]`;
	return { header, content, ...(shared ? { origin: shared } : {}) };
}

/** Build the command-layer send request from the peers overlay composer. A blank line means
 *  "nothing to send" (Esc and empty input are the same decision), so it yields null. */
export function buildTellRequest(
	peer: { name: string; project?: string | null; endpoint?: string },
	text: string,
): { target: string; prompt: string; project?: string; expectedEndpoint?: string } | null {
	const prompt = text.trim();
	if (!prompt) return null;
	tellLog.debug("tell_built", { target: peer.name, origin: "user" });
	return { target: peer.name, prompt, ...(peer.project ? { project: peer.project } : {}), ...(peer.endpoint ? { expectedEndpoint: peer.endpoint } : {}) };
}

export const COMS_INBOUND_CUSTOM_TYPE = "coms-inbound";
export const COMS_RESPONSE_CUSTOM_TYPE = "coms-response";
export const COMS_PEER_JOINED_CUSTOM_TYPE = "coms-peer-joined";
export const COMS_PEER_LEFT_CUSTOM_TYPE = "coms-peer-left";

export interface ComsInboundDetails {
	msg_id: string;
	header: string;
	sender: string;
	target: string;
	sender_session?: string;
	sender_cwd?: string;
	origin?: PromptOrigin;
	/** Structured origin of the first bundled message when a FIFO bundle has mixed origins. */
	summaryOrigin?: PromptOrigin;
	response_schema?: unknown;
	inject_attempt?: number;
	bundled_msg_ids?: string[];
	steer?: boolean;
	target_msg_id?: string;
	summaryLine: string;
}

export interface ComsResponseDetails {
	msg_id: string;
	header: string;
	sender: string;
	target: string;
	target_name?: string;
	error: string | null;
	queued_msg_ids: string[];
	queuedMsgIds: string[];
	summaryLine: string;
}

export interface ComsPeerEventDetails {
	peer: string;
	model?: string;
	purpose?: string;
}

/** Match both fixed `"coms-inbound"` and legacy dynamic `"from ..."` / `"steer from ..."` customTypes. */
export function isComsInboundCustomType(customType: string | undefined | null): boolean {
	if (typeof customType !== "string") return false;
	return customType === COMS_INBOUND_CUSTOM_TYPE
		|| customType.startsWith("from ")
		|| customType.startsWith("steer from ");
}

/** Match both fixed `"coms-response"` and legacy dynamic `"coms response from ..."` customTypes. */
export function isComsResponseCustomType(customType: string | undefined | null): boolean {
	if (typeof customType !== "string") return false;
	return customType === COMS_RESPONSE_CUSTOM_TYPE
		|| customType.startsWith("coms response from ");
}

/** Build the header string for coms inbound display (stored in `details.header` on `"coms-inbound"` messages).
 *  Sanitizes all inputs since senderName/senderCwd come from untrusted peers. */
export function formatComsInboundType(senderName: string, selfName: string, senderCwd: string, origin?: PromptOrigin): string {
	const safeSender = sanitizeComsName(senderName);
	const safeSelf = sanitizeComsName(selfName);
	const safeCwd = senderCwd.replace(/[\x00-\x1f\x7f-\x9f\[\]]/g, "").trim() || "?";
	// Only a user-authored message gets a marker: peer is the norm and a marker on every
	// inbound would just be noise to read past.
	const originTag = origin === "user" ? " (from the USER)" : "";
	return `from ${safeSender} → ${safeSelf} @ ${safeCwd}${originTag}`;
}

export function buildInboundContent(
	header: string,
	prompt: string,
	tasks?: Array<{ subject: string; description: string }> | null,
	senderName?: string,
	senderCwd?: string,
	origin?: PromptOrigin,
	/** The sender's registry session id — the fallback address when its name cannot be quoted. */
	senderSessionId?: string,
	/** Bundles already sanitize each peer body and retain per-message user labels. */
	bundled = false,
): string {
	// Sanitize peer-controlled values — strip control chars, tag-breaking brackets and the origin
	// marker (#1084), then cap. A name can otherwise close the tag early or pose as the human.
	const cleanTagPart = (value: string) => stripOriginMarker(value).replace(/[\x00-\x1f\x7f[\]]/g, "").trim();
	const safeName = senderName ? cleanTagPart(senderName).slice(0, 100) : undefined;
	const safeCwd = senderCwd ? cleanTagPart(senderCwd).slice(0, 200) : undefined;
	// Machine-readable prefix so the LLM can distinguish coms messages from user input. The
	// origin comes before the name: "a human decided this" is the part that changes the reply.
	const originTag = origin === "user" ? "USER (a human), via " : "";
	const fromTag = safeName ? `[from ${originTag}${safeName}${safeCwd ? ` @ ${safeCwd}` : ''}] ` : '';
	const body = origin === "user" || bundled ? prompt : stripOriginMarker(prompt);
	log.debug("inbound_body_formatted", { origin, bundled });
	let content = header ? `${fromTag}${header}\n\n${body}` : `${fromTag}${body}`;
	if (senderName) {
		// The hint is an ADDRESS: coms_send resolves the RAW registry name, so it stays verbatim —
		// sanitizing it would name a peer that does not exist. Only the displayed tag is sanitized.
		// A name that cannot be quoted safely falls back to the sender's session id.
		const address = [senderName, senderSessionId].find((value) => value && /^[^"\\\r\n\x00-\x1f\x7f-\x9f]+$/.test(value));
		if (address) content += `\n\nReply to me via coms_send(target="${address}")`;
	}
	if (tasks && tasks.length > 0) {
		content += `\n\n## Assigned Tasks\n\nThese tasks have been added to your task list. Work through them in order:\n\n`;
		for (const task of tasks) {
			content += `- **${task.subject}**: ${task.description}\n`;
		}
	}
	return content;
}

export interface TasksSummary {
	total: number;
	completed: number;
	in_progress: number;
}

/** Format the auto-delivered coms response text, including queued message IDs when > 0. */
/** Build the customType string for coms response display (shown as the header by pi). */
export function formatComsResponseType(targetName: string, selfName?: string, queuedMsgIds?: string[]): string {
	const safeTarget = sanitizeComsName(targetName);
	const arrow = selfName ? ` → ${sanitizeComsName(selfName)}` : "";
	const ids = (queuedMsgIds ?? []).length <= 5
		? (queuedMsgIds ?? []).join(", ")
		: `${(queuedMsgIds ?? []).slice(0, 5).join(", ")} and ${(queuedMsgIds ?? []).length - 5} more`;
	const queueNote = (queuedMsgIds ?? []).length > 0 ? ` (${(queuedMsgIds ?? []).length} more queued: ${ids})` : "";
	return `coms response from ${safeTarget}${arrow}${queueNote}`;
}

/** Format the coms response content body (without the header — header is in customType). */
export function formatComsResponseBody(response: any, error: string | null): string {
	if (error !== null && error !== undefined) {
		const errorText = String(error);
		if (errorText.trim().length > 0) return `Error: ${errorText}`;
		log.debug("empty_response_error_ignored", { type: typeof error });
	}
	if (typeof response === "string") {
		if (response.trim().length > 0) return response;
		log.debug("empty_response_body_normalized", { type: "string" });
		return "(no response)";
	}
	if (response === undefined || response === null) return "(no response)";
	let serialized: string;
	try {
		serialized = JSON.stringify(response, null, 2) ?? String(response);
	} catch {
		serialized = String(response);
	}
	if (serialized.trim().length > 0) return serialized;
	log.debug("empty_response_body_normalized", { type: typeof response });
	return "(no response)";
}

/**
 * Format the full auto-delivered coms response text, including queued message IDs.
 * @deprecated Use formatComsResponseType + formatComsResponseBody instead for customType display.
 */
export function formatComsResponseText(targetName: string, response: any, error: string | null, queuedMsgIds: string[], selfName?: string): string {
	const ids = queuedMsgIds.length <= 5 ? queuedMsgIds.join(", ") : `${queuedMsgIds.slice(0, 5).join(", ")} and ${queuedMsgIds.length - 5} more`;
	const queueNote = queuedMsgIds.length > 0 ? ` (${queuedMsgIds.length} more queued: ${ids})` : "";
	const arrow = selfName ? ` → ${selfName}` : "";
	return `[coms response from ${targetName}${arrow}${queueNote}] ${formatComsResponseBody(response, error)}`;
}

/** #968 C: pidash browser peer-list payload — pure projection of live cards. */
export interface ComsPeerCard {
	name: string;
	/** The peer's socket: without it, a vanished peer cannot be told from a live one. */
	endpoint?: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct?: number;
	queue_depth?: number;
	busy?: boolean;
	tasks_summary?: unknown;
	container?: string | null;
	staleCount: number;
}

export function buildComsPeersPayload(
	cards: Iterable<ComsPeerCard>,
	self: { name: string; purpose?: string; project?: string } | null,
): { self: { name: string; purpose: string; project: string } | null; peers: Array<Record<string, unknown>> } {
	const peers: Array<Record<string, unknown>> = [];
	for (const card of cards) {
		peers.push({
			name: card.name,
			purpose: card.purpose,
			model: card.model,
			busy: card.busy ?? false,
			queueDepth: card.queue_depth ?? 0,
			contextUsedPct: card.context_used_pct ?? 0,
			tasksSummary: card.tasks_summary ?? null,
			...(card.container ? { container: card.container } : {}),
		});
	}
	return {
		self: self ? { name: self.name, purpose: self.purpose || "", project: self.project || "" } : null,
		peers,
	};
}

/** Sanitize a coms identity name for safe embedding in header strings.
 *  Strips the origin marker, control characters (C0/C1) and brackets; whitespace → hyphens. */
export function sanitizeComsName(name: string): string {
	return stripOriginMarker(name)
		.replace(/[\x00-\x1f\x7f-\x9f\[\]]/g, "") // strip C0/C1 control chars + brackets
		.trim()
		.replace(/\s+/g, "-")                        // whitespace → hyphens (keep as single token)
		|| "?";
}

/** Return " 📨N" suffix string for queue depth, or "" when zero/absent. */
export function formatQueueStr(queueDepth: number | undefined | null): string {
	return typeof queueDepth === "number" && queueDepth > 0 ? ` 📨${queueDepth}` : "";
}

/** Return theme-colored queue indicator for the coms widget list row. */
export function renderQueuePart(queueDepth: number, theme: any): string {
	return queueDepth > 0 ? theme.fg("dim", " ") + theme.fg("warning", `📨${queueDepth}`) : "";
}

export function renderTasksPart(tasks: TasksSummary | null | undefined, theme: any): string {
	if (!tasks || tasks.total === 0) return "";
	// Clamp to prevent negative/misleading values from corrupt data
	const completed = Math.max(0, Math.min(tasks.completed, tasks.total));
	const in_progress = Math.max(0, Math.min(tasks.in_progress, tasks.total - completed));
	const pending = Math.max(0, tasks.total - completed - in_progress);
	const parts: string[] = [];
	if (completed > 0) parts.push(theme.fg("success", `${completed}✔`));
	if (in_progress > 0) parts.push(theme.fg("accent", `${in_progress}◼`));
	if (pending > 0) parts.push(theme.fg("dim", `${pending}◻`));
	return theme.fg("dim", " ") + parts.join(theme.fg("dim", " "));
}

/** Minimal branch entry shape needed by detectMixedTurn. */
export interface BranchEntry {
	type: string;
	message?: { role: string };
	customType?: string;
	details?: { msg_id?: string };
}

/**
 * Detect whether a user message appeared in the current turn alongside
 * a coms inbound injection — indicating the assistant's response may be
 * directed at the user, not the peer (#731).
 *
 * Walks the branch backwards: skips trailing assistant messages, then
 * checks if a user message appears before reaching the specific coms
 * inbound injection (identified by customType + msg_id).
 *
 * @param branch       The session branch array (oldest → newest).
 * @param inboundMsgId The msg_id of the currently-processing inbound.
 * @param inboundCustomType  The customType of the coms inbound injection
 *                           ("coms-inbound" for p2p).
 * @returns true if a user message was found between the last assistant
 *          message and the coms inbound injection (mixed turn).
 */
export function detectMixedTurn(
	branch: ReadonlyArray<BranchEntry>,
	inboundMsgId: string,
	inboundCustomType: string = COMS_INBOUND_CUSTOM_TYPE,
): boolean {
	let passedAssistant = false;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			passedAssistant = true;
			continue;
		}
		if (!passedAssistant) continue; // still in trailing tool results etc.
		const matchesInbound = entry.customType === inboundCustomType
			|| (inboundCustomType === COMS_INBOUND_CUSTOM_TYPE && isComsInboundCustomType(entry.customType));
		if (entry.type === "custom_message" && matchesInbound
			&& entry.details?.msg_id === inboundMsgId) {
			// Reached the coms inbound injection for this message — no user message in between.
			return false;
		}
		if (entry.type === "message" && entry.message?.role === "user") {
			return true;
		}
	}
	return false;
}

// ── Task store integration (direct import from owned pitasks) ──────────

export interface ComsOrigin {
	sender_session: string;
	sender_name: string;
	sender_endpoint?: string;
}

export interface PeerTaskTarget {
	name?: string;
	cwd?: string;
	coms_session_id?: string;
	pi_session_id?: string;
	task_store_path?: string | null;
}

/**
 * Resolve the exact TaskStore file path a target peer reads.
 * Never falls back to `coms_session_id`: a peer's TaskStore keys session files by `pi_session_id`
 * (or `PI_TASKS` / project scope advertised in `task_store_path`), so guessing from `coms_session_id`
 * writes an orphaned file the peer never sees (#1080).
 */
export function resolvePeerTaskStorePath(target: PeerTaskTarget | null | undefined): string | undefined {
	if (!target) {
		log.debug("peer_task_store_unresolved", { reason: "missing_target" });
		return undefined;
	}
	if (target.task_store_path === null) {
		log.debug("peer_task_store_unresolved", { peer: target.name ?? "?", reason: "peer_tasks_disabled_or_uninitialized" });
		return undefined;
	}
	if (typeof target.task_store_path === "string" && target.task_store_path.trim().length > 0) {
		const trimmed = target.task_store_path.trim();
		if (path.isAbsolute(trimmed) && !/[\x00-\x1f\x7f]/.test(trimmed)) {
			log.debug("peer_task_store_resolved", { peer: target.name ?? "?", source: "registry_task_store_path", storePath: trimmed });
			return trimmed;
		}
		log.warn("peer_task_store_invalid_path", { peer: target.name ?? "?", reason: "non_absolute_or_control_chars" });
		return undefined;
	}
	const piSessionId = typeof target.pi_session_id === "string" ? target.pi_session_id.trim() : "";
	const targetCwd = typeof target.cwd === "string" ? target.cwd.trim() : "";
	if (!piSessionId || !targetCwd) {
		log.debug("peer_task_store_unresolved", {
			peer: target.name ?? "?",
			reason: !piSessionId ? "missing_pi_session_id" : "missing_cwd",
			hasComsSessionId: Boolean(target.coms_session_id),
		});
		return undefined;
	}
	const resolved = resolveStorePath(piSessionId, { cwd: targetCwd, piTasks: undefined, taskScope: "session" });
	log.debug("peer_task_store_resolved", { peer: target.name ?? "?", source: "pi_session_id", storePath: resolved });
	return resolved;
}

/** Max tasks accepted from a single inbound message to prevent abuse. */
const MAX_INBOUND_TASKS = 20;
/** Max length for task subject/description fields. */
const MAX_TASK_FIELD_LEN = 2000;

/**
 * Auto-create tasks on a peer's task store via owned TaskStore API.
 * Runs on the SENDER side — writes into the exact store path the target peer reads.
 */
export async function createComsInboundTasks(
	tasks: Array<{ subject: string; description: string }>,
	origin: ComsOrigin,
	targetSessionId: string,
	targetCwd?: string,
	targetStorePath?: string,
): Promise<number> {
	log.debug("create_coms_inbound_tasks", { targetSessionId, hasStorePath: Boolean(targetStorePath), count: tasks?.length ?? 0 });
	if (!tasks || tasks.length === 0) return 0;

	const storePath = targetStorePath || (
		targetSessionId
			? resolveStorePath(targetSessionId, { cwd: targetCwd, piTasks: undefined, taskScope: "session" })
			: undefined
	);
	if (!storePath) {
		log.debug("create_coms_inbound_tasks_skipped", { reason: "store_path_unresolved", hasSessionId: Boolean(targetSessionId) });
		return 0;
	}

	let createTasksAtStorePath: ((path: string, defs: any[]) => any[]) | undefined;
	try {
		createTasksAtStorePath = (await loadPitasks()).createTasksAtStorePath;
	} catch (error) {
		log.error("create_coms_inbound_tasks_import_failed", { storePath, error: error instanceof Error ? error.message : String(error) });
		return 0;
	}
	if (!createTasksAtStorePath) return 0;

	const defs: Array<{ subject: string; description: string; createdBy: any; metadata?: Record<string, any> }> = [];
	const capped = tasks.slice(0, MAX_INBOUND_TASKS);
	for (const task of capped) {
		const subject = typeof task.subject === "string" ? task.subject.slice(0, MAX_TASK_FIELD_LEN) : "";
		const description = typeof task.description === "string" ? task.description.slice(0, MAX_TASK_FIELD_LEN) : "";
		if (!subject) continue;
		defs.push({
			subject,
			description,
			createdBy: {
				type: "coms" as const,
				origin: origin.sender_name,
				session: origin.sender_session,
				project: "",
			},
			metadata: origin.sender_endpoint ? { sender_endpoint: origin.sender_endpoint } : undefined,
		});
	}
	if (defs.length === 0) return 0;
	try {
		return createTasksAtStorePath(storePath, defs).length;
	} catch (error) {
		log.error("create_coms_inbound_tasks_failed", { storePath, count: defs.length, error: error instanceof Error ? error.message : String(error) });
		return 0;
	}
}

/**
 * Look up a task by ID and return it if created by a coms peer.
 */
export async function getComsOriginTask(
	taskId: string,
): Promise<{ subject: string; createdBy: { session: string; name: string; endpoint?: string } } | null> {
	if (!taskId || taskId === "-1") return null;
	try {
		const { getTask } = await loadPitasks();
		const task = getTask(taskId);
		if (task?.createdBy?.type === "coms") {
			return {
				subject: task.subject,
				createdBy: {
					session: task.createdBy.session,
					name: task.createdBy.origin,
					endpoint: task.metadata?.sender_endpoint,
				},
			};
		}
	} catch { /* ignore */ }
	return null;
}

/**
 * Get all tasks created by coms peers (for keepalive heartbeat).
 */
export async function getComsOriginTasks(): Promise<Array<{ taskId: string; subject: string; status: string; createdBy: { session: string; name: string; endpoint?: string } }>> {
	try {
		const { listTasks } = await loadPitasks();
		const tasks = listTasks();
		return tasks
			.filter((t: any) => t.createdBy?.type === "coms" && t.status !== "deleted")
			.map((t: any) => ({
				taskId: t.id,
				subject: t.subject,
				status: t.status,
				createdBy: {
					session: t.createdBy.session,
					name: t.createdBy.origin,
					endpoint: t.metadata?.sender_endpoint,
				},
			}));
	} catch { return []; }
}

/**
 * Whether a "peer left" notification should evict this peer card.
 *
 * A peer's leaving broadcast is matched by SESSION id, never by name alone. On
 * /reload the outgoing session announces itself gone roughly 200ms AFTER the
 * incoming session has already registered under the same name; matching by name
 * therefore removed the live session and the peer showed as disconnected until
 * something forced it to re-register.
 *
 * `senderSession` is absent only for older peers that predate the field, in which
 * case the name check stands alone as before.
 */
export function shouldEvictOnLeaving(
	cardSession: string,
	cardName: string,
	senderName: string,
	senderSession?: string,
): boolean {
	const nameMatches = cardName === senderName;
	if (!nameMatches) {
		log.debug("peer_leaving_no_name_match", { card: cardName, sender: senderName });
		return false;
	}
	// A sender with no session id predates the field, so the name check stands alone.
	const evict = !senderSession || cardSession === senderSession;
	log.debug("peer_leaving_match", {
		card: cardName,
		cardSession,
		senderSession: senderSession ?? "<none>",
		evict,
	});
	return evict;
}

/**
 * Whether a session is still present in the on-disk coms registry.
 *
 * A peer can reload with a STABLE coms_session_id, so the outgoing session's cleanup
 * unlinks the very registry file the incoming session just re-created. The fs-watch
 * unlink handler therefore re-checks the registry before evicting a card.
 *
 * Matching is on the SESSION id, never the name: two sessions may legitimately share
 * a name, and a name-only check would let the surviving twin keep a card whose own
 * session had genuinely gone.
 */
export function isSessionStillRegistered(
	entries: ReadonlyArray<{ coms_session_id?: string }>,
	sessionId: string,
): boolean {
	const present = entries.some((e) => e.coms_session_id === sessionId);
	log.debug("peer_unlink_registry_check", { session: sessionId, present });
	return present;
}

/**
 * Whether a departing session should produce a user-visible "peer left" notice.
 *
 * Evicting only the departing session is not enough on its own: after a /reload the
 * replacement session may already hold a live card under the same name, and announcing
 * a departure then tells the user — and every browser event consumer — that a peer
 * which is still connected has gone. The registry-removal path applies the same guard.
 */
export function shouldAnnouncePeerLeft(
	cards: Iterable<{ name: string }>,
	departedName: string,
): boolean {
	for (const card of cards) {
		if (card.name === departedName) {
			log.debug("peer_left_announcement_suppressed", { peer: departedName });
			return false;
		}
	}
	return true;
}

// ━━ #924 coms enhancements: pure helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Max mid-turn steer injections per inbound turn (#924 §1). Not a security
 * boundary — coms is a trusted mesh — but a buggy peer loop must not inject
 * unbounded content into one running turn (steers are acked, never responded
 * to, so nothing else backpressures them). Excess steers queue normally.
 */
export const STEER_CAP_PER_TURN = 5;

export interface Prioritizable {
	priority?: boolean;
}

/**
 * Insert an inbound into a FIFO entry list (#924 §4): a priority entry goes
 * ahead of the FIRST non-priority entry (stable among priorities — arrival
 * order preserved). Returns a new array; callers rebuild their ordered map.
 */
export function insertInboundByPriority<T extends Prioritizable>(entries: T[], item: T): T[] {
	if (!item.priority) return [...entries, item];
	const firstNonPriority = entries.findIndex((e) => !e.priority);
	if (firstNonPriority < 0) return [...entries, item];
	return [...entries.slice(0, firstNonPriority), item, ...entries.slice(firstNonPriority)];
}

/**
 * Whether a mid-turn steer is accepted (#924 §1). Over-cap steers fall back
 * to the normal queue path with a warning on the receiver.
 */
export function shouldAcceptSteer(steerCount: number, cap: number = STEER_CAP_PER_TURN): boolean {
	return steerCount < cap;
}

/** Per-target send outcome for coms_broadcast (#924 §2). */
export interface BroadcastTargetResult {
	target: string;
	msg_id?: string;
	hops?: number;
	status: "sent" | "error";
	error?: string;
}

/**
 * Aggregate broadcast results (#924 §2): per-peer lines, partial failures
 * reported individually, never swallowed.
 */
export function summarizeBroadcast(results: BroadcastTargetResult[]): {
	sent: number;
	failed: number;
	text: string;
} {
	const sent = results.filter((r) => r.status === "sent").length;
	const failed = results.length - sent;
	const lines = results.map((r) =>
		r.status === "sent"
			? `✓ ${r.target} — ${r.msg_id ?? "?"}`
			: `✗ ${r.target} — ${r.error ?? "error"}`,
	);
	const text = `coms_broadcast → ${sent}/${results.length} sent\n${lines.join("\n")}`;
	return { sent, failed, text };
}

/**
 * Busy indicator string for peer cards / coms_list rows (#924 §3 presence).
 */
/**
 * #924 §4 + drain bundling: which pending inbounds form the next drain bundle.
 * Starts from the queue head and takes the first sender's messages, but STOPS
 * at a priority entry from another sender — an urgent message must never wait
 * behind the first sender's ordinary traffic. Without the stop, queue order
 * [prio A, prio B, ordinary A] would drain A's whole bundle (ordinary A
 * included) before prio B.
 */
export function selectSenderBundle<T extends { sender_session: string; priority?: boolean }>(allPending: T[]): T[] {
	if (allPending.length === 0) return [];
	const firstSender = allPending[0].sender_session;
	const bundle: T[] = [];
	for (const ib of allPending) {
		if (ib.sender_session === firstSender) { bundle.push(ib); continue; }
		if (ib.priority) break;
	}
	return bundle;
}

export function formatBusyStr(busy: boolean | undefined | null): string {
	return busy ? " ⚙busy" : "";
}

/** Peer cards whose endpoint is gone.
 *
 *  `coms_list` reads a memory cache, so a peer that exited (or was killed) kept being advertised
 *  until some session happened to prune the registry — an agent could then message a corpse.
 *  Returns the ids to drop; the caller deletes them from the cache. */
export function deadPeerCardIds<T extends { endpoint?: string | null }>(
  cards: Map<string, T>,
  exists: (path: string) => boolean,
  platform: string = process.platform,
): string[] {
  if (platform === "win32") return []; // named pipes: fs.existsSync does not apply
  const dead: string[] = [];
  for (const [id, card] of cards) {
    const endpoint = card?.endpoint;
    if (typeof endpoint !== "string" || !endpoint) continue; // no endpoint claim: leave it
    if (!exists(endpoint)) dead.push(id);
  }
  return dead;
}

/** A remote peer may only mutate coms-origin tasks created by its own non-empty session. */
export function isPeerTaskCreator(
  createdBy: { type?: unknown; session?: unknown } | null | undefined,
  senderSession: unknown,
): boolean {
  const hasSender = typeof senderSession === "string" && senderSession.length > 0;
  const allowed = createdBy?.type === "coms" && hasSender && createdBy.session === senderSession;
  log.debug("peer_task_creator_check", {
    allowed,
    originType: typeof createdBy?.type === "string" ? createdBy.type : null,
    hasSender,
  });
  return allowed;
}
