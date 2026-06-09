/**
 * coms-wrapper.ts — On-demand P2P agent communication wrapper
 *
 * Wraps the P2P coms extension (coms-p2p.ts) to support
 * activation via /coms command instead of auto-start on session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { parseFlags, tokenizeArgs, createDeferredProxy, persistState, pruneStaleRegistry, type DeferredUpstream } from "./coms-shared.js";
import upstreamComsInit from "./coms-p2p.js";

function fuzzy(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
    if (!query.trim()) return items.length > 0 ? items : null;
    const result = fuzzyFilter(items, query, i => `${i.label} ${i.description || ""}`);
    return result.length > 0 ? result : null;
}

export function registerComs(pi: ExtensionAPI) {
    const state: DeferredUpstream = {
        capturedSessionStart: null,
        capturedSessionShutdown: null,
        flagValues: new Map(),
        active: false,
    };

    const PERSIST_KEY = "coms-state";

    const proxyPi = createDeferredProxy(
        pi, state, "⚠️ coms not active. Run `/coms start` first.", PERSIST_KEY,
    );

    upstreamComsInit(proxyPi as any);

    // Prune stale registry entries on session start (cleans up after crashes)
    // Also reset coms state on fresh starts (non-reload) to clear phantom peers
    pi.on("session_start", (evt: any) => {
        try { pruneStaleRegistry(); } catch (e: any) { console.debug("[coms] stale cleanup:", e?.message?.slice(0, 100)); }
        if (evt?.reason !== "reload") {
            state.active = false;
            persistState(pi, PERSIST_KEY, state);
        }
    });

    pi.registerCommand("coms", {
        description: "P2P agent communication: /coms start | stop | status",
        getArgumentCompletions: (prefix: string) => {
            // Parse: split on whitespace, trailing space means "next token position"
            const tokens = prefix.trim().split(/\s+/).filter(Boolean);
            const atNextToken = prefix.endsWith(" ") || tokens.length === 0;
            const lastPart = atNextToken ? "" : tokens[tokens.length - 1];
            const completed = atNextToken ? tokens : tokens.slice(0, -1);
            const base = atNextToken ? prefix : prefix.slice(0, prefix.length - lastPart.length);
            const mk = (items: {v: string; l: string; d: string}[]) =>
                fuzzy(items.map(i => ({ value: base + i.v, label: i.l, description: i.d })), lastPart);

            if (completed.length === 0) {
                return mk([
                    { v: "start", l: "start", d: "Start P2P agent communication" },
                    { v: "stop", l: "stop", d: "Stop coms" },
                    { v: "status", l: "status", d: "Show coms status" },
                ]);
            }
            if (completed[0] === "start" && (lastPart.startsWith("-") || lastPart === "")) {
                const used = new Set(completed.filter(p => p.startsWith("--")));
                return mk([
                    { v: "--cname ", l: "--cname", d: "Agent name" },
                    { v: "--purpose ", l: "--purpose", d: "Agent purpose" },
                    { v: "--project ", l: "--project", d: "Project namespace" },
                    { v: "--color ", l: "--color", d: "Hex color #RRGGBB" },
                    { v: "--explicit", l: "--explicit", d: "Hide from auto-discovery" },
                ].filter(f => !used.has(f.v.trim())));
            }
            return null;
        },
        handler: async (args: string, ctx: any) => {
            const trimmed = (args || "").trim();
            const parts = tokenizeArgs(trimmed);
            const subcommand = parts[0] || "status";

            if (subcommand === "start") {
                if (state.active) {
                    try { ctx.ui.notify("📡 coms already active", "warning"); } catch {}
                    return;
                }
                state.flagValues = new Map();
                parseFlags(parts.slice(1), state.flagValues);

                // Default project to cwd so sessions in different dirs are isolated
                if (!state.flagValues.has("project")) {
                    const cwd = ctx.cwd || "";
                    const proj = cwd.replace(/^[\\/]/,"").replace(/[\\/]/g, "__");
                    if (!proj) {
                        try { ctx.ui.notify("📡 coms: cannot start from /. Run from a project directory.", "error"); } catch {}
                        return;
                    }
                    state.flagValues.set("project", proj);
                }

                if (!state.capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                try {
                    await state.capturedSessionStart({}, ctx);
                    state.active = true;
                    persistState(pi, PERSIST_KEY, state);
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
                persistState(pi, PERSIST_KEY, state);
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
