/**
 * Async agent infrastructure — background agent spawning, polling, result watching.
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { getPiInvocation } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const ASYNC_DIR = path.join(os.tmpdir(), "pi-async-agents");
const ASYNC_RESULTS_DIR = path.join(ASYNC_DIR, "results");
const ASYNC_POLL_INTERVAL_MS = 3000;

// ── Interfaces ───────────────────────────────────────────────────────────

interface AsyncJob {
  id: string;
  agent: string;
  task: string;
  status: "queued" | "running" | "complete" | "failed";
  asyncDir: string;
  startedAt: number;
  updatedAt: number;
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
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
): { spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[]) => { id: string; error?: string } } {
  const asyncState: AsyncState = {
    jobs: new Map(),
    poller: null,
    watcher: null,
    lastCtx: null,
  };

  function updateAsyncWidget() {
    if (!asyncState.lastCtx?.hasUI) return;
    const ctx = asyncState.lastCtx;
    const running = Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued");
    if (running.length > 0) {
      const names = running.map(j => j.agent).join(", ");
      ctx.ui.setStatus("async-agents", ctx.ui.theme.fg("warning", `⏳ ${running.length} async: ${names}`));
    } else {
      ctx.ui.setStatus("async-agents", undefined);
    }
  }

  function ensureAsyncPoller() {
    if (asyncState.poller) return;
    asyncState.poller = setInterval(() => {
      if (!asyncState.lastCtx?.hasUI) return;
      if (asyncState.jobs.size === 0) {
        updateAsyncWidget();
        if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
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

  function startResultWatcher() {
    if (asyncState.watcher) return;
    try {
      fs.mkdirSync(ASYNC_RESULTS_DIR, { recursive: true });
      asyncState.watcher = fs.watch(ASYNC_RESULTS_DIR, (ev, file) => {
        if (ev !== "rename" || !file) return;
        const fileName = file.toString();
        if (!fileName.endsWith(".json")) return;

        const resultPath = path.join(ASYNC_RESULTS_DIR, fileName);
        setTimeout(() => {
          try {
            if (!fs.existsSync(resultPath)) return;
            const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
            const job = asyncState.jobs.get(data.id);
            if (job) {
              job.status = data.success ? "complete" : "failed";
              job.output = data.output;
              job.exitCode = data.exitCode;
              job.durationMs = data.durationMs;
              job.updatedAt = Date.now();
            }

            // Notify user
            terminalNotify("pi", `Async agent ${data.agent} ${data.success ? "completed" : "failed"} (${formatDuration(data.durationMs)})`);

            // Surface result in conversation
            if (asyncState.lastCtx) {
              const status = data.success ? "✅ completed" : "❌ failed";
              const output = (data.output || "").slice(0, 3000);
              pi.sendMessage({
                customType: "async-agent-result",
                content: `## Async Agent Result: ${data.agent} ${status}\n\nTask: ${data.task}\nDuration: ${formatDuration(data.durationMs)}\n\n${output}`,
                display: true,
              }, { triggerTurn: true, deliverAs: "followUp" });
            }

            updateAsyncWidget();

            // Clean up result file
            try { fs.unlinkSync(resultPath); } catch {}

            // Remove completed jobs after 30s
            setTimeout(() => {
              asyncState.jobs.delete(data.id);
              updateAsyncWidget();
            }, 30000);
          } catch {}
        }, 100); // Small delay to ensure file is fully written
      });
      if (asyncState.watcher.unref) asyncState.watcher.unref();
    } catch {}
  }

  function spawnAsyncAgent(
    agentName: string,
    task: string,
    cwd: string,
    agents: AgentConfig[],
  ): { id: string; error?: string } {
    const agent = agents.find(a => a.name === agentName);
    if (!agent) return { id: "", error: `Unknown agent: "${agentName}"` };

    const id = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const asyncDir = path.join(ASYNC_DIR, id);
    const resultPath = path.join(ASYNC_RESULTS_DIR, `${id}.json`);

    fs.mkdirSync(asyncDir, { recursive: true });
    fs.mkdirSync(ASYNC_RESULTS_DIR, { recursive: true });

    // Build pi args
    const piArgs: string[] = ["--mode", "json", "-p", "--no-session"];
    if (agent.model) piArgs.push("--model", agent.model);
    if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));

    let systemPromptFile: string | undefined;
    if (agent.systemPrompt?.trim()) {
      const promptPath = path.join(asyncDir, "system-prompt.md");
      fs.writeFileSync(promptPath, agent.systemPrompt, { mode: 0o600 });
      piArgs.push("--append-system-prompt", promptPath);
      systemPromptFile = promptPath;
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
      piCommand: inv.command,
      piArgs: inv.args,
    }));

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

    // Spawn detached
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
      task: task.slice(0, 200),
      status: "queued",
      asyncDir,
      startedAt: Date.now(),
      updatedAt: Date.now(),
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
    startResultWatcher();
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
    if (asyncState.watcher) { asyncState.watcher.close(); asyncState.watcher = null; }
  });

  // /async-status command
  pi.registerCommand("async-status", {
    description: "Show status of background async agents",
    handler: async (_args, ctx) => {
      const jobs = Array.from(asyncState.jobs.values());
      if (jobs.length === 0) {
        ctx.ui.notify("No async agents running or recently completed.", "info");
        return;
      }

      const lines: string[] = ["## Async Agents\n"];
      lines.push("| Agent | Status | Duration | Task |");
      lines.push("|-------|--------|----------|------|");
      for (const job of jobs) {
        const duration = job.durationMs
          ? formatDuration(job.durationMs)
          : formatDuration(Date.now() - job.startedAt);
        const statusIcon = job.status === "complete" ? "✅" : job.status === "failed" ? "❌" : job.status === "running" ? "⏳" : "⏸️";
        const taskPreview = job.task.length > 50 ? job.task.slice(0, 50) + "..." : job.task;
        lines.push(`| ${job.agent} | ${statusIcon} ${job.status} | ${duration} | ${taskPreview} |`);
      }

      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  // /async-kill command — interactive selection
  pi.registerCommand("async-kill", {
    description: "Kill a running async agent",
    handler: async (_args, ctx) => {
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
          const tree = execSync(`pstree -p ${status.pid} 2>&1`, { encoding: "utf-8", timeout: 3000 });
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

  return { spawnAsyncAgent };
}
