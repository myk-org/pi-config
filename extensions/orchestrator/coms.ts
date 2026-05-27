/**
 * coms.ts — On-demand P2P agent communication wrapper
 *
 * Wraps the upstream coms extension (upstream-coms/coms.ts) to support
 * activation via /coms command instead of auto-start on session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFlags, createDeferredProxy, type DeferredUpstream } from "./coms-shared.js";
import upstreamComsInit from "./upstream-coms/coms.js";

export function registerComs(pi: ExtensionAPI) {
    const state: DeferredUpstream = {
        capturedSessionStart: null,
        capturedSessionShutdown: null,
        flagValues: new Map(),
        active: false,
    };

    const proxyPi = createDeferredProxy(
        pi, state, "⚠️ coms not active. Run `/coms start` first.",
    );

    upstreamComsInit(proxyPi as any);

    pi.registerCommand("coms", {
        description: "P2P agent communication: /coms start [--name X --purpose Y --project Z --color #HEX] | stop | status",
        handler: async (args: string, ctx: any) => {
            const trimmed = (args || "").trim();
            const parts = trimmed.split(/\s+/);
            const subcommand = parts[0] || "status";

            if (subcommand === "start") {
                if (state.active) {
                    try { ctx.ui.notify("📡 coms already active", "warning"); } catch {}
                    return;
                }
                parseFlags(parts.slice(1), state.flagValues);

                if (!state.capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                try {
                    await state.capturedSessionStart({}, ctx);
                    state.active = true;
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms start failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "stop") {
                if (!state.active) {
                    try { ctx.ui.notify("📡 coms not active", "info"); } catch {}
                    return;
                }
                if (state.capturedSessionShutdown) {
                    try { await state.capturedSessionShutdown(); } catch {}
                }
                state.active = false;
                try { ctx.ui.notify("📡 coms stopped", "info"); } catch {}
            } else if (subcommand === "status") {
                try {
                    ctx.ui.notify(state.active ? "📡 coms: active (P2P)" : "📡 coms: inactive — run /coms start", "info");
                } catch {}
            } else {
                try { ctx.ui.notify(`📡 coms: unknown subcommand "${subcommand}". Use: start | stop | status`, "warning"); } catch {}
            }
        },
    });
}
