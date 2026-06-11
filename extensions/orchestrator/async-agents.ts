/**
 * Async agent infrastructure — background agent spawning, polling, result watching.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.js";
import { getPiInvocation, getProjectTmpDir, PI_TMP_BASE_DIR } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────



const ASYNC_POLL_INTERVAL_MS = 3000;

// ── Interfaces ───────────────────────────────────────────────────────────

export interface AsyncJob {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: "queued" | "running" | "complete" | "failed";
  workerDir: string;
  startedAt: number;
  updatedAt: number;
  output?: string;
  exitCode?: number | null;
  durationMs?: number;
  delivered?: boolean;
  fireAndForget?: boolean;
  groupId?: string;
}

interface AsyncState {
  jobs: Map<string, AsyncJob>;
  poller: ReturnType<typeof setInterval> | null;
  watcher: fs.FSWatcher | null;
  lastCtx: any;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readAsyncStatus(workerDir: string): any | null {
  try {
    const statusPath = path.join(workerDir, "status.json");
    return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch { return null; }
}

/** Derive a stable directory name from a session file path. */
function sessionResultsDirName(): string {
  return `async-results-pid-${process.pid}`;
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
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string }) => { id: string; error?: string; model?: string };
  killAsyncAgent: (target: string) => { killed: string[]; errors: string[] };
  getAsyncJobs: () => Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }>;
} {
  let PROJECT_TMP_DIR = PI_TMP_BASE_DIR; // Updated to project-scoped dir on session_start
  let ASYNC_RESULTS_DIR = ""; // Set on session_start to project-scoped dir

  const ASYNC_DEBUG = !!process.env.PI_ASYNC_DEBUG;
  const EARLY_LOG_PATH = ASYNC_DEBUG ? path.join(PI_TMP_BASE_DIR, `early-debug-${process.pid}.log`) : "";
  let DEBUG_LOG_PATH = EARLY_LOG_PATH; // Starts with early log, moved to project dir on session_start
  function asyncLog(msg: string) {
    if (!ASYNC_DEBUG || !DEBUG_LOG_PATH) return;
    try { fs.appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${msg}\n`); } catch {}
  }

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
      ctx.ui.setStatus("1-async", ctx.ui.theme.fg("warning", `⏳ async: ${running.length}`));
    } else if (changed) {
      ctx.ui.setStatus("1-async", ctx.ui.theme.fg("muted", `💤 async: 0`));
    }
    // Always emit to pidash — browser may have reconnected and needs fresh state
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

  function ensureAsyncPoller() {
    if (asyncState.poller) return;
    asyncState.poller = setInterval(() => {
      try {
        if (!asyncState.lastCtx?.hasUI) return;
      } catch {
        // ctx is stale (session ended) — stop polling
        if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
        return;
      }
      if (asyncState.jobs.size === 0) {
        updateAsyncWidget();
        return;
      }

      for (const job of asyncState.jobs.values()) {
        if (job.status === "complete" || job.status === "failed") continue;
        const status = readAsyncStatus(job.workerDir);
        if (status) {
          job.status = status.state;
          job.updatedAt = status.lastUpdate ?? Date.now();
          if (status.exitCode !== undefined) job.exitCode = status.exitCode;

          // Check if process is actually alive — clean up zombies
          if (job.status === "running" && status.pid) {
            try { process.kill(status.pid, 0); } catch {
              job.status = "failed";
              job.updatedAt = Date.now();
              // Check if this completes a group — deliver remaining siblings' results
              if (job.groupId) {
                const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
                const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
                if (pending.length === 0) deliverGroupResults(groupJobs);
              }
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
      } catch (e: any) { console.debug("[async-agents] result file scan failed:", e?.message || e); }

      // Remove completed/failed jobs older than 30s (skip undelivered group members)
      for (const [id, job] of asyncState.jobs.entries()) {
        if ((job.status === "complete" || job.status === "failed")
            && Date.now() - job.updatedAt > 30000
            && (job.delivered || !job.groupId)) {
          asyncState.jobs.delete(id);
        }
      }
      updateAsyncWidget();
    }, ASYNC_POLL_INTERVAL_MS);
    if (asyncState.poller.unref) asyncState.poller.unref();
  }

  /** Deliver all results from a completed group as a single combined message. */
  function deliverGroupResults(groupJobs: AsyncJob[]) {
    if (!asyncState.lastCtx) return;

    // Ingest any unprocessed result files — zombie/kill paths may trigger delivery
    // before processResultFile() has read all group members' outputs
    for (const j of groupJobs) {
      if (j.output !== undefined) continue; // Already ingested
      const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
      try {
        const data = JSON.parse(fs.readFileSync(rp, "utf-8"));
        j.output = data.output;
        j.exitCode = data.exitCode;
        j.durationMs = data.durationMs;
        if (data.success !== undefined) j.status = data.success ? "complete" : "failed";
        asyncLog(`deliverGroupResults: late-ingested result for ${j.id}`);
      } catch (e: any) { asyncLog(`deliverGroupResults: late-ingest failed for ${j.id}: ${e?.message}`); }
    }

    // Skip delivery if ALL jobs in group are fire-and-forget
    if (groupJobs.every(j => j.fireAndForget)) {
      for (const j of groupJobs) j.delivered = true;
      // Clean up result files for fire-and-forget groups
      for (const j of groupJobs) {
        const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
        try { fs.unlinkSync(rp); } catch (e: any) { asyncLog(`unlink failed ${rp}: ${e?.message}`); }
      }
      return;
    }

    const sections: string[] = [];
    for (const j of groupJobs) {
      if (j.fireAndForget) { j.delivered = true; continue; }
      const resultStatus = j.status === "complete" ? "✅ completed" : "❌ failed";
      const displayName = j.name || j.agent;
      const output = (j.output || "").slice(0, 3000);
      sections.push(`## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${j.task}\nDuration: ${formatDuration(j.durationMs || 0)}\n\n${output}`);
      j.delivered = true;
    }

    if (sections.length > 0) {
      pi.sendMessage({
        customType: "async-agent-result",
        content: sections.join("\n\n---\n\n"),
        display: true,
      }, { triggerTurn: true, deliverAs: "followUp" });
    }

    // Clean up result files for group members now that delivery succeeded
    for (const j of groupJobs) {
      const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
      try { fs.unlinkSync(rp); } catch (e: any) { asyncLog(`unlink failed ${rp}: ${e?.message}`); }
    }
  }

  function processResultFile(resultPath: string) {
    try {
      const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      const job = asyncState.jobs.get(data.id);
      asyncLog(`processResultFile: ${path.basename(resultPath)} job=${!!job} delivered=${job?.delivered} hasCtx=${!!asyncState.lastCtx} fireAndForget=${job?.fireAndForget} groupId=${job?.groupId}`);
      if (!job) return;
      if (job.delivered) return; // Already delivered to user
      // Skip if already ingested (grouped jobs stay on disk until group delivers)
      if (job.output !== undefined) return;

      // Update job state immediately (before group check)
      job.status = data.success ? "complete" : "failed";
      job.output = data.output;
      job.exitCode = data.exitCode;
      job.durationMs = data.durationMs;
      job.updatedAt = Date.now();

      // Notify terminal per-agent (lightweight, non-conversational)
      const displayName = job.name || data.agent;
      terminalNotify("pi", `Async agent ${displayName} ${data.success ? "completed" : "failed"} (${formatDuration(data.durationMs)})`);

      // Clean up result file — for grouped jobs, defer to deliverGroupResults
      if (!job.groupId) {
        try { fs.unlinkSync(resultPath); } catch (e: any) { asyncLog(`unlink failed ${resultPath}: ${e?.message}`); }
      }

      // Group-aware delivery: hold results until ALL jobs in the group are done
      if (job.groupId) {
        const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
        const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
        asyncLog(`group ${job.groupId}: ${groupJobs.length} total, ${pending.length} pending`);
        if (pending.length > 0) {
          // Not all group members done yet — hold delivery
          updateAsyncWidget();
          return;
        }
        // All group members done — deliver combined result
        deliverGroupResults(groupJobs);
        updateAsyncWidget();
        return;
      }

      // Non-grouped job: deliver immediately (existing behavior)
      if (asyncState.lastCtx && !job.fireAndForget) {
        const resultStatus = data.success ? "✅ completed" : "❌ failed";
        const output = (data.output || "").slice(0, 3000);
        pi.sendMessage({
          customType: "async-agent-result",
          content: `## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${data.task}\nDuration: ${formatDuration(data.durationMs)}\n\n${output}`,
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
      }

      job.delivered = true;
      // Result file already deleted above (non-grouped path)
      updateAsyncWidget();
    } catch (e: any) {
      asyncLog(`processResultFile ERROR: ${e.message}`);
    }
  }

  let watchedDir: string | null = null;
  function startResultWatcher() {
    // Rebind watcher if results dir changed (session switch)
    if (asyncState.watcher && watchedDir === ASYNC_RESULTS_DIR) return;
    if (asyncState.watcher) { asyncState.watcher.close(); asyncState.watcher = null; }
    watchedDir = ASYNC_RESULTS_DIR;
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
    } catch (e: any) { console.debug("[async-agents] watcher setup failed:", e?.message || e); }
  }

  function spawnAsyncAgent(
    agentName: string,
    task: string,
    cwd: string,
    agents: AgentConfig[],
    options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string },
  ): { id: string; error?: string; model?: string } {
    const agent = agents.find(a => a.name === agentName);
    if (!agent) return { id: "", error: `Unknown agent: "${agentName}"` };

    const id = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workerDir = path.join(PROJECT_TMP_DIR, id);
    const resultPath = path.join(ASYNC_RESULTS_DIR, `${id}.json`);

    fs.mkdirSync(workerDir, { recursive: true });
    fs.mkdirSync(ASYNC_RESULTS_DIR, { recursive: true, mode: 0o700 });

    // Write session marker so restore can match jobs to sessions
    let parentStartTime = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        parentStartTime = fs.readFileSync(`/proc/${process.pid}/stat`, "utf-8").split(" ")[21] || "";
        if (parentStartTime) break;
      } catch { /* retry */ }
    }
    if (!parentStartTime) {
      console.debug("[async-agents] WARNING: could not read /proc/self/stat starttime after 3 attempts");
    }
    fs.writeFileSync(path.join(workerDir, "session.json"), JSON.stringify({
      resultsDir: ASYNC_RESULTS_DIR,
      fireAndForget: options?.fireAndForget || false,
      parentPid: process.pid,
      parentStartTime,
    }), { mode: 0o600 });

    // Build pi args
    const piArgs: string[] = ["--mode", "json", "-p", "--no-session", "-nc"];
    const effectiveModel = agent.model || options?.parentModelId;
    if (effectiveModel) piArgs.push("--model", effectiveModel);
    const effectiveProvider = agent.provider || options?.parentProvider;
    if (effectiveProvider) piArgs.push("--provider", effectiveProvider);
    if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));

    if (agent.systemPrompt?.trim()) {
      const promptPath = path.join(workerDir, "system-prompt.md");
      fs.writeFileSync(promptPath, agent.systemPrompt, { mode: 0o600 });
      piArgs.push("--append-system-prompt", promptPath);
    }

    piArgs.push(`Task: ${task}`);

    const inv = getPiInvocation(piArgs);

    // Write config for the runner
    const configPath = path.join(PROJECT_TMP_DIR, `async-cfg-${id}.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      id,
      agent: agentName,
      task,
      cwd,
      model: effectiveModel,
      resultPath,
      workerDir,
      sessionId: `${process.pid}:${process.cwd()}`,
      piCommand: inv.command,
      piArgs: inv.args,
    }), { mode: 0o600 });

    // Find the runner script
    const runnerPath = path.join(path.dirname(new URL(import.meta.url).pathname), "async-runner.ts");

    // Find jiti for TypeScript execution
    let jitiCliPath: string | undefined;
    // Strategy 1: resolve from pi's own require context
    try {
      const piPkgDir = path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
      const candidate = path.join(piPkgDir, "node_modules/jiti/lib/jiti-cli.mjs");
      if (fs.existsSync(candidate)) jitiCliPath = candidate;
    } catch (e: any) {
      asyncLog(`jiti strategy 1 (require.resolve) failed: ${e?.message || e}`);
    }
    // Strategy 2: resolve from the pi binary (works for global npm installs)
    if (!jitiCliPath) {
      try {
        const piScript = process.argv[1];
        if (piScript) {
          const realPath = fs.realpathSync(piScript);
          // pi script -> dist/cli.js, package root is 2 levels up
          const piPkgDir = path.dirname(path.dirname(realPath));
          const candidate = path.join(piPkgDir, "node_modules/jiti/lib/jiti-cli.mjs");
          if (fs.existsSync(candidate)) jitiCliPath = candidate;
        }
      } catch (e: any) {
        asyncLog(`jiti strategy 2 (process.argv) failed: ${e?.message || e}`);
      }
    }

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
      workerDir,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      fireAndForget: options?.fireAndForget,
      groupId: options?.groupId,
    };
    asyncState.jobs.set(id, job);
    updateAsyncWidget();
    ensureAsyncPoller();
    startResultWatcher();

    return { id, model: effectiveModel };
  }

  // Start result watcher on session start
  pi.on("session_start", (_event, ctx) => {
    asyncState.lastCtx = ctx;

    // Set project-scoped dir first (getProjectTmpDir creates it if missing)
    PROJECT_TMP_DIR = getProjectTmpDir(ctx.cwd);

    // Set results dir — PID-scoped under project dir
    ASYNC_RESULTS_DIR = path.join(PROJECT_TMP_DIR, sessionResultsDirName());
    const projectLogPath = path.join(PROJECT_TMP_DIR, "debug.log");
    // Move early startup logs to project dir
    if (EARLY_LOG_PATH && fs.existsSync(EARLY_LOG_PATH)) {
      try {
        fs.appendFileSync(projectLogPath, fs.readFileSync(EARLY_LOG_PATH, "utf-8"));
        fs.unlinkSync(EARLY_LOG_PATH);
      } catch {}
    }
    DEBUG_LOG_PATH = projectLogPath;

    // Zombie cleanup: scan project dir for dead agents
    try {
      for (const entry of fs.readdirSync(PROJECT_TMP_DIR)) {
        const jobDir = path.join(PROJECT_TMP_DIR, entry);
        try {
          if (!fs.statSync(jobDir).isDirectory()) continue;
          const markerPath = path.join(jobDir, "session.json");
          // Only process dirs that have session.json (agent dirs)
          if (!fs.existsSync(markerPath)) continue;
          const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
          // Skip our own session's agents
          if (marker.resultsDir === ASYNC_RESULTS_DIR) continue;
          const parentPid = marker.parentPid;
          const parentStartTime = marker.parentStartTime;
          if (!parentPid || !parentStartTime) {
            // Missing identity — can't safely verify, skip
            continue;
          }
          // Check if parent pi process is alive via /proc/PID/stat starttime
          try {
            const stat = fs.readFileSync(`/proc/${parentPid}/stat`, "utf-8");
            const currentStartTime = stat.split(" ")[21];
            if (currentStartTime === parentStartTime) continue; // alive, same process
          } catch {} // /proc not found = dead
          // Parent dead or PID reused — zombie, delete
          try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
        } catch {} // skip unreadable dirs
      }
    } catch (e: any) { console.debug("[async-agents] zombie cleanup failed:", e?.message?.slice(0, 100)); }

    asyncLog(`session_start: resultsDir=${path.basename(ASYNC_RESULTS_DIR)}`);

    // Restore jobs from status files in PROJECT_TMP_DIR that belong to this session
    try {
      for (const entry of fs.readdirSync(PROJECT_TMP_DIR)) {
        if (entry.startsWith("session-") || entry.startsWith("pid-")) continue;
        const jobDir = path.join(PROJECT_TMP_DIR, entry);
        const status = readAsyncStatus(jobDir);
        if (!status) continue;
        // Check if this job belongs to our session
        let marker: any;
        try {
          marker = JSON.parse(fs.readFileSync(path.join(jobDir, "session.json"), "utf-8"));
          if (marker.resultsDir !== ASYNC_RESULTS_DIR) continue;
        } catch {
          continue;
        }
        const id = status.runId;
        if (!id || asyncState.jobs.has(id)) continue;
        const isAlive = status.pid ? (() => { try { process.kill(status.pid, 0); return true; } catch { return false; } })() : false;
        const isComplete = status.state === "complete" || status.state === "failed";
        // Always restore — poller's zombie check will mark dead ones as failed
        if (isAlive || isComplete || status.state === "running") {
          const job: AsyncJob = {
            id,
            agent: status.agent || "unknown",
            task: (status.task || "").slice(0, 200),
            status: isComplete ? status.state : "running",
            workerDir: path.join(PROJECT_TMP_DIR, entry),
            startedAt: status.startedAt || Date.now(),
            updatedAt: status.lastUpdate || Date.now(),
            exitCode: status.exitCode,
            durationMs: status.endedAt ? status.endedAt - status.startedAt : undefined,
            fireAndForget: marker.fireAndForget || false,
          };
          asyncState.jobs.set(id, job);
          asyncLog(`restored job: ${id} state=${job.status}`);
        }
      }
    } catch (e: any) { console.debug("[async-agents] job restore failed:", e?.message || e); }

    // Start poller if we have jobs or unprocessed result files
    let hasResultFiles = false;
    try {
      hasResultFiles = fs.existsSync(ASYNC_RESULTS_DIR) && fs.readdirSync(ASYNC_RESULTS_DIR).some(f => f.endsWith(".json"));
    } catch (e: any) { console.debug("[async-agents] result files check failed:", e?.message || e); }
    if (asyncState.jobs.size > 0 || hasResultFiles) {
      ensureAsyncPoller();
    }
    updateAsyncWidget(); // Always set status (shows "0 async agents" when idle)

    startResultWatcher();
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    asyncLog(`shutdown: jobs=${asyncState.jobs.size}`);
    if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
    if (asyncState.watcher) { asyncState.watcher.close(); asyncState.watcher = null; }
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
      const outputPath = path.join(job.workerDir, "output.log");

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
        let lastLoggedError = "";

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
          } catch (e: any) {
            if (e?.code === "ENOENT") return;
            const msg = e?.message || String(e);
            if (msg !== lastLoggedError) {
              lastLoggedError = msg;
              console.debug("[async-agents] live output read failed:", msg);
            }
          }
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
            const status = readAsyncStatus(job.workerDir);
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
      const status = readAsyncStatus(job.workerDir);
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
      // Check if this completes a group — deliver remaining siblings' results
      if (job.groupId) {
        const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
        const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
        if (pending.length === 0) {
          deliverGroupResults(groupJobs);
        }
      }
      // Delay cleanup — skip auto-delete for undelivered group members (let reaper handle them)
      if (!job.groupId || job.delivered) {
        setTimeout(() => { asyncState.jobs.delete(job.id); updateAsyncWidget(); }, 5000);
      }
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
      const status = readAsyncStatus(job.workerDir);
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
        const logPath = path.join(job.workerDir, "kill.log");
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

  // Handle async-kill from pidash browser UI
  pi.events.on("pidash:async-kill", (target: unknown) => {
    if (typeof target === "string") {
      killAsyncAgent(target);
    }
  });

  return {
    spawnAsyncAgent,
    killAsyncAgent,
    getAsyncJobs: () => Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued"),
  };
}
