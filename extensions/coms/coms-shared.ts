/**
 * coms-shared.ts — Shared utilities for coms and coms-net wrappers.
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
    /** Extra persisted state (e.g., serverStartedByUs for coms-net) */
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
                    return () => {};
                case 'registerTool':
                    return (tool: any) => {
                        // Inject anti-loop warning into coms_send description
                        // (upstream coms_net_send has this but coms_send doesn't)
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
 * Call from session_start in both coms.ts and coms-net.ts.
 */
let _pruned = false;
/**
 * Prune stale coms registry entries — non-blocking.
 * Runs once per session (coms + coms-net both call this).
 */
export function pruneStaleRegistry(): void {
    if (_pruned) return;
    _pruned = true;
    // Run async to avoid blocking session_start
    setImmediate(() => {
        try {
            const comsDir = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
            const projectsDir = path.join(comsDir, "projects");
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
                            if (!endpoint) {
                                // No endpoint — old format entry, remove
                                try { fs.unlinkSync(fp); } catch {}
                                continue;
                            }
                            if (!fs.existsSync(endpoint)) {
                                // Socket file gone — definitely dead
                                try { fs.unlinkSync(fp); } catch {}
                                continue;
                            }
                            // Socket exists — try connect to verify
                            const sock = net.createConnection(endpoint);
                            sock.setTimeout(500);
                            sock.on("connect", () => sock.destroy()); // alive
                            sock.on("error", () => {
                                sock.destroy();
                                try { fs.unlinkSync(fp); } catch {}
                                try { fs.unlinkSync(endpoint); } catch {}
                            });
                            sock.on("timeout", () => {
                                sock.destroy();
                                try { fs.unlinkSync(fp); } catch {}
                                try { fs.unlinkSync(endpoint); } catch {}
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
            const socketsDir = path.join(comsDir, "sockets");
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
                        if (!sf.endsWith(".sock")) continue;
                        const sp = path.join(socketsDir, sf);
                        if (!allEndpoints.has(sp)) {
                            try { fs.unlinkSync(sp); } catch {}
                        }
                    }
                } catch {}
            }
        } catch (e: any) { console.debug("[coms] async prune failed:", e?.message?.slice(0, 100)); }
    });
}
