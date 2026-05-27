/**
 * coms-net.ts — On-demand networked agent communication wrapper
 *
 * Wraps the upstream coms-net extension (upstream-coms/coms-net.ts) to support
 * activation via /coms-net command instead of auto-start on session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import upstreamComsNetInit from "./upstream-coms/coms-net.js";

export function registerComsNet(pi: ExtensionAPI) {
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
                    return () => {};
                case 'getFlag':
                    return (name: string) => flagValues.get(name);
                case 'registerCommand':
                    return () => {};
                case 'registerTool':
                    return (tool: any) => {
                        const origExecute = tool.execute;
                        tool.execute = async (callId: string, params: any) => {
                            if (!active) {
                                return {
                                    content: [{ type: "text" as const, text: "⚠️ coms-net not active. Run `/coms-net start` first." }],
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
                            return;
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
    });

    upstreamComsNetInit(proxyPi as any);

    pi.registerCommand("coms-net", {
        description: "Networked agent communication: /coms-net start [--name X --purpose Y --project Z --color #HEX --server-url URL --auth-token TOKEN] | stop | status",
        handler: async (args: string, ctx: any) => {
            const trimmed = (args || "").trim();
            const parts = trimmed.split(/\s+/);
            const subcommand = parts[0] || "status";

            if (subcommand === "start") {
                if (active) {
                    try { ctx.ui.notify("📡 coms-net already active", "warning"); } catch {}
                    return;
                }
                parseFlags(parts.slice(1), flagValues);

                if (!capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms-net: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                try {
                    await capturedSessionStart({}, ctx);
                    active = true;
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms-net start failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "stop") {
                if (!active) {
                    try { ctx.ui.notify("📡 coms-net not active", "info"); } catch {}
                    return;
                }
                try { ctx.ui.notify("📡 coms-net will stop when the session ends", "info"); } catch {}
            } else if (subcommand === "status") {
                try {
                    ctx.ui.notify(active ? "📡 coms-net: active (networked)" : "📡 coms-net: inactive — run /coms-net start", "info");
                } catch {}
            } else {
                try { ctx.ui.notify(`📡 coms-net: unknown subcommand "${subcommand}". Use: start | stop | status`, "warning"); } catch {}
            }
        },
    });
}

function parseFlags(parts: string[], values: Map<string, any>): void {
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
