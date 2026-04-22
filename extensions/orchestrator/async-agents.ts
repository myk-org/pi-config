/**
 * Async agent infrastructure — background agent spawning, polling, result watching.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";
import { getPiInvocation } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const ASYNC_BASE_DIR = path.join(os.tmpdir(), "pi-async-agents");
const ASYNC_POLL_INTERVAL_MS = 3000;

// ── Interfaces ───────────────────────────────────────────────────────────

interface AsyncJob {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: "queued" | "running" | "complete" | "failed";
  asyncDir: string;
  startedAt: number;
  updatedAt: number;
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
  delivered?: boolean;
  fireAndForget?: boolean;
}

interface AsyncState {
  jobs: Map<string, AsyncJob>;
  poller: ReturnType<typeof setInterval> | null;
  watcher: fs.FSWatcher | null;
  lastCtx: any;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readAsyncStatus(asyncDir: string): any | null {
  try {
    const statusPath = path.join(asyncDir, "status.json");
    return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch { return null; }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerAsyncAgents(
  pi: ExtensionAPI,
  terminalNotify: (title: string, body: string) => void,
): {
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string }) => { id: string; error?: string };
  killAsyncAgent: (target: string) => { killed: string[]; errors: string[] };
} {
  const ASYNC_DIR = ASYNC_BASE_DIR;
  let ASYNC_RESULTS_DIR = path.join(ASYNC_BASE_DIR, `results-${process.pid}`);

  const asyncState: AsyncState = {
    jobs: new Map(),
    poller: null,
    watcher: null,
    lastCtx: null,
  };

  let lastWidgetKey = "";
  function updateAsyncWidget() {
    if (!asyncState.lastCtx?.hasUI) return;
    const ctx = asyncState.lastCtx;
    const running = Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued");
    const names = running.map(j => j.name || j.agent).join(", ");
    const widgetKey = `${running.length}:${names}`;
    const changed = widgetKey !== lastWidgetKey;
    lastWidgetKey = widgetKey;
    if (running.length > 0) {
      // Always re-set status for running agents (other status updates may have triggered a re-render)
      ctx.ui.setStatus("async-agents", ctx.ui.theme.fg("warning", `⏳ ${running.length} async: ${names}`));
      if (changed) {
        pi.events.emit("pidash:async-status", {
          count: running.length,
          agents: names,
          jobs: running.map(j => ({
            id: j.id,
            name: j.name || j.agent,
            agent: j.agent,
            task: j.task,
            status: j.status,
            startedAt: j.startedAt,
          })),
        });
      }
    } else if (changed) {
      ctx.ui.setStatus("async-agents", undefined);
      pi.events.emit("pidash:async-status", { count: 0, agents: "", jobs: [] });
    }
  }

  function ensureAsyncPoller() {
    if (asyncState.poller) return;
    asyncState.poller = setInterval(() => {
      if (!asyncState.lastCtx?.hasUI) return;
      if (asyncState.jobs.size === 0) {
        updateAsyncWidget();
        return;
      }

      for (const job of asyncState.jobs.values()) {
        if (job.status === "complete" || job.status === "failed") continue;
        const status = readAsyncStatus(job.asyncDir);
        if (status) {
          job.status = status.state;
          job.updatedAt = status.lastUpdate ?? Date.now();
          if (status.exitCode !== undefined) job.exitCode = status.exitCode;

          // Check if process is actually alive — clean up zombies
          if (job.status === "running" && status.pid) {
            try { process.kill(status.pid, 0); } catch {
              job.status = "failed";
              job.updatedAt = Date.now();
            }
          }
        }
      }

      // Fallback: check for result files the watcher may have missed
      try {
        const files = fs.readdirSync(ASYNC_RESULTS_DIR).filter(f => f.endsWith(".json"));
        for (const file of files) {
          processResultFile(path.join(ASYNC_RESULTS_DIR, file));
        }
      } catch {}

      // Remove completed/failed jobs older than 30s
      for (const [id, job] of asyncState.jobs.entries()) {
        if ((job.status === "complete" || job.status === "failed") && Date.now() - job.updatedAt > 30000) {
          asyncState.jobs.delete(id);
        }
      }
      updateAsyncWidget();
    }, ASYNC_POLL_INTERVAL_MS);
    if (asyncState.poller.unref) asyncState.poller.unref();
  }

  function processResultFile(resultPath: string) {
    try {
      const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      const job = asyncState.jobs.get(data.id);
      if (!job) return;
      if (job.delivered) return; // Already delivered to user

      // Notify user
      const displayName = job.name || data.agent;
      terminalNotify("pi", `Async agent ${displayName} ${data.success ? "completed" : "failed"} (${formatDuration(data.durationMs)})`);

      // Surface result in conversation (skip for fire-and-forget jobs)
      if (asyncState.lastCtx && !job.fireAndForget) {
        const resultStatus = data.success ? "✅ completed" : "❌ failed";
        const output = (data.output || "").slice(0, 3000);
        pi.sendMessage({
          customType: "async-agent-result",
          content: `## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${data.task}\nDuration: ${formatDuration(data.durationMs)}\n\n${output}`,
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
      }

      // Mark as delivered AFTER delivery succeeds
      job.delivered = true;
      job.status = data.success ? "complete" : "failed";
      job.output = data.output;
      job.exitCode = data.exitCode;
      job.durationMs = data.durationMs;
      job.updatedAt = Date.now();

      updateAsyncWidget();

      // Clean up result file
      try { fs.unlinkSync(resultPath); } catch {}
    } catch {}
  }

  function startResultWatcher() {
    if (asyncState.watcher) return;
    try {
      fs.mkdirSync(ASYNC_RESULTS_DIR, { recursive: true, mode: 0o700 });
      asyncState.watcher = fs.watch(ASYNC_RESULTS_DIR, (ev, file) => {
        if (ev !== "rename" || !file) return;
        const fileName = file.toString();
        if (!fileName.endsWith(".json")) return;
        const resultPath = path.join(ASYNC_RESULTS_DIR, fileName);
        setTimeout(() => processResultFile(resultPath), 100);
      });
      if (asyncState.watcher.unref) asyncState.watcher.unref();
    } catch {}
  }

  function spawnAsyncAgent(
    agentName: string,
    task: string,
    cwd: string,
    agents: AgentConfig[],
    options?: { fireAndForget?: boolean; name?: string },
  ): { id: string; error?: string } {
    const agent = agents.find(a => a.name === agentName);
    if (!agent) return { id: "", error: `Unknown agent: "${agentName}"` };

    const id = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(ASYNC_RESULTS_DIR, `${id}.json`);

    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(ASYNC_RESULTS_DIR, { recursive: true, mode: 0o700 });

    // Build pi args
    const piArgs: string[] = ["--mode", "json", "-p", "--no-session", "-nc"];
    if (agent.model) piArgs.push("--model", agent.model);
    if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));

    if (agent.systemPrompt?.trim()) {
      const promptPath = path.join(asyncDir, "system-prompt.md");
      fs.writeFileSync(promptPath, agent.systemPrompt, { mode: 0o600 });
      piArgs.push("--append-system-prompt", promptPath);
    }

    piArgs.push(`Task: ${task}`);

    const inv = getPiInvocation(piArgs);

    // Write config for the runner
    const configPath = path.join(os.tmpdir(), `pi-async-cfg-${id}.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      id,
      agent: agentName,
      task,
      cwd,
      model: agent.model,
      resultPath,
      asyncDir,
      sessionId: `${process.pid}:${process.cwd()}`,
      piCommand: inv.command,
      piArgs: inv.args,
    }), { mode: 0o600 });

    // Find the runner script
    const runnerPath = path.join(path.dirname(new URL(import.meta.url).pathname), "async-runner.ts");

    // Find jiti for TypeScript execution
    let jitiCliPath: string | undefined;
    try {
      const piPkgDir = path.dirname(require.resolve("@mariozechner/pi-coding-agent/package.json"));
      const candidate = path.join(piPkgDir, "node_modules/@mariozechner/jiti/lib/jiti-cli.mjs");
      if (fs.existsSync(candidate)) jitiCliPath = candidate;
    } catch {}

    const spawnArgs = jitiCliPath
      ? [jitiCliPath, runnerPath, configPath]
      : [runnerPath, configPath];

    const proc = spawn(process.execPath, spawnArgs, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
    });

    // Track the job
    const job: AsyncJob = {
      id,
      agent: agentName,
      name: options?.name,
      task: task.slice(0, 200),
      status: "queued",
      asyncDir,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      fireAndForget: options?.fireAndForget,
    };
    asyncState.jobs.set(id, job);
    updateAsyncWidget();
    ensureAsyncPoller();
    startResultWatcher();

    return { id };
  }

  // Start result watcher on session start
  pi.on("session_start", (_event, ctx) => {
    asyncState.lastCtx = ctx;
    ASYNC_RESULTS_DIR = path.join(ASYNC_BASE_DIR, `results-${process.pid}`);

    // Clean up orphaned results directories from crashed sessions
    try {
      for (const entry of fs.readdirSync(ASYNC_BASE_DIR)) {
        const m = entry.match(/^results-(\d+)$/);
        if (m) {
          try { process.kill(+m[1], 0); } catch {
            try { fs.rmSync(path.join(ASYNC_BASE_DIR, entry), { recursive: true, force: true }); } catch {}
          }
        }
      }
    } catch {}

    startResultWatcher();
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
    if (asyncState.watcher) { asyncState.watcher.close(); asyncState.watcher = null; }
    // Clean up PID-scoped results directory
    try { fs.rmSync(ASYNC_RESULTS_DIR, { recursive: true, force: true }); } catch {}
  });

  // /async-status command
  pi.registerCommand("async-status", {
    description: "Show status of background async agents — select one to view live output",
    handler: async (_args, ctx) => {
      const jobs = Array.from(asyncState.jobs.values());
      if (jobs.length === 0) {
        ctx.ui.notify("No async agents running or recently completed.", "info");
        return;
      }

      // If only completed agents, show static summary
      const running = jobs.filter(j => j.status === "running" || j.status === "queued");
      if (running.length === 0) {
        const lines: string[] = ["All agents completed:\n"];
        for (const job of jobs) {
          const dur = job.durationMs ? formatDuration(job.durationMs) : formatDuration(Date.now() - job.startedAt);
          const icon = job.status === "complete" ? "✅" : "❌";
          lines.push(`${icon} ${job.name || job.agent} (${dur}) — ${job.task.slice(0, 60)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Build selection list
      const options = running.map((j) => {
        const duration = formatDuration(Date.now() - j.startedAt);
        const taskPreview = j.task.length > 60 ? j.task.slice(0, 60) + "..." : j.task;
        return `${j.name || j.agent} (${duration}) — ${taskPreview}`;
      });

      const selected = await ctx.ui.select("View async agent output:", options);
      if (!selected) return;

      const idx = options.indexOf(selected);
      if (idx < 0) return;

      const job = running[idx];
      const outputPath = path.join(job.asyncDir, "output.log");

      // Create a live output viewer as an overlay
      await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
        const lines: string[] = [];
        let scrollOffset = 0;
        let maxScroll = 0;
        let following = true; // auto-scroll to bottom
        let closed = false;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;

        // Parse a JSON line from the output log into a display string
        function parseLine(raw: string): string | null {
          try {
            const ev = JSON.parse(raw);
            if (ev.type === "message_update" && ev.assistantMessageEvent) {
              const ae = ev.assistantMessageEvent;
              if (ae.type === "text_delta" && ae.delta) return ae.delta;
              if (ae.type === "thinking_delta" && ae.delta) return null;
              if (ae.type === "toolcall_delta" && ae.content) return null;
              return null;
            }
            if (ev.type === "tool_execution_start") {
              const name = ev.toolName || "tool";
              const cmd = ev.args?.command ? ` ${ev.args.command.slice(0, 80)}` : "";
              return `\n🔧 ${name}${cmd}`;
            }
            if (ev.type === "tool_execution_end") {
              const text = ev.result?.content?.[0]?.text || "";
              const prefix = ev.isError ? "✗" : "✓";
              return `\n${prefix} ${text.slice(0, 200)}`;
            }
            if (ev.type === "agent_end") return "\n--- Agent finished ---";
            return null;
          } catch {
            return null;
          }
        }

        // Read existing output and watch for new content
        let filePos = 0;
        let textBuffer = "";

        function readNewContent() {
          if (closed) return;
          try {
            const content = fs.readFileSync(outputPath, "utf-8");
            if (content.length > filePos) {
              const newContent = content.slice(filePos);
              filePos = content.length;
              textBuffer += newContent;

              // Process complete lines
              const parts = textBuffer.split("\n");
              textBuffer = parts.pop() || "";
              for (const part of parts) {
                if (!part.trim()) continue;
                const parsed = parseLine(part);
                if (parsed !== null) {
                  for (const l of parsed.split("\n")) {
                    if (l) lines.push(l);
                    else lines.push("");
                  }
                }
              }
              cachedWidth = undefined;
              cachedLines = undefined;
              tui.requestRender();
            }
          } catch {}
        }

        // Poll for new content every 500ms
        const poller = setInterval(readNewContent, 500);
        readNewContent();

        return {
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
              closed = true;
              clearInterval(poller);
              done(undefined);
              return;
            }
            if (matchesKey(data, Key.up)) {
              if (scrollOffset > 0) { scrollOffset--; following = false; cachedWidth = undefined; tui.requestRender(); }
              return;
            }
            if (matchesKey(data, Key.down)) {
              if (scrollOffset < maxScroll) { scrollOffset++; cachedWidth = undefined; tui.requestRender(); }
              if (scrollOffset >= maxScroll) following = true;
              return;
            }
            if (matchesKey(data, Key.pageUp)) {
              scrollOffset = Math.max(0, scrollOffset - 10); following = false; cachedWidth = undefined; tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.pageDown)) {
              scrollOffset = Math.min(maxScroll, scrollOffset + 10);
              if (scrollOffset >= maxScroll) following = true;
              cachedWidth = undefined; tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.home)) {
              scrollOffset = 0; following = false; cachedWidth = undefined; tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.end)) {
              scrollOffset = maxScroll; following = true; cachedWidth = undefined; tui.requestRender();
              return;
            }
          },

          invalidate() { cachedWidth = undefined; cachedLines = undefined; },

          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;

            const headerWidth = width - 2;
            const dur = formatDuration(Date.now() - job.startedAt);
            const status = readAsyncStatus(job.asyncDir);
            const state = status?.state || job.status;
            const stateIcon = state === "complete" ? "✅" : state === "failed" ? "❌" : "⏳";
            const header = truncateToWidth(`${stateIcon} ${job.name || job.agent} — ${dur} — ${job.task.slice(0, 40)}`, headerWidth);
            const footer = truncateToWidth("↑↓ scroll  PgUp/PgDn  Home/End  Esc close", headerWidth);
            const sep = "─".repeat(Math.min(width, headerWidth));

            // Wrap all lines to fit width
            const wrapped: string[] = [];
            for (const line of lines) {
              const w = wrapTextWithAnsi(line, width - 2);
              for (const wl of w) {
                wrapped.push(truncateToWidth(wl, width - 2));
              }
            }

            // Calculate visible area
            const viewHeight = Math.max(5, Math.min(30, ((tui as any).height ?? 24) - 8));
            maxScroll = Math.max(0, wrapped.length - viewHeight);

            // Auto-scroll to bottom
            if (following) {
              scrollOffset = maxScroll;
            }

            const visible = wrapped.slice(scrollOffset, scrollOffset + viewHeight);

            // Pad to viewHeight
            while (visible.length < viewHeight) visible.push("");

            cachedLines = [header, sep, ...visible, sep, footer];
            cachedWidth = width;
            return cachedLines;
          },

          dispose() {
            closed = true;
            clearInterval(poller);
          },
        };
      });
    },
  });

  // Kill an async agent by name, id prefix, or "all"
  function killAsyncAgent(target: string): { killed: string[]; errors: string[] } {
    const killed: string[] = [];
    const errors: string[] = [];
    const running = Array.from(asyncState.jobs.values()).filter(
      (j) => j.status === "running" || j.status === "queued",
    );

    if (running.length === 0) {
      errors.push("No running async agents.");
      return { killed, errors };
    }

    const targets = target.toLowerCase() === "all"
      ? running
      : running.filter(j =>
          (j.name && j.name.toLowerCase() === target.toLowerCase()) ||
          j.id.startsWith(target) ||
          j.agent.toLowerCase() === target.toLowerCase()
        );

    if (targets.length === 0) {
      errors.push(`No matching async agent for: ${target}`);
      return { killed, errors };
    }

    for (const job of targets) {
      const status = readAsyncStatus(job.asyncDir);
      if (status?.pid) {
        try {
          const tree = execFileSync("pstree", ["-p", String(status.pid)], { encoding: "utf-8", timeout: 3000 });
          const matches = tree.match(/\((\d+)\)/g);
          const allPids = matches ? [...new Set(matches.map((m: string) => parseInt(m.slice(1, -1), 10)))] : [status.pid];
          for (const pid of allPids) {
            try { process.kill(pid, "SIGKILL"); } catch {}
          }
        } catch {
          try { process.kill(status.pid, "SIGKILL"); } catch {}
          if (status.childPid) try { process.kill(status.childPid, "SIGKILL"); } catch {}
        }
      }
      const label = job.name || job.agent;
      killed.push(label);
      job.status = "failed";
      job.updatedAt = Date.now();
      setTimeout(() => { asyncState.jobs.delete(job.id); updateAsyncWidget(); }, 5000);
    }

    updateAsyncWidget();
    return { killed, errors };
  }

  // /async-kill command — accepts name/id/"all" or interactive selection
  pi.registerCommand("async-kill", {
    description: "Kill async agent(s) — /async-kill <name|id|all>",
    handler: async (_args, ctx) => {
      const arg = (_args || "").trim();

      // If arg provided, kill directly without interactive selection
      if (arg) {
        const { killed, errors } = killAsyncAgent(arg);
        if (killed.length > 0) {
          ctx.ui.notify(`Killed: ${killed.join(", ")}`, "info");
        }
        if (errors.length > 0) {
          ctx.ui.notify(errors.join("\n"), "warning");
        }
        return;
      }

      const running = Array.from(asyncState.jobs.values()).filter(
        (j) => j.status === "running" || j.status === "queued",
      );

      if (running.length === 0) {
        ctx.ui.notify("No running async agents.", "info");
        return;
      }

      // Build selection list: agent name + task preview
      const options = running.map((j) => {
        const duration = formatDuration(Date.now() - j.startedAt);
        const taskPreview = j.task.length > 60 ? j.task.slice(0, 60) + "..." : j.task;
        return `${j.agent} (${duration}) — ${taskPreview}`;
      });

      const selected = await ctx.ui.select("Kill which async agent?", options);
      if (!selected) return;

      const idx = options.indexOf(selected);
      if (idx < 0) return;

      const job = running[idx];

      // Kill entire process tree
      const status = readAsyncStatus(job.asyncDir);
      if (status?.pid) {
        const killLog: string[] = [];
        try {
          const tree = execFileSync("pstree", ["-p", String(status.pid)], { encoding: "utf-8", timeout: 3000 });
          killLog.push(`pstree output: ${tree.trim()}`);
          const matches = tree.match(/\((\d+)\)/g);
          const allPids = matches ? [...new Set(matches.map((m: string) => parseInt(m.slice(1, -1), 10)))] : [status.pid];
          killLog.push(`PIDs to kill: ${allPids.join(", ")}`);
          for (const pid of allPids) {
            try { process.kill(pid, "SIGKILL"); killLog.push(`killed ${pid}`); } catch (e: any) { killLog.push(`failed ${pid}: ${e.message}`); }
          }
        } catch (e: any) {
          killLog.push(`pstree failed: ${e.message}`);
          try { process.kill(status.pid, "SIGKILL"); killLog.push(`killed runner ${status.pid}`); } catch {}
          if (status.childPid) try { process.kill(status.childPid, "SIGKILL"); killLog.push(`killed child ${status.childPid}`); } catch {}
        }
        const logPath = path.join(job.asyncDir, "kill.log");
        fs.writeFileSync(logPath, killLog.join("\n"), "utf-8");
      }

      job.status = "failed";
      job.updatedAt = Date.now();
      updateAsyncWidget();
      ctx.ui.notify(`Killed: ${job.agent}`, "info");

      // Clean up after 5s
      setTimeout(() => {
        asyncState.jobs.delete(job.id);
        updateAsyncWidget();
      }, 5000);
    },
  });

  return { spawnAsyncAgent, killAsyncAgent };
}
