/**
 * coms-wrapper.ts — On-demand P2P agent communication controller.
 *
 * Drives the instantiable `ComsPeerRuntime` (`coms-p2p.ts`) and unified `ComsRegistry`
 * (`coms-registry.ts`) directly via typed interfaces — supporting `/coms` lifecycle,
 * reload reactivation, peer inventory/supervision tools, and pidash command registration
 * with zero ExtensionAPI proxying or `globalThis.__coms*` side channels.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as os from "node:os";
import { parseFlags, tokenizeArgs, persistState, parseComsTell, syncComsActiveTools } from "./coms-shared.js";
import {
    createComsPeerRuntime,
    type ComsActivationOrigin,
    type ComsPeerFlagOverrides,
    type ComsPeerRuntime,
} from "./coms-p2p.js";
import { ComsRegistry, isRegistryRowAlive, resolveComsDir } from "./coms-registry.js";
import { setComsActive } from "../shared/coms-active.js";
import { createLogger } from "../shared/logger.js";
import { emitIfLive, isLiveExtensionCtx } from "../shared/live-ctx.js";
import {
    WIDGET_MODE_CHANGED_EVENT,
    applyWidgetAction,
    cycleWidgetMode,
    parseWidgetCommandAction,
    registerWidgetShortcut,
} from "../shared/widget-visibility.js";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    activationVerified,
    completeTellArgs,
    filterRegistry,
    formatPeerTable,
    pickSupervisionRecord,
    buildPeerSpawn,
    planActiveClaim,
    planPeerKills,
    resolveKillScope,
    resolveListScope,
    resolvePeerScope,
    supervisedPeerKeys,
    type RegistryRow,
} from "./coms-peers.js";
import { openComsPeersOverlay } from "./coms-peers-ui.js";
import { requestDescribe } from "./coms-describe.js";

const log = createLogger("coms");

function fuzzy(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
    if (!query.trim()) return items.length > 0 ? items : null;
    const result = fuzzyFilter(items, query, i => `${i.label} ${i.description || ""}`);
    return result.length > 0 ? result : null;
}

function mapToFlagOverrides(values: Map<string, any>): ComsPeerFlagOverrides {
    const out: ComsPeerFlagOverrides = {};
    const cname = values.get("cname");
    if (typeof cname === "string" && cname) out.cname = cname;
    const purpose = values.get("purpose");
    if (typeof purpose === "string" && purpose) out.purpose = purpose;
    const project = values.get("project");
    if (typeof project === "string" && project) out.project = project;
    const color = values.get("color");
    if (typeof color === "string" && color) out.color = color;
    if (values.get("explicit") === true) out.explicit = true;
    return out;
}

export interface RegisterComsOptions {
    /** Override COMS directory (primarily for isolated tests). */
    comsDir?: string;
    /** Override session ID passed to the peer runtime (primarily for isolated tests). */
    sessionId?: string;
    /** Allow peer runtime registration even when `PI_SUBAGENT_CHILD=1`. */
    allowSubagentChild?: boolean;
    /** Whether to bind process SIGINT/SIGTERM handlers while active (default: true). */
    registerSignalHandlers?: boolean;
}

export interface RegisteredComs {
    runtime: ComsPeerRuntime;
    getRegistry: (cwdOverride?: string) => ComsRegistry;
}

export function registerComs(pi: ExtensionAPI, options: RegisterComsOptions = {}): RegisteredComs {
    const PERSIST_KEY = "coms-state";
    let active = false;
    let flagValues = new Map<string, any>();
    let extra: Record<string, any> = {};
    let activation: Promise<{ ok: boolean; message: string }> | null = null;
    let liveCtx: any = null;
    let cachedRegistry: ComsRegistry | null = null;
    let pidashUnsubscribe: (() => void) | null = null;

    const getRegistry = (cwdOverride?: string): ComsRegistry => {
        const dir = options.comsDir || resolveComsDir(cwdOverride ?? liveCtx?.cwd ?? process.cwd());
        if (!cachedRegistry || cachedRegistry.comsDir !== dir) {
            cachedRegistry = new ComsRegistry(dir);
        }
        return cachedRegistry;
    };

    const runtime = createComsPeerRuntime(pi, {
        deferred: true,
        inactiveMessage: "⚠️ coms not active. Run `/coms start` first.",
        getFlag: (name) => flagValues.get(name),
        comsDir: options.comsDir,
        sessionId: options.sessionId,
        allowSubagentChild: options.allowSubagentChild,
        registerSignalHandlers: options.registerSignalHandlers,
    });

    const gatedTools = new Set<string>(runtime.gatedToolNames);

    const persistCurrentState = (): void => {
        persistState(pi, PERSIST_KEY, { active, flagValues, extra });
    };

    registerWidgetShortcut(
        pi,
        "widget_coms_shortcut",
        process.cwd(),
        "Collapse/expand coms widget",
        (ctx) => {
            if (!isLiveExtensionCtx(ctx)) return;
            const cwd = ctx?.cwd || process.cwd();
            const next = cycleWidgetMode("coms", cwd);
            emitIfLive(pi, WIDGET_MODE_CHANGED_EVENT, { widget: "coms", mode: next, cwd });
            log.info("coms_widget_shortcut_cycled", { mode: next });
        },
    );

    const ensurePidashRegistration = (): void => {
        if (pidashUnsubscribe) return;
        try {
            const registerWithPidash = () => {
                pi.events.emit("pidash:register-command", { name: "coms", handler: comsCmdHandler });
                pi.events.emit("pidash:register-command", {
                    name: "coms-queue",
                    handler: (args: string, ctx: any) => runtime.openQueueOverlay(args, ctx),
                });
            };
            const unsub = pi.events.on("pidash:request-commands", registerWithPidash);
            if (typeof unsub === "function") pidashUnsubscribe = unsub;
            registerWithPidash();
        } catch (err) {
            log.warn("pidash_command_register_failed", { error: err instanceof Error ? err.message : String(err) });
        }
    };

    // Single session_start handler: prunes stale registry entries, handles reload reactivation,
    // resets state on fresh startup, and supports `pi --coms` autostart.
    pi.on("session_start", async (evt: any, ctx: any) => {
        liveCtx = ctx;
        ensurePidashRegistration();
        try {
            const cwd = ctx?.cwd || process.cwd();
            getRegistry(cwd).scheduleStartupPrune();
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            log.warn("stale cleanup failed", err.message.slice(0, 100), err);
        }

        if (evt?.reason === "reload") {
            let wasActive = false;
            let savedFlags: Record<string, any> = {};
            let savedExtra: Record<string, any> = {};
            const entries = ctx?.sessionManager?.getEntries?.() ?? [];
            for (const entry of entries) {
                if (entry.type === "custom" && entry.customType === PERSIST_KEY) {
                    wasActive = entry.data?.active === true;
                    savedFlags = entry.data?.flags || {};
                    savedExtra = entry.data?.extra || {};
                }
            }
            if (wasActive) {
                flagValues = new Map(Object.entries(savedFlags));
                extra = savedExtra;
                const savedOrigin: ComsActivationOrigin =
                    savedExtra?.origin === "tool" || savedExtra?.origin === "cli" ? savedExtra.origin : "slash";
                try {
                    const self = await runtime.start(ctx, {
                        flags: mapToFlagOverrides(flagValues),
                        origin: savedOrigin,
                    });
                    if (!activationVerified(self, process.platform, existsSync)) {
                        throw new Error("no peer socket was created during reload reactivation");
                    }
                    active = true;
                    setComsActive(true);
                    syncComsActiveTools(pi, gatedTools, true);
                } catch (err) {
                    active = false;
                    setComsActive(false);
                    syncComsActiveTools(pi, gatedTools, false);
                    persistCurrentState();
                    const msg = err instanceof Error ? err.message : String(err);
                    const error = err instanceof Error ? err : new Error(msg);
                    log.error("reload reactivation failed", msg, error);
                }
            } else {
                active = false;
                syncComsActiveTools(pi, gatedTools, false);
            }
            return;
        }

        active = false;
        setComsActive(false);
        syncComsActiveTools(pi, gatedTools, false);
        persistCurrentState();

        // `pi --coms …`: a headless peer boots itself, no slash command and no terminal.
        if (pi.getFlag("coms") === true) {
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

    pi.on("session_shutdown", async () => {
        if (pidashUnsubscribe) {
            try { pidashUnsubscribe(); } catch { /* ignore */ }
            pidashUnsubscribe = null;
        }
        try {
            await runtime.stop();
        } catch (err) {
            log.warn("coms_shutdown_failed", { error: err instanceof Error ? err.message : String(err) });
        }
        // Keep persisted session state intact so `/reload` sees `active: true` and reactivates.
        active = false;
    });

    // Activation flag: `pi --coms --cname x --project y` starts the peer at session start, so a
    // spawned pi can be given its identity without a human typing /coms start into a terminal.
    try {
        pi.registerFlag("coms", {
            description: "Start coms P2P automatically at session start (use --cname/--project for identity)",
            type: "boolean",
            default: false,
        });
    } catch (e: unknown) {
        log.warn("registering --coms flag failed", e instanceof Error ? e.message : String(e));
    }

    /** Activate coms for THIS session — the one path used by `/coms start`, `pi --coms …` and the
     *  `coms_start` tool. A tool is how an already-open session (or an agent) enables coms without a
     *  slash command and without spawning a new pi. */
    const activateComs = async (
        flagParts: string[],
        ctx: any,
        entry: ComsActivationOrigin = "slash",
    ): Promise<{ ok: boolean; message: string }> => {
        if (activation) {
            log.debug("coms_activation_joined", { entry });
            return activation;
        }
        activation = runActivation(flagParts, ctx, entry);
        try {
            return await activation;
        } finally {
            activation = null;
        }
    };

    const runActivation = async (
        flagParts: string[],
        ctx: any,
        entry: ComsActivationOrigin,
    ): Promise<{ ok: boolean; message: string }> => {
        // Captured before the stale-claim branch can clear it: only a reload keeps the restored flags.
        const restoredFromReload = active === true;
        if (active) {
            const claim = planActiveClaim(runtime.getSelf(), process.platform, existsSync, log);
            if (claim.action === "reuse") return { ok: true, message: claim.message };
            // Stale claim: drop it and fall through to a real start rather than making the caller
            // run `/coms stop` first.
            log.info("coms_active_claim_cleared", {});
            try {
                await runtime.stop();
            } catch (error: unknown) {
                log.warn("coms_stale_claim_shutdown_threw", { error: error instanceof Error ? error.message : String(error) });
            }
            active = false;
            setComsActive(false);
            syncComsActiveTools(pi, gatedTools, false);
            persistCurrentState();
        }
        // A retry after a reload may carry no flags, so restored values are kept — but ONLY for the
        // reload case. After an explicit /coms stop, carrying them over would resurrect the old
        // identity (and an --explicit opt-out) that the user just dropped.
        flagValues = restoredFromReload ? new Map(flagValues) : new Map();
        parseFlags(flagParts, flagValues);
        if (flagValues.has("name")) {
            return { ok: false, message: "📡 coms: use --cname instead of --name" };
        }
        if (!flagValues.has("project")) {
            const cwd = ctx?.cwd || "";
            const proj = cwd.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
            if (!proj) return { ok: false, message: "📡 coms: cannot start from /. Run from a project directory." };
            flagValues.set("project", proj);
        }
        try {
            const self = await runtime.start(ctx, {
                flags: mapToFlagOverrides(flagValues),
                origin: entry,
            });
            if (!activationVerified(self, process.platform, existsSync)) {
                log.error("coms_activation_unverified", { name: self?.name ?? null, endpoint: self?.endpoint ?? null });
                setComsActive(false);
                return { ok: false, message: "📡 coms start failed: no peer socket was created (see ~/.pi/logs/coms)." };
            }
            active = true;
            extra = { ...extra, origin: entry };
            setComsActive(true);
            syncComsActiveTools(pi, gatedTools, true);
            persistCurrentState();
            const name = String(flagValues.get("cname") ?? self?.name ?? "peer");
            const project = String(flagValues.get("project"));
            log.info("coms activated", { name, project, via: "tool-or-command" });
            return { ok: true, message: `📡 coms active — you are "${name}" on project "${project}". Peers: use coms_list.` };
        } catch (err: unknown) {
            setComsActive(false);
            const msg = err instanceof Error ? err.message : String(err);
            log.error("coms activation failed", msg, err instanceof Error ? err : new Error(msg));
            return { ok: false, message: `📡 coms start failed: ${msg}` };
        }
    };

    /** #1077: the user's own message to a peer. The command layer is the only place allowed to
     *  claim origin "user", so this calls `runtime.sendAsUser()` directly — never `coms_send`,
     *  whose input an agent controls. */
    const tellPeer = async (
        target: string,
        prompt: string,
        project?: string,
        expectedEndpoint?: string,
    ): Promise<{ ok: true } | { ok: false; reason: string; code: string }> => {
        if (!runtime.isActive()) {
            log.warn("coms_tell_unavailable", { target });
            return { ok: false, code: "coms-inactive", reason: "coms is not active — run /coms start first." };
        }
        try {
            const result = await runtime.sendAsUser({
                target,
                prompt,
                project,
                ...(expectedEndpoint ? { expectedEndpoint } : {}),
            });
            log.info("coms_tell", { target, project: project ?? null, ok: result.ok });
            if (result.ok) return { ok: true };
            return { ok: false, code: "send-failed", reason: result.message };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error("coms_tell_threw", { target, project: project ?? null, error: message });
            return { ok: false, code: "threw", reason: message };
        }
    };

    const comsCmdHandler = async (args: string, ctx: any, entry: ComsActivationOrigin = "slash") => {
        const trimmed = (args || "").trim();
        const parts = tokenizeArgs(trimmed);
        const subcommand = parts[0] || "status";

        if (subcommand === "tell") {
            const tell = parseComsTell(trimmed.slice("tell".length));
            if (!tell) {
                try { ctx.ui.notify("Usage: /coms tell [--project <p>] <peer> <message>", "warning"); } catch {}
                return;
            }
            if (!active) {
                try { ctx.ui.notify("📡 coms not active — run /coms start first.", "warning"); } catch {}
                return;
            }
            const result = await tellPeer(tell.peer, tell.message, tell.project);
            const text = result.ok ? `📡 sent to ${tell.peer}` : `⚠️ ${result.reason}`;
            try { ctx.ui.notify(text, result.ok ? "info" : "error"); } catch {}
            return;
        }
        if (subcommand === "start") {
            const result = await activateComs(parts.slice(1), ctx, entry);
            try { ctx.ui.notify(result.message, result.ok ? "info" : "error"); } catch {}
            return;
        }
        if (subcommand === "stop") {
            if (!active) {
                try { ctx.ui.notify("📡 coms not active", "info"); } catch {}
                return;
            }
            try {
                await runtime.stop();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                const error = err instanceof Error ? err : new Error(msg);
                log.warn("/coms stop: session shutdown threw", msg, error);
            }
            active = false;
            setComsActive(false);
            syncComsActiveTools(pi, gatedTools, false);
            persistCurrentState();
            try { ctx.ui.notify("📡 coms stopped", "info"); } catch {}
        } else if (subcommand === "list" || subcommand === "peers") {
            const projectScope = resolveListScope(parts, ownProject());
            log.debug("coms_list_scope", { project: projectScope ?? "*" });
            if (ctx?.hasUI) {
                await openComsPeersOverlay(ctx, {
                    listPeers: () => filterRegistry(attachCreatedBy(getRegistry().readLiveRows()), { project: projectScope }),
                    // #1083: the drilldown asks the PEER for its own state. No reply inside the
                    // timeout is `unknown` — never a filesystem scan of another process.
                    describePeer: (row) => requestDescribe(row.endpoint),
                    killPeer: (row) => killPeers({ name: row.name, project: row.project }).text,
                    killAll: () => {
                        const scope = resolveKillScope({ all: true, project: projectScope }, ownProject(), log);
                        if (scope.refused) return scope.refused;
                        return killPeers(scope).text;
                    },
                    tellPeer: (request) => tellPeer(request.target, request.prompt, request.project, request.expectedEndpoint),
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
        } else if (subcommand === "widget") {
            if (parts.length > 2) {
                try { ctx.ui.notify("Usage: /coms widget [expand|collapse|toggle]", "warning"); } catch {}
                return;
            }
            const action = parseWidgetCommandAction(parts[1]);
            if (!action) {
                try { ctx.ui.notify("Usage: /coms widget [expand|collapse|toggle]", "warning"); } catch {}
                return;
            }
            const cwd = ctx?.cwd || process.cwd();
            const next = applyWidgetAction("coms", action, cwd);
            emitIfLive(pi, WIDGET_MODE_CHANGED_EVENT, { widget: "coms", mode: next, cwd });
            log.info("coms_widget_mode_updated", { mode: next, action });
            try { ctx.ui.notify(`📡 coms widget: ${next}`, "info"); } catch {}
        } else if (subcommand === "status") {
            try {
                ctx.ui.notify(active ? "📡 coms: active (P2P)" : "📡 coms: inactive — run /coms start", "info");
            } catch {}
        } else {
            try { ctx.ui.notify(`📡 coms: unknown subcommand "${subcommand}". Use: start | stop | status | tell | list | kill | widget`, "warning"); } catch {}
        }
    };

    pi.registerCommand("coms", {
        description: "P2P agent communication: /coms start | stop | status | tell <peer> <message> | list [--all] | kill <name|all> | widget [expand|collapse|toggle]",
        getArgumentCompletions: (prefix: string) => {
            const tokens = prefix.trim().split(/\s+/).filter(Boolean);
            const atNextToken = prefix.endsWith(" ") || tokens.length === 0;
            const lastPart = atNextToken ? "" : tokens[tokens.length - 1];
            const completed = atNextToken ? tokens : tokens.slice(0, -1);
            const base = atNextToken ? prefix : prefix.slice(0, prefix.length - lastPart.length);
            const mk = (items: { v: string; l: string; d: string }[]) =>
                fuzzy(items.map(i => ({ value: base + i.v, label: i.l, description: i.d })), lastPart);

            if (completed.length === 0) {
                return mk([
                    { v: "start", l: "start", d: "Start P2P agent communication" },
                    { v: "stop", l: "stop", d: "Stop coms" },
                    { v: "status", l: "status", d: "Show coms status" },
                    { v: "tell ", l: "tell", d: "Send a peer a message from YOU (the peer sees it is from the user)" },
                    { v: "list", l: "list", d: "List spawned peers (name, pids, state)" },
                    { v: "kill ", l: "kill", d: "Stop a peer: kill <name> | kill all" },
                    { v: "widget ", l: "widget", d: "Collapse or expand coms widget: expand | collapse | toggle" },
                ]);
            }
            if (completed[0] === "widget" && completed.length === 1) {
                return mk([
                    { v: "expand", l: "expand", d: "Show full peer pool widget" },
                    { v: "collapse", l: "collapse", d: "Collapse to 1-line header with peer counts" },
                    { v: "toggle", l: "toggle", d: "Toggle between expanded and collapsed" },
                ]);
            }
            if (completed[0] === "kill") {
                const names = getRegistry().readLiveRows().map((row) => row.name);
                return mk([...names.map((n) => ({ v: n, l: n, d: "Stop this peer" })), { v: "all", l: "all", d: "Stop every running peer" }]);
            }
            if (completed[0] === "tell") {
                const optionsList = completeTellArgs(getRegistry().readLiveRows(), completed);
                return optionsList ? mk(optionsList) : null;
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
    try {
        pi.registerTool({
            name: "coms_start",
            label: "coms start",
            description: "Activate coms for THIS session (registers identity and enables coms_send/coms_list; starts no new process).",
            parameters: Type.Object({
                cname: Type.Optional(Type.String({ description: "Peer name (default: agent-<id suffix>)" })),
                purpose: Type.Optional(Type.String({ description: "One-line work summary" })),
                project: Type.Optional(Type.String({ description: "Project namespace (default: from cwd)" })),
                explicit: Type.Optional(Type.Boolean({ description: "Hide from auto-discovery; addressable by exact name only" })),
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
                return { content: [{ type: "text" as const, text: result.message }], details: { ok: result.ok, active } };
            },
        });
        pi.registerTool({
            name: "coms_stop",
            label: "coms stop",
            description: "Stop coms for THIS session: stop advertising this peer and drop the coms tools.",
            defaultActive: false,
            parameters: Type.Object({}),
            async execute() {
                if (!active) return { content: [{ type: "text" as const, text: "coms is not active." }], details: { ok: true, active: false } };
                try { await runtime.stop(); } catch (e: unknown) { log.warn("coms_stop shutdown threw", e instanceof Error ? e.message : String(e)); }
                active = false;
                setComsActive(false);
                syncComsActiveTools(pi, gatedTools, false);
                persistCurrentState();
                return { content: [{ type: "text" as const, text: "coms stopped for this session." }], details: { ok: true, active: false } };
            },
        });
        gatedTools.add("coms_stop");
    } catch (e: unknown) {
        log.warn("registering coms_start/coms_stop failed", e instanceof Error ? e.message : String(e));
    }

    // ── PC-wide peer inventory (delegated to unified ComsRegistry) ───────
    const readSupervisionRecords = (): any[] => {
        const envDir = (process.env.PI_COMS_DIR || "").trim();
        const extraDirs = envDir ? [path.join(envDir, "peers")] : [];
        return getRegistry().readSupervisionRecords(extraDirs);
    };

    const attachCreatedBy = (rows: RegistryRow[], records = readSupervisionRecords()): RegistryRow[] => {
        for (const row of rows) {
            const record = pickSupervisionRecord(records, row);
            if (record && typeof (record as any).createdBy === "string") row.createdBy = (record as any).createdBy;
        }
        return rows;
    };

    const ownProject = (): string => {
        const activeProj = String(flagValues.get("project") ?? "").trim();
        if (active && activeProj) {
            log.debug("coms_own_project", { project: activeProj, source: "active-flag" });
            return activeProj;
        }
        const cwd = liveCtx?.cwd || process.cwd();
        const derived = cwd.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
        log.debug("coms_own_project", { project: derived, source: "cwd" });
        return derived;
    };

    const listPeers = (params: { project?: string; name?: string }): string => {
        const rows = filterRegistry(attachCreatedBy(getRegistry().readLiveRows()), { project: params.project, name: params.name });
        log.debug("coms_list_peers", { project: params.project ?? "*", name: params.name ?? null, count: rows.length });
        if (rows.length > 0) return formatPeerTable(rows);
        const scope = params.project ? `project "${params.project}"` : "any project";
        const sought = params.name ? `peer "${params.name}"` : "peers";
        const hint = params.project ? " Pass project:\"*\" for every project on this machine." : "";
        return `No ${sought} in ${scope}.${hint}`;
    };

    const killPeers = (params: { name?: string; project?: string; all?: boolean }): { text: string; killed: number } => {
        const records = readSupervisionRecords();
        const rows = attachCreatedBy(getRegistry().readRows(), records);
        const plan = planPeerKills({
            rows,
            supervisedKeys: supervisedPeerKeys(records),
            records,
            request: params,
            isAlive: (row) => isRegistryRowAlive(row),
            logger: log,
        });
        const ambiguous = plan.filter((entry) => entry.reason === "ambiguous");
        if (ambiguous.length > 1) {
            return { text: `"${params.name}" exists in ${ambiguous.map((e) => e.project).join(", ")} — pass project to choose.`, killed: 0 };
        }
        if (plan.length === 0) {
            return { text: params.name ? `No peer matches "${params.name}"${params.project ? ` in ${params.project}` : ""}.` : "Nothing to kill.", killed: 0 };
        }
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
            } catch (error: unknown) {
                log.warn("coms_peer_kill failed", { name: entry.name, pid: entry.signalPid, error: error instanceof Error ? error.message : String(error) });
            }
        }
        if (killed.length === 0) return { text: "Nothing to kill: no supervised peer matched (see logs for why).", killed: 0 };
        return { text: `Stopped: ${killed.join(", ")}`, killed: killed.length };
    };

    try {
        pi.registerTool({
            name: "coms_peers",
            label: "coms peers",
            description: "List live peers from the registry (name, project, busy/idle, queue, context, pid). Defaults to this project; pass project:\"*\" for all. Works when coms is inactive.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Project namespace, or \"*\" for all (default: this project)" })),
                name: Type.Optional(Type.String({ description: "Filter to this peer name" })),
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
            description: "Spawn a supervised `pi --coms` peer process (registers in ~20-30s). Stop it with coms_peer_kill when done.",
            parameters: Type.Object({
                cname: Type.String({ description: "Peer name (letters, digits, dot, dash, underscore)" }),
                purpose: Type.Optional(Type.String({ description: "One-line peer purpose" })),
                project: Type.Optional(Type.String({ description: "Project namespace (default: this project)" })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: this cwd)" })),
            }),
            async execute(_id: string, params: any) {
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
                    const env = { ...process.env };
                    const configuredComsDir = getRegistry().comsDir;
                    if (configuredComsDir) env.PI_COMS_DIR = configuredComsDir;
                    const child = spawn(plan.command[0]!, plan.command.slice(1), { detached: true, stdio: "ignore", env });
                    child.on("error", (error: unknown) => {
                        log.error("coms_peer_spawn_async_error", { cname: params?.cname, error: error instanceof Error ? error.message : String(error) });
                    });
                    child.unref();
                    log.info("coms_peer_spawned", { cname: params?.cname, pid: child.pid ?? null, args: plan.command.slice(2).join(" ") });
                    return {
                        content: [{ type: "text" as const, text: `Started supervisor for peer "${params?.cname}" (pid ${child.pid ?? "?"}). The peer registers in ~20-30s — check coms_peers; if it never appears, read ~/.pi/logs/coms-peers/${params?.cname}@${params?.project ?? ownProject()}.log` }],
                        details: { ok: true, pid: child.pid ?? null },
                    };
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    log.error("coms_peer_spawn_failed", { cname: params?.cname, error: message });
                    return { content: [{ type: "text" as const, text: `coms peer spawn failed: ${message}` }], details: { ok: false, pid: null } };
                }
            },
        });
        pi.registerTool({
            name: "coms_peer_kill",
            label: "coms peer kill",
            description: "Stop a running supervised peer by name (pass project if ambiguous), or all:true for all peers in scope.",
            parameters: Type.Object({
                name: Type.Optional(Type.String({ description: "Peer name to stop" })),
                project: Type.Optional(Type.String({ description: "Project namespace when name is ambiguous" })),
                all: Type.Optional(Type.Boolean({ description: "Stop all running peers in scope" })),
            }),
            async execute(_id: string, params: any) {
                const scope = resolveKillScope({ name: params?.name, project: params?.project, all: params?.all }, ownProject(), log);
                if (scope.refused) return { content: [{ type: "text" as const, text: scope.refused }], details: { ok: false, killed: 0 } };
                const result = killPeers(scope);
                return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.killed > 0, killed: result.killed } };
            },
        });
    } catch (e: unknown) {
        log.warn("registering coms_peers/coms_peer_kill failed", e instanceof Error ? e.message : String(e));
    }

    // Single pidash command registration covering both /coms and /coms-queue.
    ensurePidashRegistration();

    return { runtime, getRegistry };
}
