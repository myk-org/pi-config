/**
 * coms-swarm.ts — Spawn and manage headless peer pi sessions via SDK
 *
 * Adds /coms swarm subcommands:
 *   /coms swarm add --name <name> [--purpose <text>] [--system-prompt <text>] [--model <pattern>] [--read-only]
 *   /coms swarm status
 *   /coms swarm stop [--name <name>]
 *
 * Each peer is an AgentSession created via the pi SDK, loaded with only
 * the coms extension. Peers auto-connect to P2P coms and stay alive
 * via the coms Unix socket listener.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface SwarmPeer {
    name: string;
    purpose: string;
    model: string;
    systemPrompt: string;
    readOnly: boolean;
    session: any; // AgentSession
    project: string;
    sessionFile: string;
    startedAt: number;
}

function cleanupPeerRegistry(name: string, project: string): void {
    const comsDir = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
    const registryFile = path.join(comsDir, "projects", project, "agents", `${name}.json`);
    try {
        if (fs.existsSync(registryFile)) {
            // Read socket path before deleting
            const data = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
            fs.unlinkSync(registryFile);
            // Remove socket
            if (data.endpoint) {
                try { fs.unlinkSync(data.endpoint); } catch {}
            }
        }
    } catch {}
}

const peers = new Map<string, SwarmPeer>();

function getComsExtensionPath(): string {
    // Path to this extension's index.ts (coms extension entry point)
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
}

function parseSwarmArgs(parts: string[]): {
    names: string[];
    purpose: string;
    systemPrompt: string;
    model: string;
    readOnly: boolean;
} {
    const names: string[] = [];
    let purpose = "";
    let systemPrompt = "";
    let model = "";
    let readOnly = false;

    let i = 0;
    while (i < parts.length) {
        const arg = parts[i];
        if (arg === "--name" && i + 1 < parts.length) {
            names.push(parts[++i]);
        } else if (arg === "--purpose" && i + 1 < parts.length) {
            purpose = parts[++i];
        } else if (arg === "--system-prompt" && i + 1 < parts.length) {
            systemPrompt = parts[++i];
        } else if (arg === "--model" && i + 1 < parts.length) {
            model = parts[++i];
        } else if (arg === "--read-only") {
            readOnly = true;
        }
        i++;
    }

    return { names, purpose, systemPrompt, model, readOnly };
}

async function spawnPeer(
    name: string,
    purpose: string,
    systemPrompt: string,
    modelPattern: string,
    readOnly: boolean,
    cwd: string,
    parentProject: string,
    log: (msg: string) => void,
    existingSessionFile?: string,
): Promise<SwarmPeer> {
    log(`spawning peer: ${name}`);

    const effectiveSystemPrompt = systemPrompt ||
        "You are a peer agent in a multi-agent swarm. Respond to requests from other agents via coms. Be concise and helpful.";

    // Full resource loader but exclude UI extensions
    const EXCLUDE_EXTENSIONS = ["pidash", "pidiff"];
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
    });
    await resourceLoader.reload();

    // Filter out pidash/pidiff extensions
    const origGetExtensions = resourceLoader.getExtensions.bind(resourceLoader);
    resourceLoader.getExtensions = () => {
        const result = origGetExtensions();
        result.extensions = result.extensions.filter(
            (ext: any) => !EXCLUDE_EXTENSIONS.some(name => (ext.path || "").includes(`/${name}/`))
        );
        return result;
    };

    // Override system prompt
    resourceLoader.getSystemPrompt = () => effectiveSystemPrompt;

    const tools = readOnly
        ? ["read", "ls", "find", "grep"] as string[]
        : undefined; // undefined = all default tools

    // Resume from existing session file if available, otherwise create new
    const sessionManager = existingSessionFile && fs.existsSync(existingSessionFile)
        ? SessionManager.open(existingSessionFile)
        : SessionManager.create(cwd);
    const sessionOptions: any = {
        cwd,
        resourceLoader,
        sessionManager,
    };

    if (tools) {
        sessionOptions.tools = tools;
    }

    const { session } = await createAgentSession(sessionOptions);

    // Build the /coms start command for this peer
    let comsStartCmd = `/coms start --name ${name}`;
    if (purpose) comsStartCmd += ` --purpose "${purpose}"`;
    if (parentProject) comsStartCmd += ` --project ${parentProject}`;

    // Subscribe to events for logging
    session.subscribe((event: any) => {
        if (event.type === "agent_end") {
            log(`peer ${name}: agent_end`);
        }
    });

    // Always send /coms start to register with coms
    // (even on resume — coms state doesn't persist in the session file)
    await session.prompt(comsStartCmd);

    const peer: SwarmPeer = {
        name,
        purpose,
        project: parentProject,
        model: modelPattern || "default",
        systemPrompt: effectiveSystemPrompt,
        readOnly,
        session,
        sessionFile: session.sessionFile || "",
        startedAt: Date.now(),
    };

    log(`peer ${name} spawned and coms started`);
    return peer;
}

const SWARM_PERSIST_KEY = "coms-swarm-state";

interface PeerConfig {
    name: string;
    purpose: string;
    systemPrompt: string;
    model: string;
    readOnly: boolean;
    project: string;
    sessionFile: string;
}

function persistSwarm(pi: ExtensionAPI, peerConfigs: PeerConfig[]): void {
    try {
        pi.appendEntry(SWARM_PERSIST_KEY, { peers: peerConfigs });
    } catch {}
}

export function registerComsSwarm(pi: ExtensionAPI): {
    handleSwarmCommand: (subcommand: string, parts: string[], ctx: any) => Promise<boolean>;
} {
    let lastCtx: any = null;

    function updateSwarmStatus(ctx?: any) {
        const c = ctx || lastCtx;
        if (!c) return;
        try {
            c.ui.setStatus("2-swarm", c.ui.theme.fg("muted", `💤 swarm: 0`));
        } catch {}
    }

    pi.on("session_start", (_event: any, ctx: any) => {
        lastCtx = ctx;
        updateSwarmStatus(ctx);
    });
    pi.on("turn_end", (_event: any, ctx: any) => { lastCtx = ctx; });

    const log = (msg: string) => {
        try {
            pi.appendEntry("coms-swarm-log", { event: "swarm", ts: new Date().toISOString(), msg });
        } catch {}
    };

    function savePeerConfigs(): void {
        const configs: PeerConfig[] = [];
        for (const [, peer] of peers) {
            configs.push({
                name: peer.name,
                purpose: peer.purpose,
                systemPrompt: peer.systemPrompt,
                model: peer.model,
                readOnly: peer.readOnly,
                project: peer.project,
                sessionFile: peer.sessionFile,
            });
        }
        persistSwarm(pi, configs);
    }

    // Restore peers on reload
    pi.on("session_start", async (event: any, ctx: any) => {
        if (event?.reason !== "reload") return;
        let savedPeers: PeerConfig[] = [];
        try {
            for (const entry of ctx.sessionManager.getEntries()) {
                if (entry.type === "custom" && entry.customType === SWARM_PERSIST_KEY) {
                    savedPeers = entry.data?.peers || [];
                }
            }
        } catch {}
        if (savedPeers.length === 0) return;

        log(`reload: restoring ${savedPeers.length} swarm peer(s)`);
        for (const config of savedPeers) {
            if (peers.has(config.name)) continue;
            try {
                const peer = await spawnPeer(
                    config.name,
                    config.purpose,
                    config.systemPrompt,
                    config.model,
                    config.readOnly,
                    ctx.cwd,
                    config.project,
                    log,
                    config.sessionFile,
                );
                peers.set(config.name, peer);
                log(`reload: restored peer ${config.name}`);
            } catch (err: any) {
                console.error(`[coms-swarm] reload: failed to restore ${config.name}:`, err);
            }
        }
    });

    async function handleSwarmCommand(subcommand: string, parts: string[], ctx: any): Promise<boolean> {
        if (subcommand !== "swarm") return false;

        const action = parts[1] || "status";
        const actionParts = parts.slice(2);

        if (action === "add") {
            const args = parseSwarmArgs(actionParts);

            if (args.names.length === 0) {
                try { ctx.ui.notify("📡 swarm add: --name is required", "error"); } catch {}
                return true;
            }

            // Use cwd with slashes replaced — matches the parent session's coms project
            const parentProject = ctx.cwd.replace(/^\//,"").replace(/\//g, "__");

            for (const name of args.names) {
                if (peers.has(name)) {
                    try { ctx.ui.notify(`📡 swarm add: peer "${name}" already exists`, "warning"); } catch {}
                    continue;
                }

                console.log(`[coms-swarm] spawning peer: ${name}, project: ${parentProject}, cwd: ${ctx.cwd}`);
                try {
                    const peer = await spawnPeer(
                        name,
                        args.purpose,
                        args.systemPrompt,
                        args.model,
                        args.readOnly,
                        ctx.cwd,
                        parentProject,
                        log,
                    );
                    peers.set(name, peer);
                    savePeerConfigs();
                    updateSwarmStatus(ctx);
                    try { ctx.ui.notify(`📡 swarm: peer "${name}" spawned`, "info"); } catch {}
                } catch (err: any) {
                    console.error(`[coms-swarm] spawn failed for ${name}:`, err);
                    log(`spawn failed for ${name}: ${err.message}`);
                    try { ctx.ui.notify(`📡 swarm add: failed to spawn "${name}": ${err.message}`, "error"); } catch {}
                }
            }

            return true;
        }

        if (action === "stop") {
            const args = parseSwarmArgs(actionParts);

            if (args.names.length > 0) {
                // Stop specific peers
                for (const name of args.names) {
                    const peer = peers.get(name);
                    if (!peer) {
                        try { ctx.ui.notify(`📡 swarm stop: peer "${name}" not found`, "warning"); } catch {}
                        continue;
                    }
                    try { peer.session.dispose(); } catch {}
                    cleanupPeerRegistry(name, peer.project);
                    peers.delete(name);
                    savePeerConfigs();
                    updateSwarmStatus(ctx);
                    try { ctx.ui.notify(`📡 swarm: peer "${name}" stopped`, "info"); } catch {}
                }
            } else {
                // Stop all peers
                const count = peers.size;
                for (const [name, peer] of peers) {
                    try { peer.session.dispose(); } catch {}
                    cleanupPeerRegistry(name, peer.project);
                    log(`stopped peer: ${name}`);
                }
                peers.clear();
                savePeerConfigs();
                updateSwarmStatus(ctx);
                try { ctx.ui.notify(`📡 swarm: stopped ${count} peer(s)`, "info"); } catch {}
            }

            return true;
        }

        if (action === "status") {
            if (peers.size === 0) {
                try { ctx.ui.notify("📡 swarm: no active peers. Use `/coms swarm add --name <name>` to spawn.", "info"); } catch {}
                return true;
            }

            let msg = `📡 swarm: ${peers.size} active peer(s)\n\n`;
            for (const [name, peer] of peers) {
                const uptime = Math.floor((Date.now() - peer.startedAt) / 1000);
                const uptimeStr = uptime < 60 ? `${uptime}s` : `${Math.floor(uptime / 60)}m${uptime % 60}s`;
                const ro = peer.readOnly ? " [read-only]" : "";
                msg += `  • ${name} — ${peer.purpose || "general"}${ro} (${peer.model}, ${uptimeStr})\n`;
            }
            try { ctx.ui.notify(msg.trim(), "info"); } catch {}
            return true;
        }

        if (action === "send") {
            if (peers.size === 0) {
                try { ctx.ui.notify("📡 swarm send: no active peers", "warning"); } catch {}
                return true;
            }

            // Parse --name / --all / --msg
            let targetName = "";
            let sendAll = false;
            let message = "";
            let i = 0;
            while (i < actionParts.length) {
                if (actionParts[i] === "--name" && i + 1 < actionParts.length) {
                    targetName = actionParts[++i];
                } else if (actionParts[i] === "--all") {
                    sendAll = true;
                } else if (actionParts[i] === "--msg") {
                    // Everything after --msg is the message
                    message = actionParts.slice(i + 1).join(" ");
                    break;
                }
                i++;
            }

            if (!message) {
                try { ctx.ui.notify("📡 swarm send: --msg is required", "error"); } catch {}
                return true;
            }

            if (!targetName && !sendAll) {
                try { ctx.ui.notify("📡 swarm send: specify --name <peer> or --all", "error"); } catch {}
                return true;
            }

            const targets = sendAll
                ? Array.from(peers.keys())
                : [targetName];

            const validTargets = targets.filter(n => peers.has(n));
            let pending = validTargets.length;
            const invalidTargets = targets.filter(n => !peers.has(n));
            for (const name of invalidTargets) {
                try { ctx.ui.notify(`📡 swarm send: peer "${name}" not found`, "warning"); } catch {}
            }

            if (validTargets.length === 0) {
                try { ctx.ui.notify("📡 swarm send: no valid peers to send to", "warning"); } catch {}
                return true;
            }

            for (const name of validTargets) {
                const peer = peers.get(name)!;

                // Fire each peer prompt — response surfaces via sendMessage as it completes
                (async () => {
                    let text = "";
                    const unsub = peer.session.subscribe((event: any) => {
                        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                            text += event.assistantMessageEvent.delta;
                        }
                    });
                    try {
                        await peer.session.prompt(message);
                    } catch (err: any) {
                        text = `(error: ${err.message})`;
                    }
                    unsub();
                    const responseContent = [
                        `---`,
                        ``,
                        `## 📡 Swarm peer ${name}`,
                        ``,
                        text,
                        ``,
                    ].join("\n");
                    pi.sendMessage({
                        customType: "swarm-response",
                        content: responseContent,
                        display: true,
                    }, { triggerTurn: false, deliverAs: "followUp" });
                    pending--;
                    if (pending <= 0) {
                        updateSwarmStatus(ctx);
                    } else {
                        try { ctx.ui.setStatus("2-swarm", ctx.ui.theme.fg("warning", `⏳ swarm: ${pending} responding...`)); } catch {}
                    }
                })();
                log(`sent to ${name}: ${message.slice(0, 100)}`);
            }

            const targetDesc = targetName ? `"${targetName}"` : `all ${validTargets.length} peer(s)`;
            try { ctx.ui.setStatus("2-swarm", ctx.ui.theme.fg("warning", `⏳ swarm: waiting...`)); } catch {}
            return true;
        }

        try { ctx.ui.notify(`📡 swarm: unknown action "${action}". Use: add | stop | status | send`, "warning"); } catch {}
        return true;
    }

    // Clean up all peers on session shutdown
    pi.on("session_shutdown", () => {
        for (const [name, peer] of peers) {
            try { peer.session.dispose(); } catch {}
            cleanupPeerRegistry(name, peer.project);
            log(`shutdown: stopped peer ${name}`);
        }
        peers.clear();
    });

    return { handleSwarmCommand };
}
