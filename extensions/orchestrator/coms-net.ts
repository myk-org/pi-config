/**
 * coms-net.ts — On-demand networked agent communication wrapper
 *
 * Wraps the upstream coms-net extension (upstream-coms/coms-net.ts) to support
 * activation via /coms-net command instead of auto-start on session_start.
 *
 * Auto-manages the coms-net hub server lifecycle:
 * - Checks if a server is already running (via server.json health check)
 * - Spawns one with Bun if not (port 0 = OS picks free port)
 * - Server writes server.json + server.secret.json for client auto-discovery
 * - Server is cleaned up on session shutdown
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
import { parseFlags, createDeferredProxy, persistState, type DeferredUpstream } from "./coms-shared.js";
import upstreamComsNetInit from "./upstream-coms/coms-net.js";

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
const SERVER_STARTUP_TIMEOUT_MS = 10_000;
const SERVER_POLL_INTERVAL_MS = 300;

function serverJsonPath(project: string): string {
    return path.join(COMS_NET_DIR, "projects", project, "server.json");
}

function readServerJson(project: string): { local_url?: string; pid?: number } | null {
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
        path.dirname(new URL(import.meta.url).pathname),
        "upstream-coms", "coms-net-server.ts",
    );
}

async function ensureServerRunning(
    project: string,
    log: (msg: string) => void,
): Promise<boolean> {
    if (await isServerHealthy(project)) {
        log("server already running");
        return true;
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
            PI_COMS_NET_PORT: "0",
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
    if (sj?.pid && Number.isInteger(sj.pid) && sj.pid > 0) {
        try {
            process.kill(sj.pid, "SIGTERM");
            log(`sent SIGTERM to server pid ${sj.pid}`);
        } catch {
            // already dead
        }
    }
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
    let activeProject = "default";
    let serverStartedByUs = false;

    const log = (msg: string) => {
        try {
            pi.appendEntry("coms-net-log", { event: "wrapper", ts: new Date().toISOString(), msg });
        } catch {}
    };

    const PERSIST_KEY = "coms-net-state";

    const proxyPi = createDeferredProxy(
        pi, state, "⚠️ coms-net not active. Run `/coms-net start` first.", PERSIST_KEY,
    );

    upstreamComsNetInit(proxyPi as any);

    // Don't auto-kill the server on session shutdown — other sessions may
    // be connected. The server has its own stale detection and cleanup.
    // User can explicitly stop it with /coms-net server-stop.

    pi.registerCommand("coms-net", {
        description: "Networked agent communication: /coms-net start [--name X --purpose Y --project Z --color #HEX] | stop | status | server-stop",
        handler: async (args: string, ctx: any) => {
            const trimmed = (args || "").trim();
            const parts = trimmed.split(/\s+/);
            const subcommand = parts[0] || "status";

            if (subcommand === "start") {
                if (state.active) {
                    try { ctx.ui.notify("📡 coms-net already active", "warning"); } catch {}
                    return;
                }
                parseFlags(parts.slice(1), state.flagValues);
                const project = (state.flagValues.get("project") as string) || "default";
                if (!isValidProject(project)) {
                    try { ctx.ui.notify("📡 coms-net: invalid project name", "error"); } catch {}
                    return;
                }
                activeProject = project;

                if (!state.capturedSessionStart) {
                    try { ctx.ui.notify("📡 coms-net: internal error — no session handler captured", "error"); } catch {}
                    return;
                }

                // Auto-start server if not running
                const alreadyRunning = await isServerHealthy(project);
                if (!alreadyRunning) {
                    try { ctx.ui.notify("📡 Starting coms-net server...", "info"); } catch {}
                    const started = await ensureServerRunning(project, log);
                    if (!started) {
                        try { ctx.ui.notify("📡 coms-net: failed to start server. Is Bun installed?", "error"); } catch {}
                        return;
                    }
                    serverStartedByUs = true;
                }

                try {
                    await state.capturedSessionStart({}, ctx);
                    state.active = true;
                    persistState(pi, PERSIST_KEY, state);
                    const sj = readServerJson(project);
                    try { ctx.ui.notify(`📡 coms-net active — server at ${sj?.local_url || "unknown"}`, "info"); } catch {}
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms-net start failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "stop") {
                if (!state.active) {
                    try { ctx.ui.notify("📡 coms-net not active", "info"); } catch {}
                    return;
                }
                if (state.capturedSessionShutdown) {
                    try { await state.capturedSessionShutdown(); } catch {}
                }
                state.active = false;
                persistState(pi, PERSIST_KEY, state);
                try { ctx.ui.notify("📡 coms-net stopped", "info"); } catch {}
            } else if (subcommand === "server-stop") {
                killServer(activeProject, log);
                serverStartedByUs = false;
                try { ctx.ui.notify("📡 coms-net server stopped", "info"); } catch {}
            } else if (subcommand === "status") {
                const project = (state.flagValues.get("project") as string) || "default";
                if (!isValidProject(project)) {
                    try { ctx.ui.notify("📡 coms-net: invalid project name", "error"); } catch {}
                    return;
                }
                const serverUp = await isServerHealthy(project);
                const sj = readServerJson(project);
                let msg = `📡 coms-net: ${state.active ? "active" : "inactive"}\n`;
                msg += `Server: ${serverUp ? `running at ${sj?.local_url}` : "not running"}\n`;
                if (serverStartedByUs) msg += "(server started by this session)";
                try { ctx.ui.notify(msg, "info"); } catch {}
            } else {
                try { ctx.ui.notify(`📡 coms-net: unknown subcommand "${subcommand}". Use: start | stop | status | server-stop`, "warning"); } catch {}
            }
        },
    });
}
