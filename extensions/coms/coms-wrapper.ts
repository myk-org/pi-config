/**
 * coms-wrapper.ts — On-demand P2P agent communication wrapper
 *
 * Wraps the P2P coms extension (coms-p2p.ts) to support
 * activation via /coms command instead of auto-start on session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as os from "node:os";
import { parseFlags, tokenizeArgs, createDeferredProxy, persistState, pruneStaleRegistry, type DeferredUpstream } from "./coms-shared.js";
import upstreamComsInit from "./coms-p2p.js";
import { getSetting } from "../orchestrator/project-settings.js";
import { setComsActive } from "../shared/coms-active.js";
import { createLogger } from "../shared/logger.js";
import { Type } from "typebox";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { filterRegistry, formatPeerTable, isFreshHeartbeat, selectKillTargets, supervisedPeerKeys, type RegistryRow } from "./coms-peers.js";
import { openComsPeersOverlay } from "./coms-peers-ui.js";

const log = createLogger("coms");

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
    let liveCtx: any = null;

    pi.on("session_start", async (evt: any, ctx: any) => {
        liveCtx = ctx;
        try {
            const cwd = ctx?.cwd || process.cwd();
            const comsDir = getSetting(cwd, "coms_dir") || path.join(os.homedir(), ".pi", "coms");
            pruneStaleRegistry(comsDir);
        } catch (e: any) {
            const err = e instanceof Error ? e : new Error(String(e?.message ?? e));
            log.warn("stale cleanup failed", err.message?.slice(0, 100), err);
        }
        if (evt?.reason !== "reload") {
            state.active = false;
            setComsActive(false);
            persistState(pi, PERSIST_KEY, state);
        }
        // `pi --coms …`: a headless peer boots itself, no slash command and no terminal.
        if (evt?.reason !== "reload" && pi.getFlag("coms") === true) {
            const parts = ["start"];
            for (const flagName of ["cname", "purpose", "project", "color"] as const) {
                const value = pi.getFlag(flagName);
                if (typeof value === "string" && value) parts.push(`--${flagName}`, value);
            }
            if (pi.getFlag("explicit") === true) parts.push("--explicit");
            log.info("coms autostart from --coms", { args: parts.join(" ") });
            await comsCmdHandler(parts.join(" "), ctx);
        }
    });

    // Activation flag: `pi --coms --cname x --project y` starts the peer at session start, so a
    // spawned pi can be given its identity without a human typing /coms start into a terminal.
    try {
        pi.registerFlag("coms", {
            description: "Start coms P2P automatically at session start (use --cname/--project for identity)",
            type: "boolean",
            default: false,
        });
    } catch (e: any) {
        log.warn("registering --coms flag failed", e?.message ?? String(e));
    }

    /** Activate coms for THIS session — the one path used by `/coms start`, `pi --coms …` and the
     *  `coms_start` tool. A tool is how an already-open session (or an agent) enables coms without a
     *  slash command and without spawning a new pi. */
    const activateComs = async (flagParts: string[], ctx: any): Promise<{ ok: boolean; message: string }> => {
        if (state.active) return { ok: true, message: "📡 coms already active" };
        state.flagValues = new Map();
        parseFlags(flagParts, state.flagValues);
        if (state.flagValues.has("name")) {
            return { ok: false, message: "📡 coms: use --cname instead of --name" };
        }
        if (!state.flagValues.has("project")) {
            const cwd = ctx?.cwd || "";
            const proj = cwd.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
            if (!proj) return { ok: false, message: "📡 coms: cannot start from /. Run from a project directory." };
            state.flagValues.set("project", proj);
        }
        if (!state.capturedSessionStart) {
            return { ok: false, message: "📡 coms: internal error — no session handler captured" };
        }
        try {
            await state.capturedSessionStart({}, ctx);
            state.active = true;
            setComsActive(true);
            persistState(pi, PERSIST_KEY, state);
            const name = String(state.flagValues.get("cname") ?? state.flagValues.get("name") ?? "peer");
            const project = String(state.flagValues.get("project"));
            log.info("coms activated", { name, project, via: "tool-or-command" });
            return { ok: true, message: `📡 coms active — you are "${name}" on project "${project}". Peers: use coms_list.` };
        } catch (err: any) {
            setComsActive(false);
            const msg = err?.message ?? String(err);
            log.error("coms activation failed", msg, err instanceof Error ? err : new Error(msg));
            return { ok: false, message: `📡 coms start failed: ${msg}` };
        }
    };

    const comsCmdHandler = async (args: string, ctx: any) => {
        const trimmed = (args || "").trim();
        const parts = tokenizeArgs(trimmed);
        const subcommand = parts[0] || "status";

        if (subcommand === "start") {
            const result = await activateComs(parts.slice(1), ctx);
            try { ctx.ui.notify(result.message, result.ok ? "info" : "error"); } catch {}
            return;
        }
        if (subcommand === "stop") {
            if (!state.active) {
                try { ctx.ui.notify("📡 coms not active", "info"); } catch {}
                return;
            }
            if (state.capturedSessionShutdown) {
                try {
                    await state.capturedSessionShutdown();
                } catch (err: any) {
                    const msg = err?.message ?? String(err);
                    const error = err instanceof Error ? err : new Error(msg);
                    log.warn("/coms stop: session shutdown threw", msg, error);
                }
            }
            state.active = false;
            setComsActive(false);
            persistState(pi, PERSIST_KEY, state);
            try { ctx.ui.notify("📡 coms stopped", "info"); } catch {}
        } else if (subcommand === "list" || subcommand === "peers") {
            // Same interaction as /async-status: navigate, x kills the focused peer, X kills all.
            const projectFlag = parts[parts.indexOf("--project") + 1];
            const projectFilter = parts.includes("--project") ? projectFlag : undefined;
            if (ctx?.hasUI) {
                await openComsPeersOverlay(ctx, {
                    listPeers: () => filterRegistry(readRegistryRows().filter(rowAlive), { project: projectFilter }),
                    killPeer: (row) => killPeers({ name: row.name, project: row.project }).text,
                    killAll: () => killPeers({ all: true }).text,
                });
                return;
            }
            try { ctx.ui.notify(listPeers({ project: projectFilter }), "info"); } catch {}
        } else if (subcommand === "kill") {
            const what = (parts[1] ?? "").trim();
            const projectIdx = parts.indexOf("--project");
            if (!what) {
                try { ctx.ui.notify("Usage: /coms kill <peer-name|all> [--project <p>]", "warning"); } catch {}
                return;
            }
            const result = killPeers({ name: what === "all" ? undefined : what, project: projectIdx >= 0 ? parts[projectIdx + 1] : undefined, all: what === "all" });
            try { ctx.ui.notify(result.text, result.killed > 0 ? "info" : "warning"); } catch {}
        } else if (subcommand === "status") {
            try {
                ctx.ui.notify(state.active ? "📡 coms: active (P2P)" : "📡 coms: inactive — run /coms start", "info");
            } catch {}
        } else {
            try { ctx.ui.notify(`📡 coms: unknown subcommand "${subcommand}". Use: start | stop | status`, "warning"); } catch {}
        }
    };
    // Dedicated entry point, named like /async-status: one keystroke to the peer overlay.
    pi.registerCommand("coms-status", {
        description: "Fullscreen overlay: list coms peers, see live state, kill with x / X",
        handler: async (_args: string, ctx: any) => {
            await openComsPeersOverlay(ctx, {
                listPeers: () => readRegistryRows().filter(rowAlive),
                killPeer: (row) => killPeers({ name: row.name, project: row.project }).text,
                killAll: () => killPeers({ all: true }).text,
            });
        },
    });

    pi.registerCommand("coms", {
        description: "P2P agent communication: /coms start | stop | status | list | kill <name|all>",
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
                    { v: "list", l: "list", d: "List spawned peers (name, pids, state)" },
                    { v: "kill ", l: "kill", d: "Stop a peer: kill <name> | kill all" },
                ]);
            }
            if (completed[0] === "kill") {
                const names = readRegistryRows().filter(rowAlive).map((row) => row.name);
                return mk([...names.map((n) => ({ v: n, l: n, d: "Stop this peer" })), { v: "all", l: "all", d: "Stop every running peer" }]);
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
        handler: comsCmdHandler,
    });
    // ── Agent-facing activation ──────────────────────────────────────────
    // An already-open session (TUI or not) enables coms from a TOOL: no slash command for the user
    // to type, and no new pi process. Both tools drive the same `activateComs` path as /coms start.
    try {
        pi.registerTool({
            name: "coms_start",
            label: "coms start",
            description: "Make THIS session a coms peer (registers an identity, adds coms_send/coms_list). Do NOT confuse it with spawning: this starts no new process and no new model. Use it when you need to talk to peers or the user asks you to start coms.",
            parameters: Type.Object({
                cname: Type.Optional(Type.String({ description: "Peer name others will address (default: agent-<id suffix>)" })),
                purpose: Type.Optional(Type.String({ description: "One line describing what you are working on" })),
                project: Type.Optional(Type.String({ description: "Project namespace for discovery (default: derived from cwd)" })),
                explicit: Type.Optional(Type.Boolean({ description: "Hide from auto-discovery; addressable only by exact name" })),
            }),
            async execute(_id: string, params: any, _signal?: any, _onUpdate?: any, ctx?: any) {
                const parts: string[] = [];
                if (params?.cname) parts.push("--cname", String(params.cname));
                if (params?.purpose) parts.push("--purpose", String(params.purpose));
                if (params?.project) parts.push("--project", String(params.project));
                if (params?.explicit === true) parts.push("--explicit");
                const useCtx = ctx ?? liveCtx;
                if (!useCtx) return { content: [{ type: "text" as const, text: "coms_start: no live session context — try again once the session is ready." }], details: { ok: false, active: false } };
                const result = await activateComs(parts, useCtx);
                return { content: [{ type: "text" as const, text: result.message }], details: { ok: result.ok, active: state.active } };
            },
        });
        pi.registerTool({
            name: "coms_stop",
            label: "coms stop",
            description: "Stop coms for THIS session: stop advertising this peer and drop the coms tools.",
            parameters: Type.Object({}),
            async execute() {
                if (!state.active) return { content: [{ type: "text" as const, text: "coms is not active." }], details: { ok: true, active: false } };
                try { await state.capturedSessionShutdown?.(); } catch (e: any) { log.warn("coms_stop shutdown threw", e?.message ?? String(e)); }
                state.active = false;
                setComsActive(false);
                persistState(pi, PERSIST_KEY, state);
                return { content: [{ type: "text" as const, text: "coms stopped for this session." }], details: { ok: true, active: false } };
            },
        });
    } catch (e: any) {
        log.warn("registering coms_start/coms_stop failed", e?.message ?? String(e));
    }

    // ── PC-wide peer inventory ───────────────────────────────────────────
    // Reads the coms registry directly, so it works whether or not coms is active here, and spans
    // every project: the same --project is deliberately shared across repos.
    // Honour a configured coms_dir: the registry may not live under ~/.pi/coms.
    const comsRoot = (): string => {
        let base = path.join(os.homedir(), ".pi", "coms");
        try {
            const configured = getSetting(liveCtx?.cwd || process.cwd(), "coms_dir");
            if (typeof configured === "string" && configured) base = configured;
        } catch { /* fall back to the default */ }
        return path.join(base, "projects");
    };
    const supervisedPeersDir = (): string => {
        let base = path.join(os.homedir(), ".pi", "coms");
        try {
            const configured = getSetting(liveCtx?.cwd || process.cwd(), "coms_dir");
            if (typeof configured === "string" && configured) base = configured;
        } catch { /* default */ }
        return path.join(base, "peers");
    };
    const readRegistryRows = (): RegistryRow[] => {
        const rows: RegistryRow[] = [];
        let projects: string[] = [];
        try { projects = readdirSync(comsRoot()); } catch { return rows; }
        for (const project of projects) {
            let files: string[] = [];
            try { files = readdirSync(path.join(comsRoot(), project, "agents")); } catch { continue; }
            for (const file of files) {
                if (!file.endsWith(".json")) continue;
                try {
                    const entry = JSON.parse(readFileSync(path.join(comsRoot(), project, "agents", file), "utf-8"));
                    if (!entry || typeof entry.name !== "string") continue;
                    rows.push({
                        project,
                        name: entry.name,
                        pid: Number.isInteger(entry.pid) ? entry.pid : null,
                        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
                        purpose: typeof entry.purpose === "string" ? entry.purpose : "",
                        endpoint: typeof entry.endpoint === "string" ? entry.endpoint : "",
                        busy: entry.busy === true,
                        queueDepth: typeof entry.queue_depth === "number" ? entry.queue_depth : null,
                        contextUsedPct: typeof entry.context_used_pct === "number" ? entry.context_used_pct : null,
                        startedAt: typeof entry.started_at === "string" ? entry.started_at : null,
                        heartbeatAt: typeof entry.heartbeat_at === "string" ? entry.heartbeat_at : null,
                    });
                } catch { /* malformed entry: skip, never fail the list */ }
            }
        }
        return rows;
    };
    const rowAlive = (row: RegistryRow): boolean => {
        // Heartbeat first: a reused pid would otherwise make a dead peer look alive.
        if (!isFreshHeartbeat(row.heartbeatAt, Date.now())) return false;
        // On Windows the endpoint is a named pipe, which fs.existsSync cannot see.
        if (process.platform !== "win32" && row.endpoint && !existsSync(row.endpoint)) return false;
        if (!row.pid) return true; // no pid claim: socket + heartbeat decided
        try { process.kill(row.pid, 0); return true; } catch { return false; }
    };

    const listPeers = (params: { project?: string; name?: string }): string =>
        formatPeerTable(filterRegistry(readRegistryRows().filter(rowAlive), { project: params.project, name: params.name }));

    /** Peers this tool may kill: only those a supervisor started.
     *  `kill all` over the registry would also signal the caller's own session and every human TUI
     *  session sharing the project — the registry lists every peer, not every disposable one. */
    const killableRows = (): RegistryRow[] => {
        let files: string[] = [];
        const records: any[] = [];
        try { files = readdirSync(supervisedPeersDir()); } catch { return []; }
        for (const file of files) {
            if (!file.endsWith(".json")) continue;
            try { records.push(JSON.parse(readFileSync(path.join(supervisedPeersDir(), file), "utf-8"))); } catch { /* skip */ }
        }
        const supervised = supervisedPeerKeys(records);
        return readRegistryRows().filter((row) => supervised.has(`${row.project}::${row.name}`));
    };

    const killPeers = (params: { name?: string; project?: string; all?: boolean }): { text: string; killed: number } => {
        // Only supervised peers are candidates — never the caller, never a human session.
        const rows = killableRows();
        const inScope = params.project ? rows.filter((row) => row.project === params.project) : rows;
        const selection = selectKillTargets(inScope, params, rowAlive);
        if (selection.ambiguous.length > 0) {
            const where = selection.ambiguous.map((row) => row.project).join(", ");
            return { text: `"${params.name}" exists in several projects (${where}). Say which: coms_peer_kill with project, or /coms kill ${params.name} --project <p>.`, killed: 0 };
        }
        if (selection.missing.length > 0) {
            return { text: `No running peer named "${selection.missing[0]}". Use coms_peers to list them.`, killed: 0 };
        }
        if (selection.targets.length === 0) return { text: "Nothing to kill: no matching running peers.", killed: 0 };
        const killed: string[] = [];
        for (const row of selection.targets) {
            // Prefer the SUPERVISOR: it kills the peer, records the stop and exits. Killing the peer
            // directly leaves the supervisor holding a dead child and rewrites the record wrongly.
            let target = row.pid as number;
            for (const file of [`${row.name}@${row.project}.json`, `${row.name}.json`]) {
                try {
                    const supervision = JSON.parse(readFileSync(path.join(supervisedPeersDir(), file), "utf-8"));
                    if (supervision?.project && supervision.project !== row.project) continue;
                    // Only signal a supervisor whose recorded child IS this peer: a reused pid would
                    // otherwise make us kill an unrelated process.
                    if (Number.isInteger(supervision?.pid) && supervision?.childPid === row.pid) {
                        try { process.kill(supervision.pid, 0); target = supervision.pid; } catch { /* gone: kill the peer */ }
                    }
                    break;
                } catch { /* try the next shape */ }
            }
            try {
                process.kill(target, "SIGTERM");
                killed.push(`${row.name}·${row.project}`);
                log.info("coms_peer_kill", { name: row.name, project: row.project, pid: row.pid });
            } catch (error: any) {
                log.warn("coms_peer_kill failed", { name: row.name, pid: row.pid, error: String(error?.message ?? error) });
            }
        }
        return { text: `Stopped: ${killed.join(", ")}`, killed: killed.length };
    };

    try {
        pi.registerTool({
            name: "coms_peers",
            label: "coms peers",
            description: "List EVERY pi peer on this machine from the coms registry — all projects — with name, project, busy/idle, queue depth, context usage and pid. Works even when coms is not active here. Live STATE only: a peer is a headless process, so watching its screen needs an interactive attach (rex), not this list. Filter with project and/or name.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Only peers in this project namespace" })),
                name: Type.Optional(Type.String({ description: "Only this peer name" })),
            }),
            async execute(_id: string, params: any) {
                return { content: [{ type: "text" as const, text: listPeers({ project: params?.project, name: params?.name }) }], details: {} };
            },
        });
        pi.registerTool({
            name: "coms_peer_kill",
            label: "coms peer kill",
            description: "Stop a running peer by name (add project when the name exists in several projects), or every peer with all:true. Kills the supervisor first so the peer, its stdin and its record are cleaned up together. Reports ambiguity instead of guessing.",
            parameters: Type.Object({
                name: Type.Optional(Type.String({ description: "Peer name to stop" })),
                project: Type.Optional(Type.String({ description: "Project namespace, required when the name is ambiguous" })),
                all: Type.Optional(Type.Boolean({ description: "Stop every running peer on this machine" })),
            }),
            async execute(_id: string, params: any) {
                const result = killPeers({ name: params?.name, project: params?.project, all: params?.all });
                return { content: [{ type: "text" as const, text: result.text }], details: { killed: result.killed } };
            },
        });
    } catch (e: any) {
        log.warn("registering coms_peers/coms_peer_kill failed", e?.message ?? String(e));
    }

    // Expose handler to pidash for browser command dispatch
    try {
        if ((globalThis as any).__coms_pidash_listener) {
            // #951: pi's EventBus exposes only emit/on — no removeListener. This cleanup has
            // always thrown (swallowed by the catch), so the stale listener is never removed;
            // latent bug left as-is, typed to match reality.
            try { (pi.events as { removeListener?: (channel: string, handler: (data: unknown) => void) => void }).removeListener?.("pidash:request-commands", (globalThis as any).__coms_pidash_listener); } catch {}
        }
        const registerWithPidash = () => pi.events.emit("pidash:register-command", { name: "coms", handler: comsCmdHandler });
        (globalThis as any).__coms_pidash_listener = registerWithPidash;
        registerWithPidash();
        pi.events.on("pidash:request-commands", registerWithPidash);
    } catch {}
}
