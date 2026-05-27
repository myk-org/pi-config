/**
 * coms-shared.ts — Shared utilities for coms and coms-net wrappers.
 *
 * Handles reload resilience: when coms is active and the user runs /reload,
 * session_shutdown fires (upstream cleans up the old socket/connection),
 * then session_start fires with reason="reload". We detect this and
 * auto-reactivate with the same flags.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Parse --key value pairs from command arguments into a Map.
 * Boolean flags (like --explicit) are set to true without consuming the next token.
 */
export function parseFlags(parts: string[], values: Map<string, any>): void {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.startsWith("--") && i + 1 < parts.length) {
            const key = part.slice(2);
            if (key === "explicit") {
                values.set(key, true);
                continue;
            }
            const val = parts[i + 1];
            if (val && !val.startsWith("--")) {
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
                        const origExecute = tool.execute;
                        tool.execute = async (callId: string, params: any) => {
                            if (!state.active) {
                                return {
                                    content: [{ type: "text" as const, text: inactiveMessage }],
                                };
                            }
                            return origExecute(callId, params);
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
                                for (const entry of ctx.sessionManager.getEntries()) {
                                    if (entry.type === "custom" && entry.customType === persistKey) {
                                        wasActive = entry.data?.active === true;
                                        savedFlags = entry.data?.flags || {};
                                    }
                                }
                                if (wasActive) {
                                    state.flagValues = new Map(Object.entries(savedFlags));
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
        pi.appendEntry(persistKey, { active: state.active, flags });
    } catch {}
}
