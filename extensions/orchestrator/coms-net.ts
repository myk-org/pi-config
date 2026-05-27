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
import * as crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
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
    // Already running?
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

    // Ensure project dir exists
    const projDir = path.join(COMS_NET_DIR, "projects", project);
    fs.mkdirSync(projDir, { recursive: true });

    // Generate auth token and write server.secret.json so both server and client can read it
    const token = crypto.randomBytes(32).toString("hex");
    const secretPath = path.join(projDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token }, null, 2));
    try { fs.chmodSync(secretPath, 0o600); } catch {}

    // Spawn server in background
    const logFile = path.join(projDir, "server.log");
    log(`spawning coms-net server: ${bunPath} ${scriptPath}`);

    const child = spawn(bunPath, [scriptPath], {
        detached: true,
        stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
        env: {
            ...process.env,
            PI_COMS_NET_PROJECT: project,
            PI_COMS_NET_HOST: "0.0.0.0", // LAN-accessible
            PI_COMS_NET_AUTH_TOKEN: token,
            PI_COMS_NET_PORT: "0", // OS picks free port
        },
    });
    child.unref();

    // Wait for server to come up
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
    if (sj?.pid) {
        try {
            process.kill(sj.pid, "SIGTERM");
            log(`sent SIGTERM to server pid ${sj.pid}`);
        } catch {
            // already dead
        }
    }
}

export function registerComsNet(pi: ExtensionAPI) {
    let active = false;
    let activeProject = "default";
    let serverStartedByUs = false;
    let capturedSessionStart: ((event: any, ctx: any) => Promise<void>) | null = null;
    let capturedSessionShutdown: (() => Promise<void>) | null = null;
    const flagValues = new Map<string, any>();

    const log = (msg: string) => {
        try {
            pi.appendEntry("coms-net-log", { event: "wrapper", ts: new Date().toISOString(), msg });
        } catch {}
    };

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
                        if (event === 'session_shutdown') {
                            capturedSessionShutdown = handler;
                            return target.on(event, handler);
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

    // Clean up server we started on session shutdown
    pi.on("session_shutdown", async () => {
        if (serverStartedByUs) {
            killServer(activeProject, log);
            serverStartedByUs = false;
        }
    });

    pi.registerCommand("coms-net", {
        description: "Networked agent communication: /coms-net start [--name X --purpose Y --project Z --color #HEX] | stop | status | server-stop",
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
                const project = (flagValues.get("project") as string) || "default";
                activeProject = project;

                if (!capturedSessionStart) {
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
                    await capturedSessionStart({}, ctx);
                    active = true;
                    const sj = readServerJson(project);
                    try { ctx.ui.notify(`📡 coms-net active — server at ${sj?.local_url || "unknown"}`, "info"); } catch {}
                } catch (err: any) {
                    try { ctx.ui.notify(`📡 coms-net start failed: ${err?.message ?? String(err)}`, "error"); } catch {}
                }
            } else if (subcommand === "stop") {
                if (!active) {
                    try { ctx.ui.notify("📡 coms-net not active", "info"); } catch {}
                    return;
                }
                if (capturedSessionShutdown) {
                    try { await capturedSessionShutdown(); } catch {}
                }
                active = false;
                try { ctx.ui.notify("📡 coms-net stopped", "info"); } catch {}
            } else if (subcommand === "server-stop") {
                killServer(activeProject, log);
                serverStartedByUs = false;
                try { ctx.ui.notify("📡 coms-net server stopped", "info"); } catch {}
            } else if (subcommand === "status") {
                const project = (flagValues.get("project") as string) || "default";
                const serverUp = await isServerHealthy(project);
                const sj = readServerJson(project);
                let msg = `📡 coms-net: ${active ? "active" : "inactive"}\n`;
                msg += `Server: ${serverUp ? `running at ${sj?.local_url}` : "not running"}\n`;
                if (serverStartedByUs) msg += "(server started by this session)";
                try { ctx.ui.notify(msg, "info"); } catch {}
            } else {
                try { ctx.ui.notify(`📡 coms-net: unknown subcommand "${subcommand}". Use: start | stop | status | server-stop`, "warning"); } catch {}
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
