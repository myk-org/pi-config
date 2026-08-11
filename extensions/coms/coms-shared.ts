/**
 * coms-shared.ts — Shared utilities for coms wrapper.
 *
 * Handles reload resilience: when coms is active and the user runs /reload,
 * session_shutdown fires (upstream cleans up the old socket/connection),
 * then session_start fires with reason="reload". We detect this and
 * auto-reactivate with the same flags.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

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

export interface DeferredUpstream {
    /** Captured session_start handler from upstream */
    capturedSessionStart: ((event: any, ctx: any) => Promise<void>) | null;
    /** Captured session_shutdown handler from upstream */
    capturedSessionShutdown: (() => Promise<void>) | null;
    /** Flag values for upstream's getFlag calls */
    flagValues: Map<string, any>;
    /** Whether the upstream extension is active */
    active: boolean;
    /** Extra persisted state */
    extra?: Record<string, any>;
}

/**
 * Create a Proxy around the pi API that defers upstream extension activation.
 * On reload, session_shutdown passes through (upstream cleans up), then
 * session_start auto-reactivates if the persist key exists.
 */
export function createDeferredProxy(
    pi: ExtensionAPI,
    state: DeferredUpstream,
    inactiveMessage: string,
    persistKey: string,
): ExtensionAPI {
    return new Proxy(pi, {
        get(target: any, prop: string | symbol) {
            if (typeof prop === 'symbol') {
                const val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
            }

            switch (prop) {
                case 'registerFlag':
                    return () => {};
                case 'getFlag':
                    return (name: string) => state.flagValues.get(name);
                case 'registerCommand':
                    // Upstream /coms is owned by the wrapper — swallow it.
                    // Pass through utility commands (e.g. /coms-queue) so they
                    // are always available on the real pi, with an active-gate in the handler.
                    return (name: string, def: any) => {
                        if (name === 'coms') return;
                        const origHandler = def?.handler;
                        if (typeof origHandler === 'function') {
                            def.handler = async (args: string, ctx: any) => {
                                if (!state.active) {
                                    try {
                                        ctx.ui.notify(
                                            name.includes('net')
                                                ? '📡 coms not active — no queue. Run /coms start first.'
                                                : '📡 coms not active — no queue. Run /coms start first.',
                                            'info',
                                        );
                                    } catch { /* ignore */ }
                                    return;
                                }
                                return origHandler(args, ctx);
                            };
                        }
                        return target.registerCommand(name, def);
                    };
                case 'registerTool':
                    return (tool: any) => {
                        // Inject anti-loop warning into coms_send description
                        if (tool.name === "coms_send" && tool.description && !tool.description.includes("DO NOT")) {
                            tool.description +=
                                "\n\n\u26a0\ufe0f  DO NOT call this tool to REPLY to an inbound message. " +
                                "When you receive a `[from <peer>] \u2026` follow-up, just write your answer as your normal assistant message \u2014 " +
                                "the coms extension automatically captures the final assistant text at the end of your turn and " +
                                "submits it back to the original caller. Calling coms_send in response creates a new outbound message, not a reply.";
                        }
                        const origExecute = tool.execute;
                        tool.execute = async (callId: string, params: any, signal?: AbortSignal, ...rest: any[]) => {
                            if (!state.active) {
                                return {
                                    content: [{ type: "text" as const, text: inactiveMessage }],
                                };
                            }
                            // For *_await tools: wrap with abort signal support
                            // so ESC can interrupt the blocking wait
                            if (tool.name?.endsWith("_await") && signal) {
                                return Promise.race([
                                    origExecute(callId, params, signal, ...rest),
                                    new Promise<any>((_, reject) => {
                                        if (signal.aborted) reject(new Error("aborted"));
                                        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                                    }),
                                ]).catch((err) => ({
                                    content: [{ type: "text" as const, text: `⚠️ ${tool.name} interrupted: ${err.message}` }],
                                }));
                            }
                            return origExecute(callId, params, signal, ...rest);
                        };
                        return target.registerTool(tool);
                    };
                case 'on':
                    return (event: string, handler: any) => {
                        if (event === 'session_start') {
                            state.capturedSessionStart = handler;
                            // Register with real pi to auto-reactivate on reload
                            return target.on(event, async (evt: any, ctx: any) => {
                                if (evt?.reason !== "reload") return;
                                // Check if coms was active before reload
                                let wasActive = false;
                                let savedFlags: Record<string, any> = {};
                                let savedExtra: Record<string, any> = {};
                                for (const entry of ctx.sessionManager.getEntries()) {
                                    if (entry.type === "custom" && entry.customType === persistKey) {
                                        wasActive = entry.data?.active === true;
                                        savedFlags = entry.data?.flags || {};
                                        savedExtra = entry.data?.extra || {};
                                    }
                                }
                                if (wasActive) {
                                    state.flagValues = new Map(Object.entries(savedFlags));
                                    state.extra = savedExtra;
                                    try {
                                        await handler(evt, ctx);
                                        state.active = true;
                                    } catch (err) {
                                        console.error(`[coms] reload reactivation failed:`, err);
                                    }
                                }
                            });
                        }
                        if (event === 'session_shutdown') {
                            state.capturedSessionShutdown = handler;
                            // Pass through — upstream needs to clean up socket/connection
                            return target.on(event, handler);
                        }
                        return target.on(event, handler);
                    };
                default: {
                    const val = target[prop];
                    if (typeof val === 'function') {
                        return val.bind(target);
                    }
                    return val;
                }
            }
        }
    }) as ExtensionAPI;
}

/**
 * Persist coms activation state so it survives reload.
 */
export function persistState(pi: ExtensionAPI, persistKey: string, state: DeferredUpstream): void {
    try {
        const flags: Record<string, any> = {};
        for (const [k, v] of state.flagValues) flags[k] = v;
        pi.appendEntry(persistKey, { active: state.active, flags, extra: state.extra || {} });
    } catch (e: any) { console.debug("[coms-shared] persist state failed:", e?.message || e); }
}

/**
 * Prune stale coms registry entries on startup — removes entries with dead PIDs.
 * Call from session_start in coms.ts.
 */
let _pruned = false;
/**
 * Prune stale coms registry entries — non-blocking.
 * Runs once per session.
 */
export function pruneStaleRegistry(comsDir?: string): void {
    if (_pruned) return;
    _pruned = true;
    const resolvedComsDir = comsDir || path.join(os.homedir(), ".pi", "coms");
    // Run async to avoid blocking session_start
    setImmediate(() => {
        try {
            const projectsDir = path.join(resolvedComsDir, "projects");
            if (!fs.existsSync(projectsDir)) return;
            let dirs: string[];
            try { dirs = fs.readdirSync(projectsDir); } catch { return; }
            for (const proj of dirs) {
                try {
                    const projDir = path.join(projectsDir, proj);
                    if (!fs.lstatSync(projDir).isDirectory()) continue;
                    const agentsDir = path.join(projDir, "agents");
                    if (!fs.existsSync(agentsDir)) continue;
                    for (const file of fs.readdirSync(agentsDir)) {
                        if (!file.endsWith(".json")) continue;
                        const fp = path.join(agentsDir, file);
                        try {
                            const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
                            if (typeof data?.pid !== "number") {
                                try { fs.unlinkSync(fp); } catch {}
                                continue;
                            }
                            // Check socket endpoint — reliable in containers (pid reuse)
                            const endpoint = data?.endpoint;
                            if (typeof endpoint !== "string" || !endpoint) {
                                // No/invalid endpoint — old format entry, remove
                                try { fs.unlinkSync(fp); } catch {}
                                continue;
                            }
                            if (!fs.existsSync(endpoint)) {
                                // Socket file gone — definitely dead
                                try { fs.unlinkSync(fp); } catch {}
                                continue;
                            }
                            // Socket exists — try connect to verify.
                            // Prefer the ping endpoint (.ping) which runs on a separate
                            // thread and is immune to main-thread event-loop blocks.
                            // Probe liveness via .ping endpoint (immune to main-thread blocks).
                            const pingEndpoint = `${endpoint}.ping`;
                            const sock = net.createConnection(pingEndpoint);
                            sock.setTimeout(500);
                            sock.on("connect", () => sock.destroy()); // alive
                            sock.on("error", (err: any) => {
                                sock.destroy();
                                // Only prune registry on definitive dead signals.
                                // Never delete socket files — that's destructive and
                                // irreversible, killing live peers whose ping worker
                                // may have crashed while the main server is still alive.
                                if (err?.code === "ECONNREFUSED" || err?.code === "ENOENT") {
                                    try { fs.unlinkSync(fp); } catch {}
                                }
                            });
                            sock.on("timeout", () => {
                                sock.destroy();
                                // Timeout means peer may be busy — only remove registry
                                // entry, NOT the socket file. The peer's keepalive can
                                // self-heal the registry, but a deleted socket file is
                                // permanent and kills the peer's connectivity.
                                try { fs.unlinkSync(fp); } catch {}
                                // Do NOT unlink endpoint or endpoint.ping on timeout
                            });
                        } catch (e: any) {
                            if (e?.code === "ESRCH" || e instanceof SyntaxError) {
                                try { fs.unlinkSync(fp); } catch {}
                            }
                        }
                    }
                } catch { /* skip unreadable project directory */ }
            }
            // Cleanup orphan sockets (no matching registry entry)
            const socketsDir = path.join(resolvedComsDir, "sockets");
            if (fs.existsSync(socketsDir)) {
                try {
                    const allEndpoints = new Set<string>();
                    // Collect all endpoints from remaining registry entries
                    for (const p of dirs) {
                        try {
                            const pd = path.join(projectsDir, p);
                            if (!fs.lstatSync(pd).isDirectory()) continue;
                            const ad = path.join(pd, "agents");
                            if (!fs.existsSync(ad)) continue;
                            for (const f of fs.readdirSync(ad)) {
                                if (!f.endsWith(".json")) continue;
                                try {
                                    const d = JSON.parse(fs.readFileSync(path.join(ad, f), "utf-8"));
                                    if (d?.endpoint) allEndpoints.add(d.endpoint);
                                } catch {}
                            }
                        } catch {}
                    }
                    // Remove sockets with no registry entry
                    for (const sf of fs.readdirSync(socketsDir)) {
                        if (!sf.endsWith(".sock") && !sf.endsWith(".sock.ping")) continue;
                        const sp = path.join(socketsDir, sf);
                        // For .ping files, check if the parent .sock is in the endpoint set
                        const parentEndpoint = sf.endsWith(".sock.ping") ? sp.slice(0, -5) : sp;
                        if (!allEndpoints.has(parentEndpoint)) {
                            try { fs.unlinkSync(sp); } catch {}
                        }
                    }
                } catch {}
            }
        } catch (e: any) { console.debug("[coms] async prune failed:", e?.message?.slice(0, 100)); }
    });
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

export function readTaskSummary(_cwd: string, _sessionId?: string): { total: number; completed: number; in_progress: number } | null {
	try {
		const { listTasks } = require("../pitasks/index.js");
		const tasks = listTasks();
		if (!tasks || tasks.length === 0) return null;
		let total = 0, completed = 0, in_progress = 0;
		for (const t of tasks) {
			total++;
			if (t.status === "completed") completed++;
			else if (t.status === "in_progress") in_progress++;
		}
		return { total, completed, in_progress };
	} catch { return null; }
}

/** Build the customType string for coms inbound display (shown as the header by pi).
 *  Sanitizes all inputs since senderName/senderCwd come from untrusted peers. */
export function formatComsInboundType(senderName: string, selfName: string, senderCwd: string): string {
	const safeSender = sanitizeComsName(senderName);
	const safeSelf = sanitizeComsName(selfName);
	const safeCwd = senderCwd.replace(/[\x00-\x1f\x7f-\x9f\[\]]/g, "").trim() || "?";
	return `from ${safeSender} → ${safeSelf} @ ${safeCwd}`;
}

export function buildInboundContent(
	header: string,
	prompt: string,
	tasks?: Array<{ subject: string; description: string }> | null,
	senderName?: string,
	senderCwd?: string,
): string {
	// Sanitize peer-controlled values — strip control chars and limit length
	const safeName = senderName ? senderName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : undefined;
	const safeCwd = senderCwd ? senderCwd.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : undefined;
	// Machine-readable prefix so the LLM can distinguish coms messages from user input
	const fromTag = safeName ? `[from ${safeName}${safeCwd ? ` @ ${safeCwd}` : ''}] ` : '';
	let content = header ? `${fromTag}${header}\n\n${prompt}` : `${fromTag}${prompt}`;
	if (safeName) {
		content += `\n\nReply to me via coms_send(target="${safeName}")`;
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
	if (error) return `Error: ${error}`;
	if (typeof response === "string") return response;
	if (response === undefined || response === null) return "(no response)";
	return JSON.stringify(response, null, 2) ?? String(response);
}

/**
 * Format the full auto-delivered coms response text, including queued message IDs.
 * @deprecated Use formatComsResponseType + formatComsResponseBody instead for customType display.
 */
export function formatComsResponseText(targetName: string, response: any, error: string | null, queuedMsgIds: string[], selfName?: string): string {
	const ids = queuedMsgIds.length <= 5 ? queuedMsgIds.join(", ") : `${queuedMsgIds.slice(0, 5).join(", ")} and ${queuedMsgIds.length - 5} more`;
	const queueNote = queuedMsgIds.length > 0 ? ` (${queuedMsgIds.length} more queued: ${ids})` : "";
	const arrow = selfName ? ` → ${selfName}` : "";
	if (error) return `[coms response from ${targetName}${arrow}${queueNote}] Error: ${error}`;
	return typeof response === "string"
		? `[coms response from ${targetName}${arrow}${queueNote}] ${response}`
		: `[coms response from ${targetName}${arrow}${queueNote}] ${JSON.stringify(response, null, 2)}`;
}

/** Sanitize a coms identity name for safe embedding in header strings.
 *  Strips all control characters (C0/C1), brackets; replaces whitespace with hyphens. */
export function sanitizeComsName(name: string): string {
	return name
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
	inboundCustomType: string,
): boolean {
	let passedAssistant = false;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			passedAssistant = true;
			continue;
		}
		if (!passedAssistant) continue; // still in trailing tool results etc.
		if (entry.type === "custom_message" && entry.customType === inboundCustomType
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

/** Max tasks accepted from a single inbound message to prevent abuse. */
const MAX_INBOUND_TASKS = 20;
/** Max length for task subject/description fields. */
const MAX_TASK_FIELD_LEN = 2000;

/**
 * Auto-create tasks on a peer's task store via owned TaskStore API.
 * Runs on the SENDER side — uses createTaskForSession with the target's session ID.
 * TaskStore handles locking, file format, everything.
 */
export function createComsInboundTasks(
	tasks: Array<{ subject: string; description: string }>,
	origin: ComsOrigin,
	targetSessionId: string,
	targetCwd?: string,
): number {
	if (!tasks || tasks.length === 0 || !targetSessionId) return 0;

	let createTaskForSession: any;
	try {
		createTaskForSession = require("../pitasks/index.js").createTaskForSession;
	} catch { return 0; }
	if (!createTaskForSession) return 0;

	let created = 0;
	const capped = tasks.slice(0, MAX_INBOUND_TASKS);
	for (const task of capped) {
		const subject = typeof task.subject === "string" ? task.subject.slice(0, MAX_TASK_FIELD_LEN) : "";
		const description = typeof task.description === "string" ? task.description.slice(0, MAX_TASK_FIELD_LEN) : "";
		if (!subject) continue;
		try {
			const createdBy = {
				type: "coms" as const,
				origin: origin.sender_name,
				session: origin.sender_session,
				project: "",
			};
			const meta = origin.sender_endpoint ? { sender_endpoint: origin.sender_endpoint } : undefined;
			createTaskForSession(targetSessionId, subject, description, createdBy, meta, targetCwd);
			created++;
		} catch { /* best-effort */ }
	}
	return created;
}

/**
 * Look up a task by ID and return it if created by a coms peer.
 */
export async function getComsOriginTask(
	taskId: string,
): Promise<{ subject: string; createdBy: { session: string; name: string; endpoint?: string } } | null> {
	if (!taskId || taskId === "-1") return null;
	try {
		const { getTask } = await import("../pitasks/index.js");
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
		const { listTasks } = await import("../pitasks/index.js");
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
