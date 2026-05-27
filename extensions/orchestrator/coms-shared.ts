/**
 * coms-shared.ts — Shared utilities for coms and coms-net wrappers.
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
 *
 * Intercepts:
 * - registerFlag → no-op (we parse args from slash command)
 * - getFlag → returns from flagValues map
 * - registerCommand → no-op (we register our own)
 * - registerTool → wraps execute with activation guard
 * - on("session_start") → captures handler instead of registering
 * - on("session_shutdown") → captures handler AND passes through
 * - everything else → pass through to real pi
 */
export function createDeferredProxy(
    pi: ExtensionAPI,
    state: DeferredUpstream,
    inactiveMessage: string,
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
                            return;
                        }
                        if (event === 'session_shutdown') {
                            state.capturedSessionShutdown = handler;
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
