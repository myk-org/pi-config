/**
 * coms-net-wrapper.ts — On-demand networked agent communication wrapper
 *
 * Wraps the networked coms extension (coms-net.ts) to support
 * activation via /coms-net command instead of auto-start on session_start.
 *
 * Auto-manages the coms-net hub server lifecycle:
 * - Checks if a server is already running (via server.json health check)
 * - Spawns one with Bun if not (port 0 = OS picks free port)
 * - Server writes server.json + server.secret.json for client auto-discovery
 * - Server is cleaned up on session shutdown
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

function fuzzy(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
    if (!query.trim()) return items.length > 0 ? items : null;
    const result = fuzzyFilter(items, query, i => `${i.label} ${i.description || ""}`);
    return result.length > 0 ? result : null;
}
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFlags, tokenizeArgs, createDeferredProxy, persistState, pruneStaleRegistry, type DeferredUpstream } from "./coms-shared.js";
import upstreamComsNetInit from "./coms-net.js";

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
const SERVER_STARTUP_TIMEOUT_MS = 10_000;
const SERVER_POLL_INTERVAL_MS = 300;

function serverJsonPath(project: string): string {
    return path.join(COMS_NET_DIR, "projects", project, "server.json");
}

function readServerJson(project: string): { local_url?: string; public_url?: string; host?: string; port?: number; pid?: number } | null {
    const p = serverJsonPath(project);
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
        return null;
    }
}

async function isServerHealthy(project: string): Promise<boolean> {
    const sj = readServerJson(project);
    if (!sj?.local_url) return false;
    try {
        const url = new URL(sj.local_url);
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
    } catch { return false; }
    try {
        const resp = await fetch(`${sj.local_url}/health`, { signal: AbortSignal.timeout(2000) });
        if (!resp.ok) return false;
        const body = await resp.json();
        return body?.ok === true;
    } catch {
        return false;
    }
}

function findBun(): string | null {
    try {
        const p = execSync("which bun", { encoding: "utf-8" }).trim();
        return p || null;
    } catch {
        return null;
    }
}

function getServerScriptPath(): string {
    return path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "coms-net-server.ts",
    );
}

async function ensureServerRunning(
    project: string,
    log: (msg: string) => void,
    options?: { port?: string; host?: string },
): Promise<boolean> {
    // If port/host explicitly requested, check if running server matches
    if (await isServerHealthy(project)) {
        const sj = readServerJson(project);
        const wantPort = options?.port || process.env.PI_COMS_NET_PORT;
        const wantHost = options?.host || process.env.PI_COMS_NET_HOST;
        const needRestart = (wantPort && sj?.port !== Number(wantPort)) ||
                            (wantHost && sj?.host !== wantHost);
        if (needRestart) {
            log(`server running but port/host mismatch — restarting`);
            killServer(project, log);
            await new Promise(r => setTimeout(r, 1000));
        } else {
            log("server already running");
            return true;
        }
    }

    const bunPath = findBun();
    if (!bunPath) {
        log("bun not found — cannot start coms-net server");
        return false;
    }

    const scriptPath = getServerScriptPath();
    if (!fs.existsSync(scriptPath)) {
        log(`server script not found: ${scriptPath}`);
        return false;
    }

    const projDir = path.join(COMS_NET_DIR, "projects", project);
    fs.mkdirSync(projDir, { recursive: true });

    // Binds to 127.0.0.1 by default (safe). For LAN access, user sets
    // PI_COMS_NET_AUTH_TOKEN and PI_COMS_NET_HOST=0.0.0.0 in their env.
    const logFile = path.join(projDir, "server.log");
    log(`spawning coms-net server: ${bunPath} ${scriptPath}`);

    const outFd = fs.openSync(logFile, "a");
    const errFd = fs.openSync(logFile, "a");
    const child = spawn(bunPath, [scriptPath], {
        detached: true,
        stdio: ["ignore", outFd, errFd],
        env: {
            ...process.env,
            PI_COMS_NET_PROJECT: project,
            PI_COMS_NET_PORT: options?.port || process.env.PI_COMS_NET_PORT || "0",
            ...(options?.host ? { PI_COMS_NET_HOST: options.host } : {}),
        },
    });
    child.unref();
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}

    const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, SERVER_POLL_INTERVAL_MS));
        if (await isServerHealthy(project)) {
            log("server started successfully");
            return true;
        }
    }

    log("server failed to start within timeout");
    return false;
}

function killServer(project: string, log: (msg: string) => void): void {
    const sj = readServerJson(project);
    if (!sj?.pid || !Number.isInteger(sj.pid) || sj.pid <= 0) return;
    const pid = sj.pid;
    try {
        process.kill(pid, "SIGTERM");
        log(`sent SIGTERM to server pid ${pid}`);
    } catch {
        log(`server pid ${pid} already dead`);
        return;
    }
    // Wait up to 3s for clean exit, then SIGKILL
    let waited = 0;
    const check = () => {
        try { process.kill(pid, 0); } catch { return; } // dead
        waited += 100;
        if (waited >= 3000) {
            try { process.kill(pid, "SIGKILL"); log(`sent SIGKILL to server pid ${pid}`); } catch (e: any) { log(`SIGKILL to pid ${pid} failed: ${e?.message}`); }
            return;
        }
        setTimeout(check, 100).unref();
    };
    setTimeout(check, 100).unref();
}

function isValidProject(project: string): boolean {
    return !/[\/\\]|\.\./.test(project);
}

export function registerComsNet(pi: ExtensionAPI) {
    const state: DeferredUpstream = {
        capturedSessionStart: null,
        capturedSessionShutdown: null,
        flagValues: new Map(),
        active: false,
    };
    let activeProject = "";

    function getProject(ctx?: any): string {
        // When ctx provides cwd, derive from it to avoid stale cache after resume/dir-change
        if (ctx?.cwd) {
            const proj = ctx.cwd.replace(/^[\\/]/, "").replace(/[\\/]/g, "__");
            if (proj) return proj;
        }
        if (activeProject) return activeProject;
        const fromFlags = state.flagValues.get("project") as string;
        if (fromFlags) return fromFlags;
        const cwd = process.cwd() || "";
        const proj = cwd.replace(/^[\\/]/, "").replace(/[\\/]/g, "__");
        if (!proj) throw new Error("coms-net: cannot determine project — no cwd available");
        return proj;
    }
    let serverStartedByUs = false;

    function persist() {
        state.extra = { serverStartedByUs, activeProject: getProject() };
        // Don't persist auth token to disk — security sensitive
        const authToken = state.flagValues.get('auth-token');
        if (authToken !== undefined) state.flagValues.delete('auth-token');
        try {
            persistState(pi, PERSIST_KEY, state);
        } finally {
            if (authToken !== undefined) state.flagValues.set('auth-token', authToken);
        }
    }

    const log = (msg: string) => {
        try {
            pi.appendEntry("coms-net-log", { event: "wrapper", ts: new Date().toISOString(), msg });
        } catch (e: any) { console.debug("[coms-net] log append failed:", e?.message || e); }
    };

    const PERSIST_KEY = "coms-net-state";

    const proxyPi = createDeferredProxy(
        pi, state, "⚠️ coms-net not active. Run `/coms-net start` first.", PERSIST_KEY,
    );

    upstreamComsNetInit(proxyPi as any);

    // Prune stale registry entries on session start (cleans up after crashes)
    // Also reset coms-net state on fresh starts (non-reload) to clear phantom peers
    pi.on("session_start", (evt: any) => {
        try { pruneStaleRegistry(); } catch (e: any) { console.debug("[coms-net] stale cleanup:", e?.message?.slice(0, 100)); }
        if (evt?.reason !== "reload") {
            state.active = false;
            state.flagValues.delete("auth-token"); // Don't persist auth tokens
            state.extra = {}; // Clear server flags (serverStartedByUs, activeProject, etc.)
            persistState(pi, PERSIST_KEY, state);
        }
    });

    // Restore serverStartedByUs after reload — MUST be registered after
    // createDeferredProxy/upstreamComsNetInit so the proxy hydrates state.extra first
    pi.on("session_start", (event: any) => {
        if (event?.reason !== "reload") return;
        if (state.extra?.serverStartedByUs) {
            serverStartedByUs = true;
        }
        if (state.extra?.activeProject) {
            activeProject = state.extra.activeProject;
        }
    });

    // Don't auto-kill the server on session shutdown — other sessions may
    // be connected. The server has its own stale detection and cleanup.


    pi.registerCommand("coms-net", {
        description: "Networked agent communication: /coms-net start | connect | disconnect | stop | status",
        getArgumentCompletions: (prefix: string) => {
            const tokens = prefix.trim().split(/\s+/).filter(Boolean);
            const atNextToken = prefix.endsWith(" ") || tokens.length === 0;
            const lastPart = atNextToken ? "" : tokens[tokens.length - 1];
            const completed = atNextToken ? tokens : tokens.slice(0, -1);
            const base = atNextToken ? prefix : prefix.slice(0, prefix.length - lastPart.length);
            const mk = (items: {v: string; l: string; d: string}[]) =>
                fuzzy(items.map(i => ({ value: base + i.v, label: i.l, description: i.d })), lastPart);

            if (completed.length === 0) {
                return mk([
                    { v: "start", l: "start", d: "Start local server and connect" },
                    { v: "connect", l: "connect", d: "Connect to a running server" },
                    { v: "disconnect", l: "disconnect", d: "Disconnect from server (keep server running)" },
                    { v: "stop", l: "stop", d: "Stop coms-net + kill server" },
                    { v: "status", l: "status", d: "Show coms-net + server status" },

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
                    { v: "--port ", l: "--port", d: "Server port" },
                    { v: "--host ", l: "--host", d: "Server bind address (e.g. 0.0.0.0)" },
                ].filter(f => !used.has(f.v.trim())));
            }
            if (completed[0] === "connect" && (lastPart.startsWith("-") || lastPart === "")) {
                const used = new Set(completed.filter(p => p.startsWith("--")));
                return mk([
                    { v: "--cname ", l: "--cname", d: "Agent name" },
                    { v: "--purpose ", l: "--purpose", d: "Agent purpose" },
                    { v: "--project ", l: "--project", d: "Project namespace" },
                    { v: "--color ", l: "--color", d: "Hex color #RRGGBB" },
                    { v: "--explicit", l: "--explicit", d: "Hide from auto-discovery" },
                    { v: "--url ", l: "--url", d: "Hub server URL" },
                    { v: "--auth-token ", l: "--auth-token", d: "Bearer token for the hub" },
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
                    // Check if server is actually still running
                    if (await isServerHealthy(getProject(ctx))) {
                        try { ctx.ui.notify("📡 coms-net already active", "warning"); } catch {}
                        return;
                    }
                    // Server died — reset state and allow restart
                    state.active = false;
                    serverStartedByUs = false;
                }
                state.flagValues = new Map();
                parseFlags(parts.slice(1), state.flagValues);

                if (state.flagValues.has("name")) {
                    try { ctx.ui.notify("📡 coms-net: use --cname instead of --name", "error"); } catch {}
                    return;
                }
                // Default project to cwd so sessions in different dirs are isolated
                if (!state.flagValues.has("project")) {
                    const cwd = ctx.cwd || "";
                    const proj = cwd.replace(/^[\\/]/,"").replace(/[\\/]/g, "__");
                    if (!proj) {
                        try { ctx.ui.notify("📡 coms-net: cannot start from /. Run from a project directory.", "error"); } catch {}
                        return;
                    }
                    state.flagValues.set("project", proj);
                }
                const project = state.flagValues.get("project") as string;
                if (!isValidProject(project)) {
                    try { ctx.ui.notify("📡 coms-net: invalid project name", "error"); } catch {}
                    return;
                }
                activeProject = project;

                if (!state.capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms-net: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                const port = state.flagValues.get("port") as string | undefined;
                const host = state.flagValues.get("host") as string | undefined;

                // Auto-start server, or restart if port/host mismatch
                const alreadyRunning = await isServerHealthy(project);
                if (alreadyRunning) {
                    // Check if running server matches requested port/host
                    const sj = readServerJson(project);
                    const wantPort = port || process.env.PI_COMS_NET_PORT;
                    const wantHost = host || process.env.PI_COMS_NET_HOST;
                    const mismatch = (wantPort && sj?.port !== Number(wantPort)) ||
                                     (wantHost && sj?.host !== wantHost);
                    if (mismatch) {
                        log(`server port/host mismatch — restarting (want ${wantHost || "*"}:${wantPort || "*"}, have ${sj?.host}:${sj?.port})`);
                        killServer(project, log);
                        await new Promise(r => setTimeout(r, 1000));
                        try { ctx.ui.notify("📡 Restarting coms-net server (port/host changed)...", "info"); } catch {}
                        const started = await ensureServerRunning(project, log, { port, host });
                        if (!started) {
                            try { ctx.ui.notify("📡 coms-net: failed to restart server.", "error"); } catch {}
                            return;
                        }
                        serverStartedByUs = true;
                    }
                } else {
                    try { ctx.ui.notify("📡 Starting coms-net server...", "info"); } catch {}
                    const started = await ensureServerRunning(project, log, { port, host });
                    if (!started) {
                        try { ctx.ui.notify("📡 coms-net: failed to start server. Is Bun installed?", "error"); } catch {}
                        return;
                    }
                    serverStartedByUs = true;
                }

                try {
                    await state.capturedSessionStart({}, ctx);
                    state.active = true;
                    serverStartedByUs = true;
                    persist();
                    const sj = readServerJson(project);
                    const serverAddr = (sj?.host && sj?.port ? `http://${sj.host}:${sj.port}` : sj?.public_url || sj?.local_url) || "unknown";
                    try { ctx.ui.notify(`📡 coms-net active — server at ${serverAddr}`, "info"); } catch {}
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms-net start failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "connect") {
                if (state.active) {
                    try { ctx.ui.notify("📡 coms-net already active", "warning"); } catch {}
                    return;
                }
                state.flagValues = new Map();
                parseFlags(parts.slice(1), state.flagValues);

                if (state.flagValues.has("name")) {
                    try { ctx.ui.notify("📡 coms-net: use --cname instead of --name", "error"); } catch {}
                    return;
                }
                // Default project to cwd so sessions in different dirs are isolated
                if (!state.flagValues.has("project")) {
                    const cwd = ctx.cwd || "";
                    const proj = cwd.replace(/^[\\/]/,"").replace(/[\\/]/g, "__");
                    if (!proj) {
                        try { ctx.ui.notify("📡 coms-net: cannot connect from /. Run from a project directory.", "error"); } catch {}
                        return;
                    }
                    state.flagValues.set("project", proj);
                }
                const project = state.flagValues.get("project") as string;
                if (!isValidProject(project)) {
                    try { ctx.ui.notify("📡 coms-net: invalid project name", "error"); } catch {}
                    return;
                }
                activeProject = project;

                if (!state.capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms-net: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                // Map --url to server-url for upstream compatibility
                if (state.flagValues.has("url")) {
                    state.flagValues.set("server-url", state.flagValues.get("url"));
                }
                const serverUrl = state.flagValues.get("server-url") as string | undefined;
                try {
                    await state.capturedSessionStart({}, ctx);
                    state.active = true;
                    persist();
                    serverStartedByUs = false;
                    const displayUrl = serverUrl || "local server";
                    try { ctx.ui.notify(`📡 coms-net active — connected to ${displayUrl}`, "info"); } catch {}
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms-net connect failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "disconnect") {
                if (!state.active) {
                    try { ctx.ui.notify("📡 coms-net not active", "info"); } catch {}
                    return;
                }
                if (serverStartedByUs) {
                    try { ctx.ui.notify("📡 coms-net: you started the server — use /coms-net stop instead", "warning"); } catch {}
                    return;
                }
                if (state.capturedSessionShutdown) {
                    try { await state.capturedSessionShutdown(); } catch {}
                }
                state.active = false;
                persist();
                try { ctx.ui.notify("📡 coms-net disconnected", "info"); } catch {}
            } else if (subcommand === "stop") {
                if (!state.active) {
                    try { ctx.ui.notify("📡 coms-net not active", "info"); } catch {}
                    return;
                }
                if (!serverStartedByUs) {
                    try { ctx.ui.notify("📡 coms-net: you didn't start the server — use /coms-net disconnect instead", "warning"); } catch {}
                    return;
                }
                if (state.capturedSessionShutdown) {
                    try { await state.capturedSessionShutdown(); } catch {}
                }
                state.active = false;
                persist();
                // User explicitly stopped — kill server unconditionally
                killServer(getProject(), log);
                serverStartedByUs = false;
                try { ctx.ui.notify("📡 coms-net stopped", "info"); } catch {}
            } else if (subcommand === "status") {
                const project = getProject(ctx);
                if (!isValidProject(project)) {
                    try { ctx.ui.notify("📡 coms-net: invalid project name", "error"); } catch {}
                    return;
                }
                const serverUp = await isServerHealthy(project);
                const sj = readServerJson(project);
                let msg = `📡 coms-net: ${state.active ? "active" : "inactive"}\n`;
                msg += `Server: ${serverUp ? `running at ${sj?.host && sj?.port ? `http://${sj.host}:${sj.port}` : sj?.public_url || sj?.local_url}` : "not running"}\n`;
                if (serverStartedByUs) msg += "(server started by this session)";
                try { ctx.ui.notify(msg, "info"); } catch {}
            } else {
                try { ctx.ui.notify(`📡 coms-net: unknown subcommand "${subcommand}". Use: start | connect | disconnect | stop | status`, "warning"); } catch {}
            }
        },
    });

    // Kill server on session shutdown if we started it and no other peers are connected
    pi.on("session_shutdown", (event: any) => {
        if (!serverStartedByUs) return;
        // Don't kill server on reload — it will be reused after reload
        if (event?.reason === "reload") return;
        killServer(getProject(), log);
        log("server killed on shutdown (we started it)");
    });
}
