/**
 * coms.ts — On-demand P2P agent communication wrapper
 *
 * Wraps the upstream coms extension (upstream-coms/coms.ts) to support
 * activation via /coms command instead of auto-start on session_start.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// NOTE: import the upstream default export. Use .js extension for our compiled context.
// The upstream file is at ./upstream-coms/coms.ts and exports default function(pi).
import upstreamComsInit from "./upstream-coms/coms.js";

export function registerComs(pi: ExtensionAPI) {
    let active = false;
    let capturedSessionStart: ((event: any, ctx: any) => Promise<void>) | null = null;
    const flagValues = new Map<string, any>();

    const proxyPi = new Proxy(pi, {
        get(target: any, prop: string | symbol) {
            if (typeof prop === 'symbol') {
                const val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
            }

            switch (prop) {
                case 'registerFlag':
                    return () => {}; // no-op
                case 'getFlag':
                    return (name: string) => flagValues.get(name);
                case 'registerCommand':
                    return () => {}; // we register our own
                case 'registerTool':
                    return (tool: any) => {
                        const origExecute = tool.execute;
                        tool.execute = async (callId: string, params: any) => {
                            if (!active) {
                                return {
                                    content: [{ type: "text" as const, text: "⚠️ coms not active. Run `/coms start` first." }],
                                };
                            }
                            return origExecute(callId, params);
                        };
                        return target.registerTool(tool);
                    };
                case 'on':
                    return (event: string, handler: any) => {
                        if (event === 'session_start') {
                            capturedSessionStart = handler;
                            return; // capture, don't register
                        }
                        // agent_end, session_shutdown etc — pass through
                        // They check internal state (identity) and no-op when inactive
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
    });

    // Initialize upstream — registers tools (guarded), captures session_start handler,
    // registers agent_end + session_shutdown with real pi
    upstreamComsInit(proxyPi as any);

    // Register /coms command
    pi.registerCommand("coms", {
        description: "P2P agent communication: /coms start [--name X --purpose Y --project Z --color #HEX] | stop | status",
        handler: async (args: string, ctx: any) => {
            const trimmed = (args || "").trim();
            const parts = trimmed.split(/\s+/);
            const subcommand = parts[0] || "status";

            if (subcommand === "start") {
                if (active) {
                    try { ctx.ui.notify("📡 coms already active", "warning"); } catch {}
                    return;
                }
                // Parse --key value pairs into flagValues
                parseFlags(parts.slice(1), flagValues);

                if (!capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                try {
                    await capturedSessionStart({}, ctx);
                    active = true;
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms start failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "stop") {
                if (!active) {
                    try { ctx.ui.notify("📡 coms not active", "info"); } catch {}
                    return;
                }
                try { ctx.ui.notify("📡 coms will stop when the session ends", "info"); } catch {}
            } else if (subcommand === "status") {
                try {
                    ctx.ui.notify(active ? "📡 coms: active (P2P)" : "📡 coms: inactive — run /coms start", "info");
                } catch {}
            } else {
                try { ctx.ui.notify(`📡 coms: unknown subcommand "${subcommand}". Use: start | stop | status`, "warning"); } catch {}
            }
        },
    });
}

function parseFlags(parts: string[], values: Map<string, any>): void {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.startsWith("--") && i + 1 < parts.length) {
            const key = part.slice(2);
            // --explicit is a boolean flag (no value)
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
