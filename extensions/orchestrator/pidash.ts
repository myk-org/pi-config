/**
 * Pidash extension — connects to the pidash daemon to expose this session.
 *
 * On session_start:
 * 1. Check if pidash daemon is running (HTTP health check)
 * 2. If not, spawn it as a detached process
 * 3. Connect via WebSocket, register this session
 * 4. Forward all pi events to the daemon
 * 5. Receive prompts from the daemon (browser → daemon → here → pi)
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { commandHandlerRegistry } from "./index.js";

const DEFAULT_PORT = 19190;
const PIDASH_PORT = parseInt(process.env.PI_PIDASH_PORT || "", 10) || DEFAULT_PORT;
const RECONNECT_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

const PIDASH_LOG = path.join(process.env.HOME || "/tmp", ".pi", "pidash-debug.log");
function debugLog(msg: string) {
  try { fs.appendFileSync(PIDASH_LOG, `${new Date().toISOString()} [ext] ${msg}\n`); } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────

function isDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: PIDASH_PORT, path: "/api/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try { resolve(JSON.parse(body).status === "ok"); } catch { resolve(false); }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function ensurePidashUiBuilt(): void {
  const uiDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "pidash-ui",
  );
  const distDir = path.join(uiDir, "dist");
  if (fs.existsSync(distDir)) return;
  if (!fs.existsSync(path.join(uiDir, "package.json"))) return;

  debugLog("pidash-ui dist/ not found, building...");
  try {
    const { execSync: ex } = require("node:child_process");
    ex("npm install --production=false && npm run build", {
      cwd: uiDir,
      stdio: "ignore",
      timeout: 60000,
    });
    debugLog("pidash-ui build complete");
  } catch (e: any) {
    debugLog(`pidash-ui build failed: ${e.message}`);
  }
}

function spawnDaemon(): void {
  ensurePidashUiBuilt();
  const serverPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..", "..", "scripts", "pidash-server.ts",
  );

  let jitiPath: string | undefined;
  try {
    // Walk up from this file to find node_modules/@mariozechner/jiti
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, "node_modules", "@mariozechner", "jiti", "lib", "jiti-cli.mjs");
      if (fs.existsSync(candidate)) { jitiPath = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Also check pi's global install
    if (!jitiPath) {
      const globalCandidate = path.join(
        path.dirname(process.execPath), "..", "lib", "node_modules",
        "@mariozechner", "pi-coding-agent", "node_modules",
        "@mariozechner", "jiti", "lib", "jiti-cli.mjs",
      );
      if (fs.existsSync(globalCandidate)) jitiPath = globalCandidate;
    }
  } catch {}
  debugLog(`jiti path: ${jitiPath || "NOT FOUND"}`);

  const nodeCmd = process.execPath;
  const args = jitiPath ? `"${jitiPath}" "${serverPath}"` : `"${serverPath}"`;
  const logFile = path.join(process.env.HOME || "/tmp", ".pi", "pidash-server.log");
  // Use nohup + shell to fully detach from pi's process group
  const cmd = `nohup "${nodeCmd}" ${args} > "${logFile}" 2>&1 &`;
  debugLog(`spawning daemon via shell: ${cmd}`);

  try {
    const { execSync } = require("node:child_process");
    execSync(cmd, {
      stdio: "ignore",
      env: { ...process.env, PI_PIDASH_PORT: String(PIDASH_PORT) },
    });
  } catch (e: any) {
    debugLog(`daemon spawn error: ${e.message}`);
  }
}

function getGitStatus(cwd: string): { branch: string; dirty: boolean; changes: number } {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const changes = status ? status.split("\n").length : 0;
    return { branch, dirty: changes > 0, changes };
  } catch { return { branch: "", dirty: false, changes: 0 }; }
}

function isContainer(): boolean {
  try {
    return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
  } catch { return false; }
}

let diffPort: number | null = null;

function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd, encoding: "utf-8", timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerPidash(
  pi: ExtensionAPI,
  killAsyncAgent?: (target: string) => { killed: string[]; errors: string[] },
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let ws: any = null;
  let connected = false;
  let connecting = false;
  let shuttingDown = false;
  let spawning = false;
  let lastCtx: any = null;
  const sessionId = `${process.pid}:${process.cwd()}`;
  const eventBuffer: string[] = []; // Buffer events for replay on daemon reconnect

  async function connect(ctx: any) {
    debugLog(`connect() called, connected=${connected}, connecting=${connecting}, shuttingDown=${shuttingDown}, cwd=${ctx?.cwd}`);
    if (connected || connecting || shuttingDown) return;
    connecting = true;
    lastCtx = ctx;

    const running = await isDaemonRunning();
    debugLog(`daemon running: ${running}`);
    if (!running) {
      if (spawning) {
        debugLog("daemon already spawning, waiting...");
      } else {
        spawning = true;
        debugLog("spawning daemon...");
        spawnDaemon();
      }
      // jiti cold compilation can take 30+ seconds on first run
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isDaemonRunning()) {
          debugLog(`daemon ready after ${i + 1}s`);
          break;
        }
      }
      if (!(await isDaemonRunning())) {
        debugLog("daemon failed to start after 60s");
        spawning = false;
        connecting = false;
        return;
      }
      spawning = false;
    }

    try {
      const _require = createRequire(import.meta.url);
      const WebSocket = _require("ws");
      debugLog("creating WebSocket client...");
      const wsClient = new WebSocket(`ws://127.0.0.1:${PIDASH_PORT}/ws/pi`);

      wsClient.on("open", () => {
        debugLog("WebSocket connected!");
        ws = wsClient;
        connected = true;
        connecting = false;

        // Register this session
        const git = getGitStatus(ctx.cwd);
        const m = ctx.model;
        // Read thinking level from session entries
        let thinking = "medium";
        try {
          thinking = (pi as any).getThinkingLevel?.() || "medium";
        } catch {}
        const reg = JSON.stringify({
          type: "register",
          pid: process.pid,
          sessionId,
          cwd: ctx.cwd,
          branch: git.branch,
          gitDirty: git.dirty,
          gitChanges: git.changes,
          container: isContainer(),
          diffPort,
          model: m?.name || m?.id || "",
          contextWindow: m?.contextWindow || 0,
          startedAt: new Date().toISOString(),
          sessionFile: ctx.sessionFile || "",
          thinkingLevel: thinking,
        });
        debugLog(`sending register: ${reg}`);
        wsClient.send(reg);

        // Always load history from session file (source of truth)
        eventBuffer.length = 0;
        const pushBuffered = (ev: string) => {
          wsClient.send(ev);
          eventBuffer.push(ev);
          while (eventBuffer.length > 10000) eventBuffer.shift();
        };
        {
          try {
            const entries = ctx.sessionManager?.getEntries?.() || [];
            let historyCount = 0;
            for (const entry of entries) {
              const e = entry as any;
              if (e.type !== "message" || !e.message) continue;
              const msg = e.message;
              const ts = e.timestamp ? new Date(e.timestamp).getTime() : Date.now();

              if (msg.role === "user") {
                pushBuffered(JSON.stringify({ type: "message_start", message: msg, timestamp: ts }));
              }

              if (msg.role === "assistant" && msg.content) {
                // Send thinking blocks
                for (const part of msg.content) {
                  if (part.type === "thinking" && part.thinking) {
                    const thinkEv = JSON.stringify({
                      type: "message_update",
                      assistantMessageEvent: { type: "thinking_delta", delta: part.thinking, partial: { model: msg.model, usage: msg.usage } },
                      timestamp: ts,
                    });
                    pushBuffered(thinkEv);
                  }
                }

                // Send text blocks
                for (const part of msg.content) {
                  if (part.type === "text" && part.text) {
                    const textEv = JSON.stringify({
                      type: "message_update",
                      assistantMessageEvent: { type: "text_delta", delta: part.text, partial: { model: msg.model, usage: msg.usage } },
                      timestamp: ts,
                    });
                    pushBuffered(textEv);
                  }
                }

                // Send tool calls
                for (const part of msg.content) {
                  if (part.type === "toolCall") {
                    const toolEv = JSON.stringify({
                      type: "tool_execution_start",
                      toolName: part.name,
                      args: part.arguments,
                      timestamp: ts,
                    });
                    pushBuffered(toolEv);
                  }
                }

                // Send message_end
                pushBuffered(JSON.stringify({ type: "message_end", message: msg, timestamp: ts }));
              }

              // Tool results
              if (msg.role === "toolResult") {
                const resultEv = JSON.stringify({
                  type: "tool_execution_end",
                  toolName: msg.toolName,
                  result: { content: msg.content },
                  isError: msg.isError || false,
                  timestamp: ts,
                });
                pushBuffered(resultEv);
              }

              // Custom messages (async agent results, etc.)
              if (msg.role === "custom" && msg.display) {
                const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
                pushBuffered(JSON.stringify({
                  type: "message_start",
                  message: { role: "custom", display: true, content, customType: msg.customType },
                  timestamp: ts,
                }));
              }

              // Catch-all: any other message role — forward as-is
              if (!["user", "assistant", "toolResult", "custom"].includes(msg.role)) {
                pushBuffered(JSON.stringify({ type: "message_start", message: msg, timestamp: ts }));
              }

              historyCount++;
            }
            if (historyCount > 0) debugLog(`loaded ${historyCount} entries from session history`);
          } catch (e: any) {
            debugLog(`session history load error: ${e.message}`);
          }
        }

        // Signal replay is complete so the server can stop suppressing notifications
        try { wsClient.send(JSON.stringify({ type: "replay_complete" })); } catch {}

        // Respond to pings (keepalive)
        wsClient.on("ping", () => {
          try { wsClient.pong(); } catch {}
        });

        // Send heartbeat every 30s to prevent idle disconnects
        const heartbeat = setInterval(() => {
          if (wsClient.readyState === 1) { // WebSocket.OPEN
            try { wsClient.ping(); } catch {}
          } else {
            clearInterval(heartbeat);
          }
        }, 30000);
        if ((heartbeat as any).unref) (heartbeat as any).unref();

        // Show status
        if (ctx.hasUI) {
          ctx.ui.setStatus("pidash", ctx.ui.theme.fg("accent", `🌐 http://localhost:${PIDASH_PORT}`));
        }
      });

      wsClient.on("message", async (data: Buffer) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "prompt" && parsed.text) {
            debugLog(`received prompt from browser: ${parsed.text.slice(0, 100)}`);
            pi.sendUserMessage(parsed.text, { deliverAs: "followUp" });
          }
          if (parsed.type === "extension_ui_response" && parsed.id) {
            debugLog(`received UI response from browser: ${JSON.stringify(parsed).slice(0, 100)}`);
            pi.events.emit("pidash:ui-response", parsed);
          }
          if (parsed.type === "pidash-command") {
            debugLog(`received command from browser: ${parsed.command}`);

            if (parsed.command === "list-sessions") {
              try {
                const sessionsDir = path.join(process.env.HOME || "~", ".pi", "agent", "sessions");
                const cwd = lastCtx?.cwd || "";
                // Pi encodes paths as --path-parts-- in the sessions directory
                const dirs = fs.readdirSync(sessionsDir);
                debugLog(`list-sessions: cwd=${cwd}, sessionsDir=${sessionsDir}, dirs=${dirs.length}`);
                // Find matching project dir — try exact match on cwd segments
                const cwdParts = cwd.split("/").filter(Boolean).join("-");
                const projDir = dirs.find((d: string) => d.includes(cwdParts));
                debugLog(`list-sessions: cwdParts=${cwdParts}, projDir=${projDir || "NOT FOUND"}`);
                if (projDir) {
                  const fullDir = path.join(sessionsDir, projDir);
                  const files = fs.readdirSync(fullDir)
                    .filter((f: string) => f.endsWith(".jsonl"))
                    .sort()
                    .reverse()
                    .slice(0, 20)
                    .map((f: string) => {
                      const filePath = path.join(fullDir, f);
                      let sessionName = "";
                      let firstMsg = "";
                      let modelId = "";
                      let date = "";
                      try {
                        const content = fs.readFileSync(filePath, "utf-8");
                        const lines = content.split("\n").slice(0, 30); // Read first 30 lines
                        for (const line of lines) {
                          if (!line.trim()) continue;
                          try {
                            const entry = JSON.parse(line);
                            if (entry.type === "session") {
                              date = entry.timestamp || "";
                            }
                            if (entry.type === "session_info" && entry.name) {
                              sessionName = entry.name;
                            }
                            if (entry.type === "model_change" && !modelId) {
                              modelId = entry.modelId || "";
                            }
                            if (entry.type === "message" && entry.message?.role === "user" && !firstMsg) {
                              const texts = (entry.message.content || [])
                                .filter((c: any) => c.type === "text")
                                .map((c: any) => c.text);
                              firstMsg = texts.join(" ").slice(0, 100);
                            }
                          } catch {}
                        }
                      } catch {}
                      return {
                        file: f,
                        path: filePath,
                        name: sessionName || firstMsg || f.replace(/\.jsonl$/, ""),
                        model: modelId,
                        date,
                      };
                    });
                  debugLog(`list-sessions: found ${files.length} sessions`);
                  if (ws && connected) ws.send(JSON.stringify({ type: "sessions-list", sessions: files }));
                } else {
                  debugLog("list-sessions: no matching project dir");
                  if (ws && connected) ws.send(JSON.stringify({ type: "sessions-list", sessions: [] }));
                }
              } catch (e: any) { debugLog(`list-sessions error: ${e.message}`); }
            }

            if (parsed.command === "list-models") {
              try {
                if (lastCtx?.modelRegistry) {
                  const available = lastCtx.modelRegistry.getAvailable();
                  const list = available.map((m: any) => ({
                    id: m.id,
                    name: m.name,
                    provider: typeof m.provider === "string" ? m.provider : m.provider?.name || "",
                  }));
                  debugLog(`models found: ${list.length}`);
                  if (ws && connected) ws.send(JSON.stringify({ type: "models-list", models: list }));
                } else {
                  debugLog("list-models: no modelRegistry on ctx");
                }
              } catch (e: any) { debugLog(`list-models error: ${e.message}`); }
            }

            if (parsed.command === "set-model" && parsed.modelId) {
              try {
                const model = lastCtx?.modelRegistry?.getAvailable()?.find((m: any) =>
                  m.id === parsed.modelId || m.name === parsed.modelId || m.id.includes(parsed.modelId) || m.name.includes(parsed.modelId));
                if (model) {
                  await (pi as any).setModel(model);
                  debugLog(`model set to: ${model.name}`);
                  ws.send(JSON.stringify({ type: "update_info", model: model.name, contextWindow: model.contextWindow || 0 }));
                }
              } catch (e: any) { debugLog(`set-model error: ${e.message}`); }
            }

            if (parsed.command === "set-thinking" && parsed.level) {
              try {
                (pi as any).setThinkingLevel(parsed.level);
                debugLog(`thinking set to: ${parsed.level}`);
                ws.send(JSON.stringify({ type: "update_info", thinkingLevel: parsed.level }));
              } catch (e: any) { debugLog(`set-thinking error: ${e.message}`); }
            }

            if (parsed.command === "switch-session" && parsed.sessionFile && execCtx) {
              if (!execCtxIsCommand) {
                debugLog("switch-session: skipped — no command context (run /pidash first)");
              } else {
                debugLog(`switch-session: ${parsed.sessionFile}`);
                try {
                  await (execCtx as any).switchSession(parsed.sessionFile, {
                    withSession: async () => {
                      debugLog("switch-session: completed via withSession");
                    },
                  });
                } catch (e: any) {
                  debugLog(`switch-session error: ${e.message}`);
                }
              }
            }
            if (parsed.command === "new-session" && execCtx) {
              if (!execCtxIsCommand) {
                debugLog("new-session: skipped — no command context (run /pidash first)");
              } else {
                debugLog("new-session: creating new session");
                try {
                  await (execCtx as any).newSession({
                    withSession: async () => {
                      debugLog("new-session: completed via withSession");
                    },
                  });
                } catch (e: any) {
                  debugLog(`new-session error: ${e.message}`);
                }
              }
            }

            if (parsed.command === "abort") {
              if (lastCtx) {
                try { lastCtx.abort(); debugLog("abort sent"); } catch {}
              }
            }

            if (parsed.command === "async-kill" && parsed.target) {
              debugLog(`async-kill from browser: ${parsed.target}`);
              pi.events.emit("pidash:async-kill", parsed.target);
            }

            if (parsed.command === "list-commands") {
              try {
                const cmds = (pi as any).getCommands?.() || [];
                const list = cmds.map((c: any) => ({ name: c.name, description: c.description || "" }));
                if (ws && connected) ws.send(JSON.stringify({ type: "commands-list", commands: list }));
              } catch {}
            }
          }
        } catch {}
      });

      wsClient.on("close", (code: number, reason: Buffer) => {
        debugLog(`WebSocket closed: code=${code} reason=${reason?.toString() || 'none'}`);
        connecting = false;
        debugLog("WebSocket closed");
        connected = false;
        ws = null;
        if (!shuttingDown) {
          setTimeout(() => { if (lastCtx && !shuttingDown) connect(lastCtx); }, RECONNECT_INTERVAL_MS);
        }
      });

      wsClient.on("error", (e: Error) => {
        debugLog(`WebSocket error: ${e.message}`);
      });
    } catch (e: any) {
      debugLog(`connect error: ${e.message}`);
      connecting = false;
    }
  }

  // Forward events to daemon
  function forward(type: string) {
    pi.on(type as any, (event: any, ctx: any) => {
      lastCtx = ctx;
      let payload: any = { type, ...event, timestamp: Date.now() };

      // Optimize message_update: strip the full accumulated partial message
      // to prevent events growing larger as streaming progresses.
      // Keep only delta + essential metadata (model, usage).
      if (type === "message_update" && payload.assistantMessageEvent?.partial) {
        const ae = payload.assistantMessageEvent;
        payload = {
          type,
          assistantMessageEvent: {
            type: ae.type,
            delta: ae.delta,
            contentIndex: ae.contentIndex,
            content: ae.content,
            partial: ae.partial ? {
              model: ae.partial.model,
              usage: ae.partial.usage,
              provider: ae.partial.provider,
            } : undefined,
          },
          timestamp: payload.timestamp,
        };
      }

      // Strip full message from message_end (can be large for resumed sessions)
      // Keep only role and essential content
      if (type === "message_end" && payload.message) {
        const m = payload.message;
        payload = {
          type,
          message: {
            role: m.role,
            model: m.model,
            usage: m.usage,
            provider: m.provider,
            customType: m.customType,
            display: m.display,
          },
          timestamp: payload.timestamp,
        };
      }

      const msg = JSON.stringify(payload);
      if (type !== "extension_ui_request") {
        eventBuffer.push(msg);
        // Cap incremental buffer — session file is the source of truth for full history
        while (eventBuffer.length > 10000) eventBuffer.shift();
      }
      if (ws && connected) {
        try { ws.send(msg); } catch (e: any) { debugLog(`forward ${type} error: ${e.message}`); }
      } else if (!connected) {
        debugLog(`forward ${type}: ws not connected`);
      }
    });
  }

  // Wrap ALL ctx.ui dialog methods for pidash bridging
  const wrapCtx = (_event: any, ctx: any) => {
    if (!ctx?.ui || ctx.ui.__pidashWrapped) return;
    ctx.ui.__pidashWrapped = true;
    const origSelect = ctx.ui.select.bind(ctx.ui);
    const origConfirm = ctx.ui.confirm.bind(ctx.ui);

    ctx.ui.select = async (title: string, options: string[], opts?: any) => {
      const askId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (ws && connected) {
        ws.send(JSON.stringify({ id: askId, type: "extension_ui_request", method: "select", title, options }));
      }
      const ac = new AbortController();
      let browserResolve: ((v: string | undefined) => void) | null = null;
      const unsub = pi.events.on("pidash:ui-response", (data: unknown) => {
        const r = data as any;
        if (r.id === askId && browserResolve) { browserResolve(r.cancelled ? undefined : r.value); ac.abort(); }
      });
      const result = await Promise.race([
        origSelect(title, options, { ...opts, signal: opts?.signal || ac.signal }).then((v: any) => {
          browserResolve = null;
          pi.events.emit("pidash:ui-dismiss", { type: "ui-dismiss", id: askId });
          return v;
        }),
        new Promise<string | undefined>((resolve) => { browserResolve = resolve; }),
      ]);
      unsub();
      return result;
    };

    ctx.ui.confirm = async (title: string, message: string, opts?: any) => {
      const askId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (ws && connected) {
        ws.send(JSON.stringify({ id: askId, type: "extension_ui_request", method: "confirm", title, message }));
      }
      const ac = new AbortController();
      let browserResolve: ((v: boolean) => void) | null = null;
      const unsub = pi.events.on("pidash:ui-response", (data: unknown) => {
        const r = data as any;
        if (r.id === askId && browserResolve) { browserResolve(r.confirmed ?? false); ac.abort(); }
      });
      const result = await Promise.race([
        origConfirm(title, message, { ...opts, signal: opts?.signal || ac.signal }).then((v: any) => {
          browserResolve = null;
          pi.events.emit("pidash:ui-dismiss", { type: "ui-dismiss", id: askId });
          return v;
        }),
        new Promise<boolean>((resolve) => { browserResolve = resolve; }),
      ]);
      unsub();
      return result;
    };
  };

  // Register wrapper on all events that provide ctx
  for (const evt of ["tool_call", "tool_result", "agent_start", "turn_start"] as const) {
    pi.on(evt as any, wrapCtx);
  }

  forward("agent_start");
  forward("agent_end");
  forward("turn_start");
  forward("turn_end");
  forward("message_start");
  forward("message_update");
  forward("message_end");
  forward("tool_execution_start");
  forward("tool_execution_update");
  forward("tool_execution_end");
  forward("tool_call");
  forward("tool_result");

  pi.on("model_select", (event: any) => {
    if (ws && connected) {
      ws.send(JSON.stringify({
        type: "update_info",
        model: event.model?.name || event.model?.id || "",
        contextWindow: event.model?.contextWindow || 0,
      }));
    }
  });

  // Sync thinking level on every turn
  pi.on("turn_end", () => {
    if (!ws || !connected) return;
    try {
      const level = (pi as any).getThinkingLevel?.();
      if (level) ws.send(JSON.stringify({ type: "update_info", thinkingLevel: level }));
    } catch {}
  });

  // Track diff viewer port
  pi.events.on("diff-viewer:port", (port: unknown) => {
    if (typeof port === "number") {
      diffPort = port;
      if (ws && connected) {
        ws.send(JSON.stringify({ type: "update_info", diffPort: port }));
      }
    }
  });

  // Forward ask_user requests to the daemon for browser display
  pi.events.on("pidash:ui-request", (data: unknown) => {
    if (ws && connected) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  });

  // Forward dialog dismissals to the browser
  pi.events.on("pidash:ui-dismiss", (data: unknown) => {
    if (ws && connected) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  });

  // Handle async-kill from browser
  if (killAsyncAgent) {
    pi.events.on("pidash:async-kill", (target: unknown) => {
      if (typeof target === "string") {
        const { killed } = killAsyncAgent(target);
        debugLog(`async-kill result: ${killed.join(", ") || "none"}`);
      }
    });
  }

  // Forward async agent status to browser
  pi.events.on("pidash:async-status", (data: unknown) => {
    if (ws && connected) {
      try { ws.send(JSON.stringify({ type: "async-status", ...(data as any) })); } catch {}
    }
  });

  // Forward provider response info to pidash
  pi.on("after_provider_response" as any, (event: any) => {
    if (!ws || !connected) return;
    try {
      const info: any = { type: "provider_response" };
      if (event.status) info.status = event.status;
      if (event.headers) {
        if (event.headers["x-ratelimit-remaining"]) info.rateLimitRemaining = event.headers["x-ratelimit-remaining"];
        if (event.headers["x-ratelimit-reset"]) info.rateLimitReset = event.headers["x-ratelimit-reset"];
        if (event.headers["retry-after"]) info.retryAfter = event.headers["retry-after"];
        if (event.headers["x-request-id"]) info.requestId = event.headers["x-request-id"];
      }
      ws.send(JSON.stringify(info));
    } catch {}
  });

  // Periodically update git status
  const statusInterval = setInterval(() => {
    if (!ws || !connected || !lastCtx) return;
    const git = getGitStatus(lastCtx.cwd);
    ws.send(JSON.stringify({
      type: "update_info",
      branch: git.branch,
      gitDirty: git.dirty,
      gitChanges: git.changes,
    }));
  }, 10000);
  if (statusInterval.unref) statusInterval.unref();

  // Store command context — only a real ExtensionCommandContext (from a command handler)
  // has session control methods like switchSession()/newSession().
  let execCtx: any = null;
  let execCtxIsCommand = false;

  pi.on("session_start", (_event, ctx) => {
    if (!execCtx) {
      execCtx = ctx;
      execCtxIsCommand = false;
      debugLog("execCtx created from session_start (not command context)");
    }
    if (!connected) {
      connect(ctx);
    } else if (ws) {
      // Already connected — session switched (e.g., /resume, /new)
      eventBuffer.length = 0; // Clear stale events to prevent cross-session replay on reconnect
      ws.send(JSON.stringify({
        type: "session_switch",
        sessionId,
        cwd: ctx.cwd,
        branch: getCurrentBranch(ctx.cwd),
        sessionFile: ctx.sessionFile || "",
      }));
      debugLog(`session_switch sent: cwd=${ctx.cwd}`);
    }
  });

  // Fallback for /reload — connect on first tool_result if not connected
  pi.on("tool_result", (_event, ctx) => {
    if (!connected && !shuttingDown) connect(ctx);
  });

  // Periodic reconnect — ensures sessions that started before the daemon still connect
  const reconnectPoller = setInterval(() => {
    if (!connected && !connecting && !shuttingDown && lastCtx) connect(lastCtx);
  }, 15000);
  if (reconnectPoller.unref) reconnectPoller.unref();

  // ── Command execution from browser ────────────────────────────────
  //
  // Problem: pi.sendUserMessage() disables command handling (expandPromptTemplates: false).
  // Solution: Register a command that can execute other commands, and intercept
  // browser-sourced / messages in the input event to route through it.

  // Hidden command that captures ExtensionCommandContext
  // Called once at startup via /pidash, then reused for all browser commands
  pi.registerCommand("pidash", {
    description: "Manage pidash server — /pidash start|stop|restart|status",
    handler: async (args, ctx) => {
      // Capture real ExtensionCommandContext — has switchSession()/newSession()
      execCtx = ctx;
      execCtxIsCommand = true;

      const cmd = (args || "").trim().toLowerCase();

      if (cmd === "stop") {
        if (ws) { try { ws.close(); } catch {} ws = null; }
        connected = false;
        try {
          const { execSync: ex } = require("node:child_process");
          ex("pkill -f pidash-server", { stdio: "ignore" });
        } catch {}
        if (ctx.hasUI) {
          ctx.ui.setStatus("pidash", undefined);
          ctx.ui.notify("pidash server stopped", "info");
        }
        return;
      }

      if (cmd === "start") {
        if (await isDaemonRunning()) {
          if (ctx.hasUI) ctx.ui.notify(`pidash already running at http://localhost:${PIDASH_PORT}`, "info");
          if (!connected) connect(ctx);
          return;
        }
        spawnDaemon();
        if (ctx.hasUI) ctx.ui.notify("Starting pidash server...", "info");
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (await isDaemonRunning()) break;
        }
        if (await isDaemonRunning()) {
          connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`pidash server started at http://localhost:${PIDASH_PORT}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify("pidash server failed to start — check ~/.pi/pidash-server.log", "warning");
        }
        return;
      }

      if (cmd === "restart") {
        if (ws) { try { ws.close(); } catch {} ws = null; }
        connected = false;
        try {
          const { execSync: ex } = require("node:child_process");
          ex("pkill -f pidash-server", { stdio: "ignore" });
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
        spawnDaemon();
        if (ctx.hasUI) ctx.ui.notify("Restarting pidash server...", "info");
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (await isDaemonRunning()) break;
        }
        if (await isDaemonRunning()) {
          connect(ctx);
          if (ctx.hasUI) ctx.ui.notify(`pidash server restarted at http://localhost:${PIDASH_PORT}`, "info");
        } else {
          if (ctx.hasUI) ctx.ui.notify("pidash server failed to restart — check ~/.pi/pidash-server.log", "warning");
        }
        return;
      }

      if (cmd === "status" || cmd === "") {
        const running = await isDaemonRunning();
        let msg = `Server: ${running ? "running" : "stopped"}\n`;
        msg += `Port: ${PIDASH_PORT}\n`;
        msg += `Extension: ${connected ? "connected" : "disconnected"}\n`;
        msg += `URL: http://localhost:${PIDASH_PORT}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        return;
      }

      if (ctx.hasUI) ctx.ui.notify("Usage: /pidash start|stop|restart|status", "info");
    },
  });

  // Intercept extension commands from browser
  pi.on("input", async (event, _ctx) => {
    if (event.source !== "extension") return;
    if (!event.text.startsWith("/")) return;

    const text = event.text.trim();
    const spaceIdx = text.indexOf(" ");
    const cmdName = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).toLowerCase();
    const arg = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";

    debugLog(`browser command: /${cmdName} ${arg.slice(0, 80)}`);

    const handler = commandHandlerRegistry.get(cmdName);
    if (handler) {
      try {
        await handler(arg, execCtx);
      } catch (e: any) {
        debugLog(`command /${cmdName} error: ${e.message}`);
      }
      return { action: "handled" as const };
    }
  });

  pi.on("session_shutdown", (event) => {
    // Forward shutdown reason to pidash dashboard
    if (ws && connected) {
      try {
        ws.send(JSON.stringify({
          type: "session_shutdown",
          reason: (event as any).reason,
          targetSessionFile: (event as any).targetSessionFile,
        }));
      } catch {}
    }
    shuttingDown = true;
    clearInterval(reconnectPoller);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false;
  });
}
