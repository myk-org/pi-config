/**
 * coms-wrapper.ts — On-demand P2P agent communication controller.
 *
 * Drives the instantiable `ComsPeerRuntime` (`coms-p2p.ts`) and unified `ComsRegistry`
 * (`coms-registry.ts`) directly via typed interfaces — supporting `/coms` lifecycle,
 * reload reactivation, peer inventory/supervision tools, and pidash command registration
 * with zero ExtensionAPI proxying or `globalThis.__coms*` side channels.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { parseFlags, persistState, syncComsActiveTools } from "./coms-shared.js";
import {
    createComsPeerRuntime,
    type ComsActivationOrigin,
    type ComsPeerFlagOverrides,
    type ComsPeerRuntime,
} from "./coms-p2p.js";
import { ComsRegistry, isRegistryRowAlive, resolveComsDir } from "./coms-registry.js";
import { resolveBridgeSessionKey, setComsActive } from "../shared/session-bridge.js";
import { resolvePiAgentDir, withPropagatedPiAgentDirEnv } from "../shared/pi-agent-dir.js";
import { createLogger } from "../shared/logger.js";
import { READ_ONLY_LOCAL_ANNOTATIONS, TOOL_NAMESPACES } from "../shared/tool-namespaces.js";
import { emitIfLive, isBrowserDispatch, isLiveExtensionCtx } from "../shared/live-ctx.js";
import {
    WIDGET_MODE_CHANGED_EVENT,
    cycleWidgetMode,
    registerWidgetShortcut,
} from "../shared/widget-visibility.js";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSetting } from "../orchestrator/project-settings.js";
import {
    isValidPeerContainerName,
    readBuildStatus,
    resolveImageForSpawnAsync,
    startBackgroundPeerImageBuildAsync,
} from "../../scripts/podman-peer-image.mjs";
import {
    activationVerified,
    collectComsActivityEvents,
    filterRegistry,
    formatPeerTable,
    listStoppedSupervisedPeers,
    pickSupervisionRecord,
    buildPeerSpawn,
    planActiveClaim,
    planPeerKills,
    resolveKillScope,
    resolvePeerScope,
    supervisedPeerKeys,
    type KillPlanEntry,
    type RegistryRow,
} from "./coms-peers.js";
import { openComsPeersOverlay } from "./coms-peers-ui.js";
import { createTailHistoryReader } from "./coms-history.js";
import { requestDescribe } from "./coms-describe.js";

const log = createLogger("coms");

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

export interface ExecutePeerKillDeps {
    killPid?: (pid: number, signal: NodeJS.Signals) => void;
    removeContainer?: (containerName: string) => void;
    isSupervisorProcess?: (pid: number) => boolean;
}

/**
 * Verify that `pid` is actually a live `coms-peer-supervisor.mjs` process before signalling it.
 * Guards against PID reuse on crashed supervisors (so an unrelated host process is never
 * signalled and container-removal fallback is never suppressed).
 */
export function defaultIsSupervisorProcess(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        const procPath = `/proc/${pid}/cmdline`;
        if (existsSync(procPath)) {
            const cmdline = readFileSync(procPath, "utf8").replace(/\0/g, " ");
            return cmdline.includes("coms-peer-supervisor.mjs");
        }
    } catch {
        return false;
    }
    // On non-Linux hosts without /proc, check process existence conservatively.
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Enrich live registry rows with metadata from host supervision records.
 * Captures `peerContainer` BEFORE any mutation so a stale Podman supervision record can never
 * attach a container name or dead `hostPid` to a live native peer.
 */
export function attachSupervisionMeta(rows: RegistryRow[], records: any[]): RegistryRow[] {
    for (const row of rows) {
        const record = pickSupervisionRecord(records, row);
        if (!record) continue;
        if (typeof (record as any).createdBy === "string") row.createdBy = (record as any).createdBy;
        const peerContainer = typeof row.container === "string" && row.container.trim() ? row.container.trim() : null;
        const recContainer =
            typeof (record as any).container === "string" && (record as any).container.trim()
                ? (record as any).container.trim()
                : null;
        const isPodmanRecord = (record as any).sandbox === "podman" || Boolean(recContainer);

        // Attach hostPid ONLY when the peer itself reported the matching container identity
        // (via PI_COMS_CONTAINER_NAME) — never let a stale Podman record override a native peer.
        if (
            isPodmanRecord &&
            recContainer &&
            peerContainer === recContainer &&
            !row.hostPid &&
            Number.isInteger((record as any).childPid) &&
            (record as any).childPid > 0
        ) {
            row.hostPid = (record as any).childPid;
        }
    }
    return rows;
}

/**
 * Stop one planned peer kill entry.
 * For containerized peers (#1512):
 * 1. Validates container name against `VALID_PEER_CONTAINER_RE` before any Podman invocation.
 * 2. Verifies supervisor process identity (`isSupervisorProcess`) before signalling `SIGTERM`
 *    when `reason === "supervisor"`, letting the supervisor perform graceful `podman stop`
 *    followed by cleanup without blocking the interactive session event loop.
 * 3. Falls back to detached non-blocking `podman rm -f -- <container>` whenever no verified
 *    live supervisor was signalled (e.g. crashed supervisor or reused PID).
 */
export function executePeerKillEntry(
    entry: KillPlanEntry,
    deps: ExecutePeerKillDeps = {},
): boolean {
    const killPid = deps.killPid ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
    const removeContainer = deps.removeContainer ?? ((containerName: string) => {
        const child = spawn("podman", ["rm", "-f", "--", containerName], { detached: true, stdio: "ignore" });
        child.unref();
    });
    const checkSupervisor = deps.isSupervisorProcess ?? defaultIsSupervisorProcess;

    const validContainer = entry.container && isValidPeerContainerName(entry.container) ? entry.container : null;
    if (entry.container && !validContainer) {
        log.warn("coms_peer_container_name_rejected", { name: entry.name, project: entry.project, container: entry.container });
    }

    let supervisorSignalled = false;
    if (entry.signalPid !== null && entry.signalPid > 0) {
        const verifiedSupervisor = entry.reason !== "supervisor" || !validContainer || checkSupervisor(entry.signalPid);
        if (!verifiedSupervisor) {
            log.warn("coms_peer_supervisor_pid_reused", {
                name: entry.name,
                project: entry.project,
                pid: entry.signalPid,
                container: validContainer,
            });
        } else {
            try {
                killPid(entry.signalPid, "SIGTERM");
                supervisorSignalled = entry.reason === "supervisor";
                if (!validContainer) return true;
            } catch (error: unknown) {
                log.warn("coms_peer_kill failed", {
                    name: entry.name,
                    pid: entry.signalPid,
                    container: validContainer,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    if (validContainer && !supervisorSignalled) {
        try {
            removeContainer(validContainer);
            log.info("coms_peer_container_remove_dispatched", { name: entry.name, project: entry.project, container: validContainer });
            return true;
        } catch (error: unknown) {
            log.warn("coms_peer_container_remove_failed", {
                name: entry.name,
                container: validContainer,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return supervisorSignalled;
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
    /** Override reload-handoff queue TTL in ms (primarily for isolated tests). */
    reloadQueueTtlMs?: number;
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
    let cachedHistoryReader: { path: string; reader: ReturnType<typeof createTailHistoryReader> } | null = null;
    let pidashUnsubscribe: (() => void) | null = null;
    let settingsChangedUnsubscribe: (() => void) | null = null;
    let podmanBuildPollTimer: ReturnType<typeof setInterval> | null = null;
    let podmanReadyClearTimer: ReturnType<typeof setTimeout> | null = null;
    /** In-flight peer revives keyed by `project::name`, tagged per launch token so an older exit never clears a newer claim. */
    const revivingPeers = new Map<string, { claimedAt: number; token: symbol }>();
    const REVIVE_CLAIM_TTL_MS = 45_000;

    const clearPodmanBuildTimers = (): void => {
        if (podmanBuildPollTimer) {
            clearInterval(podmanBuildPollTimer);
            podmanBuildPollTimer = null;
        }
        if (podmanReadyClearTimer) {
            clearTimeout(podmanReadyClearTimer);
            podmanReadyClearTimer = null;
        }
    };

    const emitPodmanBuildStatus = (
        ctx: any,
        payload: { state: "building" | "ready" | "error" | "idle"; targetTag: string | null; logPath?: string; error?: string | null },
    ): void => {
        try { pi.events.emit("pidash:podman-build-status", payload); } catch { /* pidash not loaded */ }
        if (!ctx?.hasUI || !isLiveExtensionCtx(ctx)) return;
        try {
            if (payload.state === "building") {
                ctx.ui.setStatus("7-podman-peer", ctx.ui.theme.fg("accent", "🐳 Building peer image…"));
            } else if (payload.state === "ready") {
                ctx.ui.setStatus("7-podman-peer", ctx.ui.theme.fg("success", "✓ Peer image ready"));
                if (podmanReadyClearTimer) clearTimeout(podmanReadyClearTimer);
                podmanReadyClearTimer = setTimeout(() => {
                    podmanReadyClearTimer = null;
                    try {
                        if (liveCtx?.hasUI && isLiveExtensionCtx(liveCtx)) liveCtx.ui.setStatus("7-podman-peer", undefined);
                    } catch { /* ignore */ }
                }, 8000);
                podmanReadyClearTimer.unref?.();
            } else {
                ctx.ui.setStatus("7-podman-peer", undefined);
            }
        } catch { /* ignore stale ctx */ }
    };

    const trackPodmanBuildProgress = (ctx: any, targetTag: string | null, logPath: string): void => {
        emitPodmanBuildStatus(ctx, { state: "building", targetTag, logPath });
        if (podmanBuildPollTimer) return;
        podmanBuildPollTimer = setInterval(() => {
            const snap = readBuildStatus();
            if (snap.state === "building") return;
            if (podmanBuildPollTimer) {
                clearInterval(podmanBuildPollTimer);
                podmanBuildPollTimer = null;
            }
            emitPodmanBuildStatus(liveCtx ?? ctx, {
                state: snap.state,
                targetTag: snap.targetTag ?? targetTag,
                logPath: snap.logPath || logPath,
                error: snap.error ?? null,
            });
        }, 5000);
        podmanBuildPollTimer.unref?.();
    };

    const maybePrewarmPodmanPeerImage = (cwd: string, ctx: any): void => {
        if (process.env.PI_COMS_SUPERVISED_PEER === "1" || process.env.PI_SUBAGENT_CHILD === "1") return;
        let mode: string;
        try {
            mode = String(getSetting(cwd, "coms_peer_sandbox") || "off");
        } catch {
            return;
        }
        if (mode !== "podman") return;
        // Run fully async off the session_start / settings event tick so interactive TUI never stalls.
        setImmediate(() => {
            const baseImage = String(getSetting(cwd, "coms_peer_sandbox_base_image") || "");
            void startBackgroundPeerImageBuildAsync({ baseImage: baseImage || undefined })
                .then((bg) => {
                    if (bg.status === "building") {
                        trackPodmanBuildProgress(ctx, bg.targetTag, bg.logPath);
                    } else if (bg.status === "error") {
                        log.warn("podman_prewarm_failed", { error: bg.error });
                    }
                })
                .catch((err: unknown) => {
                    log.warn("podman_prewarm_threw", { error: err instanceof Error ? err.message : String(err) });
                });
        });
    };

    const getTailHistoryReader = () => {
        const histPath = getRegistry().historyPath();
        if (!cachedHistoryReader || cachedHistoryReader.path !== histPath) {
            cachedHistoryReader = { path: histPath, reader: createTailHistoryReader(histPath) };
        }
        return cachedHistoryReader.reader;
    };

    const getRegistry = (cwdOverride?: string): ComsRegistry => {
        const dir = options.comsDir || resolveComsDir(cwdOverride ?? liveCtx?.cwd ?? process.cwd());
        if (!cachedRegistry || cachedRegistry.comsDir !== dir) {
            cachedRegistry = new ComsRegistry(dir);
        }
        return cachedRegistry;
    };

    const runtime = createComsPeerRuntime(pi, {
        deferred: true,
        inactiveMessage: "⚠️ coms not active. Call `coms_start` first.",
        getFlag: (name) => flagValues.get(name),
        comsDir: options.comsDir,
        sessionId: options.sessionId,
        allowSubagentChild: options.allowSubagentChild,
        registerSignalHandlers: options.registerSignalHandlers,
        reloadQueueTtlMs: options.reloadQueueTtlMs,
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

    let activeSessionKey: string | undefined;
    const syncComsActive = (nextActive: boolean, ctx?: any, peerName?: string): void => {
        const nextKey = ctx ? resolveBridgeSessionKey(ctx) : (activeSessionKey ?? resolveBridgeSessionKey(liveCtx));
        if (activeSessionKey && activeSessionKey !== nextKey) {
            setComsActive(false, activeSessionKey);
        }
        activeSessionKey = nextKey;
        setComsActive(nextActive, nextKey, nextActive ? peerName : undefined);
    };

    const ensurePidashRegistration = (): void => {
        if (pidashUnsubscribe) return;
        try {
            const registerWithPidash = () => {
                pi.events.emit("pidash:register-command", { name: "coms", handler: comsCmdHandler });
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

        if (evt?.reason !== "reload" && ctx?.mode === "tui") {
            maybePrewarmPodmanPeerImage(ctx?.cwd || process.cwd(), ctx);
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
                const savedSessionId =
                    typeof savedExtra?.comsSessionId === "string" && savedExtra.comsSessionId
                        ? savedExtra.comsSessionId
                        : undefined;
                try {
                    const self = await runtime.start(ctx, {
                        flags: mapToFlagOverrides(flagValues),
                        origin: savedOrigin,
                        ...(savedSessionId ? { sessionId: savedSessionId } : {}),
                        reload: true,
                    });
                    if (!activationVerified(self, process.platform, existsSync)) {
                        throw new Error("no peer socket was created during reload reactivation");
                    }
                    active = true;
                    if (self?.sessionId && extra.comsSessionId !== self.sessionId) {
                        extra = { ...extra, comsSessionId: self.sessionId };
                        persistCurrentState();
                    }
                    const peerName = String(flagValues.get("cname") ?? self?.name ?? "").trim() || undefined;
                    syncComsActive(true, ctx, peerName);
                    syncComsActiveTools(pi, gatedTools, true);
                } catch (err) {
                    active = false;
                    syncComsActive(false, ctx);
                    syncComsActiveTools(pi, gatedTools, false);
                    persistCurrentState();
                    const reloadProject = typeof savedFlags.project === "string" && savedFlags.project ? savedFlags.project : ownProject();
                    const reloadSessionId = savedSessionId ?? options.sessionId ?? (globalThis as any).__piConfigSessionId;
                    try {
                        await runtime.stop({
                            reason: "reload_failed",
                            project: reloadProject,
                            ...(typeof reloadSessionId === "string" && reloadSessionId ? { sessionId: reloadSessionId } : {}),
                        });
                    } catch { /* best-effort */ }
                    const msg = err instanceof Error ? err.message : String(err);
                    const error = err instanceof Error ? err : new Error(msg);
                    log.error("reload reactivation failed", msg, error);
                }
            } else {
                active = false;
                syncComsActive(false, ctx);
                syncComsActiveTools(pi, gatedTools, false);
            }
            return;
        }

        active = false;
        syncComsActive(false, ctx);
        syncComsActiveTools(pi, gatedTools, false);
        persistCurrentState();

        // `pi --coms …`: a headless peer boots itself, no slash command and no terminal.
        if (pi.getFlag("coms") === true) {
            const flagParts: string[] = [];
            for (const flagName of ["cname", "purpose", "project", "color"] as const) {
                const value = pi.getFlag(flagName);
                if (typeof value === "string" && value) flagParts.push(`--${flagName}`, value);
            }
            if (pi.getFlag("explicit") === true) flagParts.push("--explicit");
            log.info("coms autostart from --coms", { args: flagParts.join(" ") });
            const result = await activateComs(flagParts, ctx, "cli");
            if (!result.ok) log.warn("coms_autostart_failed", { message: result.message });
        }
    });

    pi.on("session_shutdown", async (evt: any, ctx: any) => {
        clearPodmanBuildTimers();
        if (settingsChangedUnsubscribe) {
            try { settingsChangedUnsubscribe(); } catch { /* ignore */ }
            settingsChangedUnsubscribe = null;
        }
        if (pidashUnsubscribe) {
            try { pidashUnsubscribe(); } catch { /* ignore */ }
            pidashUnsubscribe = null;
        }
        const shutdownKey = ctx ? resolveBridgeSessionKey(ctx) : activeSessionKey;
        try {
            await runtime.stop({ reason: evt?.reason });
        } catch (err) {
            log.warn("coms_shutdown_failed", { error: err instanceof Error ? err.message : String(err) });
        } finally {
            if (activeSessionKey) setComsActive(false, activeSessionKey);
            if (shutdownKey && shutdownKey !== activeSessionKey) setComsActive(false, shutdownKey);
            activeSessionKey = undefined;
        }
        // Keep persisted session state intact so `/reload` sees `active: true` and reactivates.
        active = false;
        revivingPeers.clear();
        cachedHistoryReader = null;
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
                await runtime.stop({ reason: "stale_claim" });
            } catch (error: unknown) {
                log.warn("coms_stale_claim_shutdown_threw", { error: error instanceof Error ? error.message : String(error) });
            }
            active = false;
            syncComsActive(false, ctx);
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
                syncComsActive(false, ctx);
                return { ok: false, message: "📡 coms start failed: no peer socket was created (see ~/.pi/logs/coms)." };
            }
            active = true;
            extra = { ...extra, origin: entry, ...(self?.sessionId ? { comsSessionId: self.sessionId } : {}) };
            const peerName = String(flagValues.get("cname") ?? self?.name ?? "").trim() || undefined;
            syncComsActive(true, ctx, peerName);
            syncComsActiveTools(pi, gatedTools, true);
            persistCurrentState();
            const name = peerName ?? "peer";
            const project = String(flagValues.get("project"));
            log.info("coms activated", { name, project, via: "tool-or-command" });
            return { ok: true, message: `📡 coms active — you are "${name}" on project "${project}". Peers: use coms_list.` };
        } catch (err: unknown) {
            syncComsActive(false, ctx);
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
            return { ok: false, code: "coms-inactive", reason: "coms is not active — activate with coms_start first." };
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

    const comsCmdHandler = async (_args: string, ctx: any) => {
        log.debug("coms_command_open", { hasUI: !!ctx?.hasUI, browser: isBrowserDispatch(ctx), active });
        if (!ctx?.hasUI || isBrowserDispatch(ctx)) {
            try { ctx?.ui?.notify?.(listPeers({ project: ownProject() }), "info"); } catch {}
            return;
        }
        await openComsPeersOverlay(ctx, {
            listPeers: (scope) =>
                filterRegistry(attachCreatedBy(getRegistry().readLiveRows()), {
                    project: scope === "all" ? undefined : ownProject(),
                }),
            listStoppedPeers: (scope) => {
                const liveAll = getRegistry().readLiveRows();
                const records = readSupervisionRecords();
                return listStoppedSupervisedPeers(records, liveAll, {
                    project: scope === "all" ? undefined : ownProject(),
                });
            },
            revivePeer: async (row) => {
                const key = `${row.project}::${row.name}`;
                const now = Date.now();
                const liveAll = getRegistry().readLiveRows(now);
                if (liveAll.some((live) => live.project === row.project && live.name === row.name)) {
                    revivingPeers.delete(key);
                    return { ok: false, reason: `Peer "${row.name}" is already running.` };
                }
                const claim = revivingPeers.get(key);
                if (claim !== undefined && now - claim.claimedAt < REVIVE_CLAIM_TTL_MS) {
                    log.debug("coms_peer_revive_already_claimed", { name: row.name, project: row.project });
                    return { ok: false, reason: `Peer "${row.name}" is already reviving.` };
                }
                // Check whether a live supervisor record without exit already owns this project::name.
                const existingLiveRec = readSupervisionRecords().find((rec) => {
                    if (rec?.cname !== row.name || (rec?.project ?? "default") !== row.project) return false;
                    if (rec.stoppedAt || rec.exitedAt || rec.failedAt) return false;
                    if (!Number.isInteger(rec.pid) || (rec.pid ?? 0) <= 0) return false;
                    try { process.kill(rec.pid, 0); return true; } catch { return false; }
                });
                if (existingLiveRec) {
                    return { ok: false, reason: `Supervisor for "${row.name}" is already starting (pid ${existingLiveRec.pid}).` };
                }
                const launchToken = Symbol(`revive:${key}`);
                revivingPeers.set(key, { claimedAt: now, token: launchToken });
                const releaseOwnClaim = () => {
                    if (revivingPeers.get(key)?.token === launchToken) {
                        revivingPeers.delete(key);
                    }
                };
                // Preserve the stopped peer's original sandbox mode explicitly ("off" for native peers,
                // never undefined which would flip a native peer into a container when global setting changes).
                const recordedSandbox: "off" | "podman" =
                    row.sandbox === "podman" || Boolean(row.container) ? "podman" : "off";
                const res = await spawnSupervisedPeer({
                    cname: row.name,
                    purpose: row.purpose,
                    project: row.project,
                    cwd: row.cwd || liveCtx?.cwd || process.cwd(),
                    session: row.piSessionId ?? undefined,
                    sandbox: recordedSandbox,
                    onSpawnFailure: releaseOwnClaim,
                });
                if (!res.ok) {
                    releaseOwnClaim();
                    return { ok: false, reason: res.message };
                }
                if (res.building) {
                    releaseOwnClaim();
                    return { ok: false, reason: res.message };
                }
                return {
                    ok: true,
                    pid: res.pid,
                    message: `Reviving "${row.name}" (pid ${res.pid ?? "?"})${row.piSessionId ? " · session resumed" : ""} — registers in ~20-30s`,
                };
            },
            listActivityEvents: (scope) => {
                const allLive = attachCreatedBy(getRegistry().readLiveRows());
                const allRecords = readSupervisionRecords();
                const allStopped = listStoppedSupervisedPeers(allRecords, allLive);
                const project = scope === "all" ? undefined : ownProject();
                const livePeers = filterRegistry(allLive, { project });
                const stoppedPeers = listStoppedSupervisedPeers(allRecords, allLive, { project });
                const historyRecords = getTailHistoryReader().readRecent(200, project);
                return collectComsActivityEvents({
                    historyRecords,
                    livePeers,
                    stoppedPeers,
                    allKnownPeers: [...allLive, ...allStopped],
                    projectFilter: project ?? null,
                });
            },
            // #1083: the drilldown asks the PEER for its own state. No reply inside the
            // timeout is `unknown` — never a filesystem scan of another process.
            describePeer: (row) => requestDescribe(row.endpoint),
            killPeer: (row) => killPeers({ name: row.name, project: row.project }).text,
            killAll: (scope) => {
                const resolved = resolveKillScope(
                    { all: true, project: scope === "all" ? "*" : ownProject() },
                    ownProject(),
                    log,
                );
                if (resolved.refused) return resolved.refused;
                return killPeers(resolved).text;
            },
            tellPeer: (request) => tellPeer(request.target, request.prompt, request.project, request.expectedEndpoint),
            openQueue: () => runtime.openQueueOverlay("", ctx),
        });
    };

    pi.registerCommand("coms", {
        description: "Open the coms peers TUI overlay (r revive, 1/2 activity log, f scope, q queue, m message, x/X kill)",
        handler: comsCmdHandler,
    });

    // ── Agent-facing activation ──────────────────────────────────────────
    try {
        pi.registerTool({
            name: "coms_start",
            label: "coms start",
            exposure: "codemode",
            namespace: TOOL_NAMESPACES.coms,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
            exposure: "codemode",
            namespace: TOOL_NAMESPACES.coms,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
            description: "Stop coms for THIS session: stop advertising this peer and drop the coms tools.",
            defaultActive: false,
            parameters: Type.Object({}),
            async execute(_id?: string, _params?: any, _signal?: any, _onUpdate?: any, ctx?: any) {
                if (!active) return { content: [{ type: "text" as const, text: "coms is not active." }], details: { ok: true, active: false } };
                try { await runtime.stop({ reason: "stop" }); } catch (e: unknown) { log.warn("coms_stop shutdown threw", e instanceof Error ? e.message : String(e)); }
                active = false;
                syncComsActive(false, ctx);
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

    const attachCreatedBy = (rows: RegistryRow[], records = readSupervisionRecords()): RegistryRow[] =>
        attachSupervisionMeta(rows, records);

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

    /** Record a peer's piSessionId into its supervisor state JSON before shutdown so `r` revive can resume it. */
    const persistPeerSessionForRevive = (row: RegistryRow): void => {
        if (!row.piSessionId) return;
        const envDir = (process.env.PI_COMS_DIR || "").trim();
        const dirs = [getRegistry().peersDir(), ...(envDir ? [path.join(envDir, "peers")] : [])];
        for (const dir of dirs) {
            const statePath = path.join(dir, `${row.name}@${row.project}.json`);
            if (!existsSync(statePath)) continue;
            try {
                const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    parsed.piSessionId = row.piSessionId;
                    writeFileSync(statePath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
                    log.debug("coms_peer_session_persisted_for_revive", { name: row.name, project: row.project });
                    return;
                }
            } catch (err: unknown) {
                log.debug("coms_peer_session_persist_failed", {
                    statePath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    };

    const spawnSupervisedPeer = async (params: {
        cname?: string | null;
        purpose?: string | null;
        project?: string | null;
        cwd?: string | null;
        session?: string | null;
        sandbox?: "off" | "podman" | null;
        onSpawnFailure?: () => void;
    }): Promise<{ ok: true; pid: number | null; building?: boolean; message: string } | { ok: false; pid: null; message: string }> => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const supervisor = [
            path.join(here, "..", "..", "scripts", "coms-peer-supervisor.mjs"),
            path.join(resolvePiAgentDir(), "npm", "node_modules", "pi-orchestrator-config", "scripts", "coms-peer-supervisor.mjs"),
            path.join(liveCtx?.cwd || process.cwd(), "scripts", "coms-peer-supervisor.mjs"),
        ].map(candidate => path.resolve(candidate)).find(candidate => existsSync(candidate)) ?? "";
        const resolvedProject = params.project ?? ownProject();
        const resolvedCwd = params.cwd ?? (liveCtx?.cwd || process.cwd());
        let effectiveSandbox: "off" | "podman" = "off";
        if (params.sandbox === "off" || params.sandbox === "podman") {
            effectiveSandbox = params.sandbox;
        } else {
            try {
                const configured = getSetting(resolvedCwd, "coms_peer_sandbox");
                if (configured === "podman") effectiveSandbox = "podman";
            } catch { /* default off */ }
        }

        let podmanImage: string | undefined;
        let podmanCpus: number | undefined;
        let podmanMemory: string | undefined;
        let fallbackNote = "";

        if (effectiveSandbox === "podman") {
            const baseImage = String(getSetting(resolvedCwd, "coms_peer_sandbox_base_image") || "");
            const imgRes = await resolveImageForSpawnAsync({ baseImage: baseImage || undefined });
            if (imgRes.action === "error") {
                log.warn("coms_peer_spawn_podman_error", { cname: params.cname, error: imgRes.error });
                return { ok: false, pid: null, message: `coms peer spawn (podman): ${imgRes.error}` };
            }
            if (imgRes.action === "building") {
                trackPodmanBuildProgress(liveCtx, imgRes.targetTag, imgRes.logPath);
                log.info("coms_peer_spawn_podman_building", { cname: params.cname, targetTag: imgRes.targetTag, logPath: imgRes.logPath });
                return {
                    ok: true,
                    pid: null,
                    building: true,
                    message: `🐳 Building rootless Podman peer image (${imgRes.targetTag}) in background — first build takes ~5–10 min. Monitor: ${imgRes.logPath}. Retry coms_peer_spawn once ready, or pass sandbox: "off" for a native peer.`,
                };
            }
            podmanImage = imgRes.imageTag ?? undefined;
            podmanCpus = Number(getSetting(resolvedCwd, "coms_peer_sandbox_cpus")) || 4;
            podmanMemory = String(getSetting(resolvedCwd, "coms_peer_sandbox_memory") || "4g");
            if (imgRes.usingFallback) {
                trackPodmanBuildProgress(liveCtx, imgRes.targetTag, imgRes.logPath);
                fallbackNote = ` (booted immediately on cached ${imgRes.imageTag} while ${imgRes.targetTag} builds in background)`;
            }
        }

        const plan = buildPeerSpawn(supervisor, {
            cname: params.cname,
            purpose: params.purpose,
            project: resolvedProject,
            cwd: resolvedCwd,
            session: params.session,
            ...(effectiveSandbox === "podman" ? {
                sandbox: "podman" as const,
                image: podmanImage,
                cpus: podmanCpus,
                memory: podmanMemory,
            } : {}),
        }, log);
        if (!plan.ok) {
            log.warn("coms_peer_spawn_rejected", { message: plan.message });
            return { ok: false, pid: null, message: plan.message };
        }
        try {
            const env = withPropagatedPiAgentDirEnv(process.env);
            const configuredComsDir = getRegistry().comsDir;
            if (configuredComsDir) env.PI_COMS_DIR = configuredComsDir;
            const child = spawn(plan.command[0]!, plan.command.slice(1), { detached: true, stdio: "ignore", env });
            child.on("error", (error: unknown) => {
                params.onSpawnFailure?.();
                log.error("coms_peer_spawn_async_error", { cname: params.cname, error: error instanceof Error ? error.message : String(error) });
            });
            child.on("exit", () => {
                params.onSpawnFailure?.();
            });
            child.unref();
            log.info("coms_peer_spawned", {
                cname: params.cname,
                pid: child.pid ?? null,
                sandbox: effectiveSandbox,
                args: plan.command.slice(2).join(" "),
            });
            const sandboxLabel = effectiveSandbox === "podman" ? " [rootless Podman sandbox]" : "";
            return {
                ok: true,
                pid: child.pid ?? null,
                message: `Started supervisor for peer "${params.cname}"${sandboxLabel} (pid ${child.pid ?? "?"})${fallbackNote}. The peer registers in ~20-30s — check coms_peers; if it never appears, read ~/.pi/logs/coms-peers/${params.cname}@${resolvedProject}.log`,
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            log.error("coms_peer_spawn_failed", { cname: params.cname, error: message });
            return { ok: false, pid: null, message: `coms peer spawn failed: ${message}` };
        }
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
            if (entry.signalPid === null && !entry.container) continue;
            const liveRow = rows.find((r) => r.name === entry.name && r.project === entry.project);
            if (liveRow) persistPeerSessionForRevive(liveRow);
            if (executePeerKillEntry(entry)) {
                killed.push(entry.container ? `${entry.name}·${entry.project} (${entry.container})` : `${entry.name}·${entry.project}`);
                log.info("coms_peer_kill", {
                    name: entry.name,
                    project: entry.project,
                    pid: entry.signalPid,
                    container: entry.container ?? null,
                    via: entry.reason,
                });
            }
        }
        if (killed.length === 0) return { text: "Nothing to kill: no supervised peer matched (see logs for why).", killed: 0 };
        return { text: `Stopped: ${killed.join(", ")}`, killed: killed.length };
    };

    try {
        pi.registerTool({
            name: "coms_peers",
            label: "coms peers",
            exposure: "codemode",
            namespace: TOOL_NAMESPACES.coms,
            annotations: READ_ONLY_LOCAL_ANNOTATIONS,
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
            exposure: "codemode",
            namespace: TOOL_NAMESPACES.coms,
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            description: "Spawn a supervised `pi --coms` peer process (native host process or opt-in rootless Podman container via sandbox:'podman'; registers in ~20-30s). Stop it with coms_peer_kill when done.",
            parameters: Type.Object({
                cname: Type.String({ description: "Peer name (letters, digits, dot, dash, underscore)" }),
                purpose: Type.Optional(Type.String({ description: "One-line peer purpose" })),
                project: Type.Optional(Type.String({ description: "Project namespace (default: this project)" })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: this cwd)" })),
                sandbox: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("podman")], {
                    description: "Runtime sandbox override: 'off' (native host process) or 'podman' (isolated rootless Podman container). Defaults to coms_peer_sandbox setting (default: 'off').",
                })),
            }),
            async execute(_id: string, params: any) {
                const res = await spawnSupervisedPeer({
                    cname: params?.cname,
                    purpose: params?.purpose,
                    project: params?.project ?? ownProject(),
                    cwd: params?.cwd ?? (liveCtx?.cwd || process.cwd()),
                    sandbox: params?.sandbox,
                });
                return {
                    content: [{ type: "text" as const, text: res.message }],
                    details: { ok: res.ok, pid: res.pid, ...(res.ok && res.building ? { building: true } : {}) },
                };
            },
        });
        pi.registerTool({
            name: "coms_peer_kill",
            label: "coms peer kill",
            exposure: "codemode",
            namespace: TOOL_NAMESPACES.coms,
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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

    // Trigger non-blocking background Podman image pre-warm when user enables coms_peer_sandbox="podman".
    try {
        const unsub = pi.events?.on?.("orchestrator:settings-changed", (data: unknown) => {
            const evt = data as { key?: string; cwd?: string } | null;
            if (evt?.key === "coms_peer_sandbox" || evt?.key === "coms_peer_sandbox_base_image") {
                maybePrewarmPodmanPeerImage(evt.cwd || liveCtx?.cwd || process.cwd(), liveCtx);
            }
        });
        if (typeof unsub === "function") settingsChangedUnsubscribe = unsub;
    } catch { /* ignore */ }

    // Single pidash command registration for /coms.
    ensurePidashRegistration();

    return { runtime, getRegistry };
}
