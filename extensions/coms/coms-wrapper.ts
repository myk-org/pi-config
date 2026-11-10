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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activationVerified, filterRegistry, formatPeerTable, isFreshHeartbeat, pickSupervisionRecord, buildPeerSpawn, planActiveClaim, planPeerKills, resolveKillScope, resolveListScope, resolvePeerScope, supervisedPeerKeys, type RegistryRow } from "./coms-peers.js";
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
        activation: null,
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
            await comsCmdHandler(parts.join(" "), ctx, "cli");
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
    const activateComs = async (flagParts: string[], ctx: any, entry: "tool" | "slash" | "cli" = "slash"): Promise<{ ok: boolean; message: string }> => {
        // One activation at a time: the entry point and the published identity are process-wide, so
        // overlapping starts could label a peer with the other's origin, or verify its socket after
        // their own bind failed.
        if (state.activation) {
            log.debug("coms_activation_joined", { entry });
            return state.activation;
        }
        state.activation = runActivation(flagParts, ctx, entry);
        try {
            return await state.activation;
        } finally {
            state.activation = null;
        }
    };

    const runActivation = async (flagParts: string[], ctx: any, entry: "tool" | "slash" | "cli"): Promise<{ ok: boolean; message: string }> => {
        // Captured before the stale-claim branch can clear it: only a reload keeps the restored flags.
        const restoredFromReload = state.active === true;
        if (state.active) {
            const claim = planActiveClaim((globalThis as any).__comsSelf, process.platform, existsSync, log);
            if (claim.action === "reuse") return { ok: true, message: claim.message };
            // Stale claim: drop it and fall through to a real start rather than making the caller
            // run `/coms stop` first.
            log.info("coms_active_claim_cleared", {});
            // The socket file is gone but its server may still be open (an unlinked Unix socket
            // keeps running). Close it before a new lifecycle overwrites the reference, or the old
            // server is stranded and later shutdown closes only the new one.
            try {
                await state.capturedSessionShutdown?.();
            } catch (error: any) {
                log.warn("coms_stale_claim_shutdown_threw", { error: String(error?.message ?? error) });
            }
            state.active = false;
            setComsActive(false);
            persistState(pi, PERSIST_KEY, state);
        }
        // A retry after a reload may carry no flags, so restored values are kept — but ONLY for the
        // reload case. After an explicit /coms stop, carrying them over would resurrect the old
        // identity (and an --explicit opt-out) that the user just dropped.
        state.flagValues = restoredFromReload ? new Map(state.flagValues ?? []) : new Map();
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
            (globalThis as any).__comsSelfOrigin = entry;
            await state.capturedSessionStart({}, ctx);
            // The upstream start handler catches socket-bind and registry failures and returns, so
            // a normal return is not proof of a peer. Verify the identity it published.
            const self = (globalThis as any).__comsSelf;
            if (!activationVerified(self, process.platform, existsSync)) {
                log.error("coms_activation_unverified", { name: self?.name ?? null, endpoint: self?.endpoint ?? null });
                setComsActive(false);
                return { ok: false, message: "📡 coms start failed: no peer socket was created (see ~/.pi/logs/coms)." };
            }
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

    const comsCmdHandler = async (args: string, ctx: any, entry: "tool" | "slash" | "cli" = "slash") => {
        const trimmed = (args || "").trim();
        const parts = tokenizeArgs(trimmed);
        const subcommand = parts[0] || "status";

        if (subcommand === "start") {
            const result = await activateComs(parts.slice(1), ctx, entry);
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
            // Scope is THIS project: a peer in another project cannot be addressed from here, so
            // listing it only invites a failed send. `--all` / `--project <p>` opt out explicitly.
            const projectScope = resolveListScope(parts, ownProject());
            log.debug("coms_list_scope", { project: projectScope ?? "*" });
            if (ctx?.hasUI) {
                await openComsPeersOverlay(ctx, {
                    listPeers: () => filterRegistry(attachCreatedBy(readRegistryRows()).filter(rowAlive), { project: projectScope }),
                    killPeer: (row) => killPeers({ name: row.name, project: row.project }).text,
                    killAll: () => {
                        const scope = resolveKillScope({ all: true, project: projectScope }, ownProject(), log);
                        // Same refusal as /coms kill all: `X` in a view with no derivable project
                        // must not stop every project's peers.
                        if (scope.refused) return scope.refused;
                        return killPeers(scope).text;
                    },
                });
                return;
            }
            try { ctx.ui.notify(listPeers({ project: projectScope }), "info"); } catch {}
        } else if (subcommand === "kill") {
            const what = (parts[1] ?? "").trim();
            const projectIdx = parts.indexOf("--project");
            if (!what) {
                try { ctx.ui.notify("Usage: /coms kill <peer-name|all> [--project <p>]", "warning"); } catch {}
                return;
            }
            const scope = resolveKillScope({ name: what === "all" ? undefined : what, project: projectIdx >= 0 ? parts[projectIdx + 1] : undefined, all: what === "all" }, ownProject(), log);
            if (scope.refused) {
                try { ctx.ui.notify(scope.refused, "warning"); } catch {}
                return;
            }
            const result = killPeers(scope);
            try { ctx.ui.notify(result.text, result.killed > 0 ? "info" : "warning"); } catch {}
        } else if (subcommand === "status") {
            try {
                ctx.ui.notify(state.active ? "📡 coms: active (P2P)" : "📡 coms: inactive — run /coms start", "info");
            } catch {}
        } else {
            try { ctx.ui.notify(`📡 coms: unknown subcommand "${subcommand}". Use: start | stop | status`, "warning"); } catch {}
        }
    };
    pi.registerCommand("coms", {
        description: "P2P agent communication: /coms start | stop | status | list [--all] | kill <name|all>",
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
                const names = attachCreatedBy(readRegistryRows()).filter(rowAlive).map((row) => row.name);
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
                const result = await activateComs(parts, useCtx, "tool");
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
                        origin: typeof entry.origin === "string" ? entry.origin : null,
                        createdBy: null,
                    });
                } catch (error: any) {
                    log.warn("coms_registry_entry_unreadable", { file: path.join(comsRoot(), project, "agents", file), error: String(error?.message ?? error) });
                }
            }
        }
        return rows;
    };
    /** Provenance lives in the supervisor record; attach it so the list and its detail can show it. */
    const attachCreatedBy = (rows: RegistryRow[]): RegistryRow[] => {
        const records = readSupervisionRecords();
        for (const row of rows) {
            const record = pickSupervisionRecord(records, row);
            if (record && typeof (record as any).createdBy === "string") row.createdBy = (record as any).createdBy;
        }
        return rows;
    };
    const rowAlive = (row: RegistryRow): boolean => {
        // Heartbeat first: a reused pid would otherwise make a dead peer look alive. The FIRST
        // registry write has no heartbeat yet, so a just-spawned peer falls back to its start time
        // instead of vanishing for a keepalive interval.
        const fresh = isFreshHeartbeat(row.heartbeatAt, Date.now()) ||
            (!row.heartbeatAt && isFreshHeartbeat(row.startedAt, Date.now()));
        if (!fresh) return false;
        // On Windows the endpoint is a named pipe, which fs.existsSync cannot see.
        if (process.platform !== "win32" && row.endpoint && !existsSync(row.endpoint)) return false;
        if (!row.pid) return true; // no pid claim: socket + heartbeat decided
        try { process.kill(row.pid, 0); return true; } catch { return false; }
    };

    /** This session's project namespace: the active flag when coms is on, else derived from cwd
     *  exactly as activation derives it. */
    const ownProject = (): string => {
        const active = String(state.flagValues?.get("project") ?? "").trim();
        if (state.active && active) {
            log.debug("coms_own_project", { project: active, source: "active-flag" });
            return active;
        }
        const cwd = liveCtx?.cwd || process.cwd();
        const derived = cwd.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
        log.debug("coms_own_project", { project: derived, source: "cwd" });
        return derived;
    };

    const listPeers = (params: { project?: string; name?: string }): string => {
        const rows = filterRegistry(attachCreatedBy(readRegistryRows()).filter(rowAlive), { project: params.project, name: params.name });
        log.debug("coms_list_peers", { project: params.project ?? "*", name: params.name ?? null, count: rows.length });
        if (rows.length > 0) return formatPeerTable(rows);
        // Say WHAT was searched: an empty list that names neither scope nor name cannot be acted on.
        const scope = params.project ? `project "${params.project}"` : "any project";
        const sought = params.name ? `peer "${params.name}"` : "peers";
        const hint = params.project ? " Pass project:\"*\" for every project on this machine." : "";
        return `No ${sought} in ${scope}.${hint}`;
    };

    /** Supervisor records, read from every location a peer may have used: the configured
     *  `coms_dir` AND `PI_COMS_DIR`. Reading one made a configured peer unkillable. */
    const readSupervisionRecords = (): any[] => {
        const dirs = new Set<string>([supervisedPeersDir()]);
        const envDir = (process.env.PI_COMS_DIR || "").trim();
        if (envDir) dirs.add(path.join(envDir, "peers"));
        const records: any[] = [];
        for (const dir of dirs) {
            let files: string[] = [];
            try { files = readdirSync(dir); } catch { continue; }
            for (const file of files) {
                if (!file.endsWith(".json")) continue;
                try {
                    records.push(JSON.parse(readFileSync(path.join(dir, file), "utf-8")));
                } catch (error: any) {
                    log.warn("coms_supervision_record_unreadable", { file: path.join(dir, file), error: String(error?.message ?? error) });
                }
            }
        }
        return records;
    };

    const killPeers = (params: { name?: string; project?: string; all?: boolean }): { text: string; killed: number } => {
        const rows = attachCreatedBy(readRegistryRows());
        const records = readSupervisionRecords();
        const plan = planPeerKills({
            rows,
            supervisedKeys: supervisedPeerKeys(records),
            records,
            request: params,
            isAlive: rowAlive,
        });
        const ambiguous = plan.filter((entry) => entry.reason === "ambiguous");
        if (ambiguous.length > 1) {
            return { text: `"${params.name}" exists in ${ambiguous.map((e) => e.project).join(", ")} — pass project to choose.`, killed: 0 };
        }
        if (plan.length === 0) {
            return { text: params.name ? `No peer matches "${params.name}"${params.project ? ` in ${params.project}` : ""}.` : "Nothing to kill.", killed: 0 };
        }
        // Scope decisions are logged: "kill all did nothing" must be explainable.
        for (const entry of plan.filter((e) => e.reason !== "supervisor" && e.reason !== "peer")) {
            log.debug("coms_peer_kill_skipped", { name: entry.name, project: entry.project, reason: entry.reason });
        }
        const killed: string[] = [];
        for (const entry of plan) {
            if (entry.signalPid === null) continue;
            try {
                process.kill(entry.signalPid, "SIGTERM");
                killed.push(`${entry.name}·${entry.project}`);
                log.info("coms_peer_kill", { name: entry.name, project: entry.project, pid: entry.signalPid, via: entry.reason });
            } catch (error: any) {
                log.warn("coms_peer_kill failed", { name: entry.name, pid: entry.signalPid, error: String(error?.message ?? error) });
            }
        }
        if (killed.length === 0) return { text: "Nothing to kill: no supervised peer matched (see logs for why).", killed: 0 };
        return { text: `Stopped: ${killed.join(", ")}`, killed: killed.length };
    };

    try {
        pi.registerTool({
            name: "coms_peers",
            label: "coms peers",
            description: "List pi peers from the coms registry with name, project, busy/idle, queue depth, context usage and pid. Defaults to THIS session's project: a peer in another project cannot be addressed from here, so it is noise. Pass project:\"*\" for every project on the machine. Works even when coms is not active here. Live STATE only: a peer is a headless process, so watching its screen needs an interactive attach (rex), not this list.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Project namespace, or \"*\" for all projects (default: this session's project)" })),
                name: Type.Optional(Type.String({ description: "Only this peer name" })),
            }),
            async execute(_id: string, params: any) {
                const scope = resolvePeerScope(params?.project, ownProject());
                log.debug("coms_peers_scope", { project: scope.project, everyProject: scope.everyProject });
                return { content: [{ type: "text" as const, text: listPeers({ project: scope.project ?? undefined, name: params?.name }) }], details: {} };
            },
        });
        pi.registerTool({
            name: "coms_peer_spawn",
            label: "coms peer spawn",
            description: "Start another agent as its own pi peer: a supervised `pi --coms` process with its own session, addressable by name from coms_send. THIS is how you create a peer — you do not need a human to type anything. The peer boots in ~20-30s before it appears in coms_peers; it has no lifetime of its own, so stop it with coms_peer_kill when done.",
            parameters: Type.Object({
                cname: Type.String({ description: "Peer name, e.g. `reviewer` or `builder-2` (letters, digits, dot, dash, underscore)" }),
                purpose: Type.Optional(Type.String({ description: "One line describing what this peer is for" })),
                project: Type.Optional(Type.String({ description: "Project namespace (default: this session's project)" })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: this session's cwd)" })),
            }),
            async execute(_id: string, params: any) {
                // The supervisor ships inside the package (package.json `files`). Resolve it next to
                // THIS extension rather than trusting the cwd, which made spawn fail for every
                // installed user whose project is not this checkout.
                const here = path.dirname(fileURLToPath(import.meta.url));
                const supervisor = [
                    path.join(here, "..", "..", "scripts", "coms-peer-supervisor.mjs"),
                    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-orchestrator-config", "scripts", "coms-peer-supervisor.mjs"),
                    path.join(liveCtx?.cwd || process.cwd(), "scripts", "coms-peer-supervisor.mjs"),
                ].map(candidate => path.resolve(candidate)).find(candidate => existsSync(candidate)) ?? "";
                const plan = buildPeerSpawn(supervisor, {
                    cname: params?.cname,
                    purpose: params?.purpose,
                    project: params?.project ?? ownProject(),
                    cwd: params?.cwd ?? (liveCtx?.cwd || process.cwd()),
                }, log);
                if (!plan.ok) {
                    log.warn("coms_peer_spawn_rejected", { message: plan.message });
                    return { content: [{ type: "text" as const, text: plan.message }], details: { ok: false, pid: null } };
                }
                try {
                    // The supervisor writes its ownership record under the configured coms_dir, so it
                    // has to be told which one this session uses — otherwise the peer is visible but
                    // unkillable because the record lives elsewhere.
                    const env = { ...process.env };
                    const configuredComsDir = comsRoot().replace(/[\\/]projects$/, "");
                    if (configuredComsDir) env.PI_COMS_DIR = configuredComsDir;
                    // Deliberately detached: a peer must outlive this session (peers are independent
                    // processes, so killing them is explicit too). An async launch error arrives as an
                    // event, not a throw, and would otherwise kill the session.
                    const child = spawn(plan.command[0]!, plan.command.slice(1), { detached: true, stdio: "ignore", env });
                    child.on("error", (error: any) => {
                        log.error("coms_peer_spawn_async_error", { cname: params?.cname, error: String(error?.message ?? error) });
                    });
                    child.unref();
                    log.info("coms_peer_spawned", { cname: params?.cname, pid: child.pid ?? null, args: plan.command.slice(2).join(" ") });
                    return {
                        // "Started" means the supervisor launched, not that the peer is alive: the peer
                        // boots `pi` afterwards, so point at the only place a startup failure shows up.
                        content: [{ type: "text" as const, text: `Started supervisor for peer "${params?.cname}" (pid ${child.pid ?? "?"}). The peer registers in ~20-30s — check coms_peers; if it never appears, read ~/.pi/logs/coms-peers/${params?.cname}@${params?.project ?? ownProject()}.log` }],
                        details: { ok: true, pid: child.pid ?? null },
                    };
                } catch (error: any) {
                    log.error("coms_peer_spawn_failed", { cname: params?.cname, error: String(error?.message ?? error) });
                    return { content: [{ type: "text" as const, text: `coms peer spawn failed: ${error?.message ?? error}` }], details: { ok: false, pid: null } };
                }
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
                const scope = resolveKillScope({ name: params?.name, project: params?.project, all: params?.all }, ownProject(), log);
                if (scope.refused) return { content: [{ type: "text" as const, text: scope.refused }], details: { ok: false, killed: 0 } };
                const result = killPeers(scope);
                return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.killed > 0, killed: result.killed } };
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
