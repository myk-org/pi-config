/**
 * Async agent infrastructure — background agent spawning, polling, result watching.
 */

import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { discoverAgents } from "./agents.js";
import { resolveAgentModelProvider } from "./resolve-agent-model.js";
import { getPiInvocation, getProjectTmpDir, parseProcStartTime, djb2Hash } from "./utils.js";
import { addReviewerPending, recordReviewerResult, countFindings, readReviewState, markTestsPassed, markTestsFailed } from "./pi-config-review-state.js";
import { getMainBranch } from "./git-helpers.js";
import { waitForResultFiles } from "./async-wait.js";
import { openAsyncStatusOverlay } from "./async-status-ui.js";
export { autoCompleteTask, autoMarkInProgress } from "./task-lifecycle.js";
import { autoCompleteTask, autoMarkInProgress } from "./task-lifecycle.js";
import { setSlot } from "./status-bar.js";

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
  onComplete?: () => void;
  groupId?: string;
  taskId?: string;
  cwd?: string;
  projectCwd?: string;
  sessionId?: string;
  model?: string;
}

/** Get the effective working directory for a job. */
function jobCwd(job: { cwd?: string; projectCwd?: string }): string {
  return job.cwd || job.projectCwd || process.cwd();
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
  let startTime = "";
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf-8");
    startTime = parseProcStartTime(stat) || "";
  } catch {}
  return startTime
    ? `async-results-pid-${process.pid}-${startTime}`
    : `async-results-pid-${process.pid}`;
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
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; onComplete?: () => void; persistSession?: boolean }) => { id: string; error?: string; model?: string };
  killAsyncAgent: (target: string) => { killed: string[]; errors: string[] };
  getAsyncJobs: () => Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }>;
} {
  let PROJECT_TMP_DIR = path.join(process.cwd(), ".pi", "tmp"); // Computed only; created on session_start
  let ASYNC_RESULTS_DIR = ""; // Set on session_start to project-scoped dir

  const ASYNC_DEBUG = !!process.env.PI_ASYNC_DEBUG;
  const EARLY_LOG_PATH = ASYNC_DEBUG ? path.join(PROJECT_TMP_DIR, `early-debug-${process.pid}.log`) : "";
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
    try {
      const ctx = asyncState.lastCtx;
      const running = Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued");
      const names = running.map(j => j.name || j.agent).join(", ");
      const widgetKey = `${running.length}:${names}`;
      const changed = widgetKey !== lastWidgetKey;
      lastWidgetKey = widgetKey;
      if (running.length > 0) {
        setSlot("async", ctx.ui.theme.fg("warning", `⏳ async: ${running.length}`), ctx);
      } else if (changed) {
        setSlot("async", ctx.ui.theme.fg("muted", `💤 async: 0`), ctx);
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
    } catch { /* stale ctx after session replacement */ }
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
              // Process exited — check if it wrote a result file first
              const resultFilePath = path.join(ASYNC_RESULTS_DIR, `${job.id}.json`);
              if (fs.existsSync(resultFilePath)) {
                // Result file exists — ingest it so output/durationMs are populated
                try {
                  const data = JSON.parse(fs.readFileSync(resultFilePath, "utf-8"));
                  job.status = data.success ? "complete" : "failed";
                  job.output = data.output;
                  job.exitCode = data.exitCode;
                  job.durationMs = data.durationMs;
                  job.updatedAt = Date.now();
                  if (job.agent.startsWith("code-reviewer-")) {
                    const findings = countFindings(typeof data.output === "string" ? data.output : "");
                    try { recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings); } catch {}
                  }
                  try { fs.unlinkSync(resultFilePath); } catch {}
                } catch {
                  job.status = "failed";
                  job.output = "Process exited before result could be read";
                  job.durationMs = Date.now() - job.startedAt;
                  job.updatedAt = Date.now();
                  if (job.agent.startsWith("code-reviewer-")) {
                    try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch {}
                  }
                }
              } else {
                job.status = "failed";
                job.output = "Process exited without producing results";
                job.durationMs = Date.now() - job.startedAt;
                job.updatedAt = Date.now();
                // Record killed reviewer as having 0 findings — prevents permanent commit block
                if (job.agent.startsWith("code-reviewer-")) {
                  try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch { /* best-effort */ }
                }
              }
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
  let groupDeliveryInProgress = new Set<string>();
  async function deliverGroupResults(groupJobs: AsyncJob[]) {
    // Guard against duplicate concurrent invocations
    const gid = groupJobs[0]?.groupId;
    if (gid && groupDeliveryInProgress.has(gid)) return;
    if (gid) groupDeliveryInProgress.add(gid);
    try {
    if (!asyncState.lastCtx) return;

    // Ingest any unprocessed result files — zombie/kill paths may trigger delivery
    // before processResultFile() has read all group members' outputs.
    // Wait up to 2s total (not per-job) for all missing result files.
    const lateIngestedIds = new Set<string>();
    // Wait for non-failed, non-fireAndForget jobs that haven't been ingested yet
    const waitJobs = groupJobs.filter(j => j.output === undefined && !j.fireAndForget && j.status !== "failed");
    if (waitJobs.length > 0) {
      await waitForResultFiles(ASYNC_RESULTS_DIR, waitJobs.map(j => j.id), 2000);
    }
    // Ingest ALL jobs with missing output (including failed ones that may have a result file)
    const uningestedJobs = groupJobs.filter(j => j.output === undefined && !j.fireAndForget);
    for (const j of uningestedJobs) {
      if (j.output !== undefined) continue;
      const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
      try {
        const data = JSON.parse(fs.readFileSync(rp, "utf-8"));
        j.output = data.output;
        j.exitCode = data.exitCode;
        j.durationMs = data.durationMs;
        if (data.success !== undefined) j.status = data.success ? "complete" : "failed";
        lateIngestedIds.add(j.id);
        asyncLog(`deliverGroupResults: late-ingested result for ${j.id}`);
      } catch (e: any) { asyncLog(`deliverGroupResults: late-ingest failed for ${j.id}: ${e?.message}`); }
    }

    // Track reviewer completions for late-ingested code-reviewer jobs only
    // (jobs already processed by processResultFile were tracked there)
    for (const j of groupJobs) {
      if (!j.agent.startsWith("code-reviewer-") || !lateIngestedIds.has(j.id)) continue;
      try {
        const output = typeof j.output === "string" ? j.output : "";
        const findings = countFindings(output);
        // -1 means invalid JSON output — treat conservatively as having findings
        recordReviewerResult(jobCwd(j), j.agent, findings < 0 ? 1 : findings);
      } catch { /* best-effort */ }
    }

    // Skip delivery if ALL jobs in group are fire-and-forget
    if (groupJobs.every(j => j.fireAndForget)) {
      for (const j of groupJobs) {
        if (j.onComplete) {
          try { j.onComplete(); } catch (e: any) { asyncLog(`onComplete callback failed for ${j.id}: ${e?.message}`); }
        }
        j.delivered = true;
      }
      // Clean up result files for fire-and-forget groups
      for (const j of groupJobs) {
        const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
        try { fs.unlinkSync(rp); } catch (e: any) { asyncLog(`unlink failed ${rp}: ${e?.message}`); }
      }
      return;
    }

    // Emit lifecycle events for pi-tasks RPC bridge (one per job)
    for (const j of groupJobs) {
      if (j.status === "complete") {
        pi.events.emit("subagents:completed", { id: j.id, result: j.output || "" });
      } else if (j.status === "failed") {
        pi.events.emit("subagents:failed", { id: j.id, error: j.output || "Agent failed", result: j.output || "", status: "failed" });
      }
    }

    const sections: string[] = [];
    for (const j of groupJobs) {
      if (j.fireAndForget) { j.delivered = true; continue; }
      const resultStatus = j.status === "complete" ? "✅ completed" : "❌ failed";
      const displayName = j.name || j.agent;
      const output = (j.output || "").slice(0, 3000);
      let autoCompleteError = "";
      // Auto-complete linked task directly in the store file (no AI involvement)
      if (j.taskId && j.taskId !== "-1" && j.status === "complete" && j.cwd) {
        try {
          const completed = await autoCompleteTask(j.taskId, j.projectCwd || j.cwd, j.sessionId);
          asyncLog(`auto-completed task #${j.taskId}: ${completed}`);
        } catch (e: any) {
          autoCompleteError = `\n\n⚠️ Failed to auto-complete task #${j.taskId}: ${e?.message}. Run TaskUpdate(taskId="${j.taskId}", status="completed") manually.`;
          asyncLog(`auto-complete failed for task #${j.taskId}: ${e?.message}`);
        }
      }
      const duration = j.durationMs || (j.updatedAt ? j.updatedAt - j.startedAt : 0);
      sections.push(`## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${j.task}\nDuration: ${formatDuration(duration)}\n\n${output}${autoCompleteError}`);
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
    } finally {
      if (gid) groupDeliveryInProgress.delete(gid);
    }
  }

  async function processResultFile(resultPath: string) {
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

      // Track reviewer completion for review loop enforcement
      if (job.agent.startsWith("code-reviewer-")) {
        try {
          const output = typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? "");
          const findings = countFindings(output);
          // -1 means invalid JSON output — treat conservatively as having findings
          recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings);
        } catch { /* best-effort */ }
        // Clear reviewer session if context usage > 80% to prevent overflow on next cycle
        // Use model context window from the agent's effective model.
        // If agent uses a custom model, we pass its context window via the config.
        // Fall back to orchestrator's model context window.
        const contextWindow = data.contextWindow || asyncState.lastCtx?.model?.contextWindow || 0;
        if (data.lastUsage?.totalTokens && data.lastUsage.totalTokens > 0 && contextWindow > 0) {
          const pct = (data.lastUsage.totalTokens / contextWindow) * 100;
          if (pct > 80) {
            const sessId = `async-${job.agent}-${djb2Hash(job.agent + ':' + (jobCwd(job)) + ':' + (asyncState.lastCtx?.sessionManager?.getSessionId?.() || '')).toString(36)}`;
            try {
              // Find and delete the session file to force fresh on next cycle
              const sessDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
              const cwdKey = (jobCwd(job)).replace(/\//g, '-').replace(/^-/, '--') + '--';
              const sessPath = path.join(sessDir, cwdKey);
              const files = fs.existsSync(sessPath) ? fs.readdirSync(sessPath) : [];
              for (const f of files) {
                if (f.includes(sessId)) {
                  fs.unlinkSync(path.join(sessPath, f));
                  asyncLog(`Cleared session for ${job.agent} (context ${Math.round(pct)}%)`);
                  break;
                }
              }
            } catch { /* best-effort */ }
          }
        }
      }

      // Track test agent completion for review state test tracking
      if (job.agent === "test-automator" || job.agent === "test-runner") {
        try {
          if (data.success) {
            markTestsPassed(jobCwd(job));
          } else {
            markTestsFailed(jobCwd(job));
          }
        } catch (e: any) { console.debug(`[async-agents] markTests(Passed|Failed) failed for ${job.agent}: ${e?.message}`); }
      }

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

      // Emit lifecycle events for pi-tasks RPC bridge
      if (data.success) {
        pi.events.emit("subagents:completed", { id: job.id, result: data.output || "" });
      } else {
        pi.events.emit("subagents:failed", { id: job.id, error: data.output || "Agent failed", result: data.output || "", status: "failed" });
      }

      // Non-grouped job: deliver immediately (existing behavior)
      if (asyncState.lastCtx && !job.fireAndForget) {
        const resultStatus = data.success ? "✅ completed" : "❌ failed";
        let autoCompleteError = "";
        // Auto-complete linked task directly in the store file (no AI involvement)
        if (job.taskId && job.taskId !== "-1" && data.success && job.cwd) {
          try {
            const completed = await autoCompleteTask(job.taskId, job.projectCwd || job.cwd, job.sessionId);
            asyncLog(`auto-completed task #${job.taskId}: ${completed}`);
          } catch (e: any) {
            autoCompleteError = `\n\n⚠️ Failed to auto-complete task #${job.taskId}: ${e?.message}. Run TaskUpdate(taskId="${job.taskId}", status="completed") manually.`;
            asyncLog(`auto-complete failed for task #${job.taskId}: ${e?.message}`);
          }
        }
        const maxOutput = 3000 - autoCompleteError.length;
        const output = (data.output || "").slice(0, Math.max(maxOutput, 500));
        pi.sendMessage({
          customType: "async-agent-result",
          content: `## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${data.task}\nDuration: ${formatDuration(data.durationMs)}\n\n${output}${autoCompleteError}`,
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
      }

      // Invoke onComplete callback if registered (e.g., dreaming → rebuildAndOrganize)
      if (job.onComplete) {
        try { job.onComplete(); } catch (e: any) { asyncLog(`onComplete callback failed for ${job.id}: ${e?.message}`); }
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
    options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; onComplete?: () => void; persistSession?: boolean },
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
        parentStartTime = parseProcStartTime(fs.readFileSync(`/proc/${process.pid}/stat`, "utf-8")) || "";
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
      taskId: options?.taskId || null,
      cwd,
      projectCwd: asyncState.lastCtx?.sessionManager?.getCwd?.() || null,
      sessionId: asyncState.lastCtx?.sessionManager?.getSessionId?.() || null,
    }), { mode: 0o600 });

    // Track reviewer spawn BEFORE building args — addReviewerPending sets status to
    // in_progress, so all reviewers in the same batch see consistent state.
    if (agentName.startsWith("code-reviewer-")) {
      try { addReviewerPending(cwd, agentName); } catch { /* best-effort */ }
    }

    // Build pi args
    // Reviewers persist sessions during the review loop (cycle 2+) for cross-cycle context.
    // Fresh session on first cycle (needs_review/none), reuse on subsequent cycles (has_findings).
    let persistSession = options?.persistSession === true;
    if (!persistSession && agentName.startsWith("code-reviewer-")) {
      const reviewState = readReviewState(cwd);
      persistSession = reviewState.status === "has_findings" || reviewState.status === "in_progress";
    }
    const piArgs: string[] = ["--mode", "json", "-p", "-nc"];
    if (!persistSession) piArgs.push("--no-session");
    // Deterministic session ID for provider cache affinity + optional session reuse.
    // When persistSession is true, omits --no-session so the session persists to disk.
    // Same agent + cwd gets the same session ID across calls.
    const parentSessionId = asyncState.lastCtx?.sessionManager?.getSessionId?.() || '';
    const sessionIdSource = persistSession
      ? agentName + ':' + cwd + ':' + parentSessionId
      : agentName + ':' + task.slice(0, 100);
    const deterministicSessionId = `async-${agentName}-${djb2Hash(sessionIdSource).toString(36)}`;
    piArgs.push("--session-id", deterministicSessionId);
    const { model: effectiveModel, provider: effectiveProvider } = resolveAgentModelProvider(agentName, agent, options?.parentModelId, options?.parentProvider, cwd);
    if (effectiveModel) piArgs.push("--model", effectiveModel);
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
      contextWindow: asyncState.lastCtx?.model?.contextWindow || 0,
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

    // Resolve base branch for reviewers so they diff against the correct target
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      PI_SUBAGENT_CHILD: "1",
      PI_AGENT_NAME: agentName,
    };
    if (agentName.startsWith("code-reviewer-") || agentName === "test-automator" || agentName === "test-runner") {
      try {
        const prBase = spawnSync("gh", ["pr", "view", "--json", "baseRefName", "--jq", ".baseRefName"], {
          cwd, timeout: 5000, encoding: "utf-8",
        });
        if (prBase.status === 0 && prBase.stdout?.trim()) {
          spawnEnv.PI_REVIEW_BASE_BRANCH = prBase.stdout.trim();
          spawnEnv.PI_HAS_PR = "true";
        } else {
          spawnEnv.PI_REVIEW_BASE_BRANCH = getMainBranch(cwd) || "main";
          // Only set PI_HAS_PR=false if gh confirmed no PR exists.
          // Other failures (timeout, auth, network) default to true to avoid skipping PR checks.
          const noPr = prBase.stderr?.includes("no pull requests found") || false;
          spawnEnv.PI_HAS_PR = noPr ? "false" : "true";
        }
      } catch {
        spawnEnv.PI_REVIEW_BASE_BRANCH = getMainBranch(cwd) || "main";
        // Exception (e.g., gh not found) — default to true to avoid skipping PR checks
        spawnEnv.PI_HAS_PR = "true";
      }
    }

    const proc = spawn(process.execPath, spawnArgs, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
      env: spawnEnv,
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
      onComplete: options?.onComplete,
      groupId: options?.groupId,
      taskId: options?.taskId,
      cwd,
      projectCwd: asyncState.lastCtx?.sessionManager?.getCwd?.(),
      sessionId: asyncState.lastCtx?.sessionManager?.getSessionId?.(),
      model: effectiveModel,
    };
    asyncState.jobs.set(id, job);

    // addReviewerPending already called above (before piArgs construction)

    updateAsyncWidget();
    ensureAsyncPoller();
    startResultWatcher();

    // Auto-mark linked task as in_progress AFTER successful spawn
    if (options?.taskId && options.taskId !== "-1") {
      autoMarkInProgress(options.taskId, asyncState.lastCtx?.sessionManager?.getCwd?.() || cwd, asyncState.lastCtx?.sessionManager?.getSessionId?.() || undefined)
        .catch(() => {});  // best-effort, don't block spawn
    }

    return { id, model: effectiveModel };
  }

  // Start result watcher on session start
  pi.on("session_start", (_event, ctx) => {
    asyncState.lastCtx = ctx;

    // Set project-scoped dir first (getProjectTmpDir creates it if missing)
    PROJECT_TMP_DIR = getProjectTmpDir(ctx.cwd);
    // Export as env var so prompts/CLI commands can reference it
    process.env.PROJECT_TMP_DIR = PROJECT_TMP_DIR;

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
            const currentStartTime = parseProcStartTime(stat);
            if (!currentStartTime) continue; // parse failed — can't verify, skip conservatively
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
            taskId: marker.taskId || undefined,
            cwd: marker.cwd || undefined,
            projectCwd: marker.projectCwd || undefined,
            sessionId: marker.sessionId || undefined,
            model: status.model || marker.model || undefined,
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

  // /async-status — fullscreen overlay list → live output detail
  async function handleAsyncStatus(ctx: any): Promise<void> {
    if (!ctx.hasUI) return;
    await openAsyncStatusOverlay(ctx, {
      listJobs: () => Array.from(asyncState.jobs.values()),
      killJob: (id) => {
        killAsyncAgent(id);
      },
      formatDuration,
      readLiveStatus: (workerDir) => readAsyncStatus(workerDir),
    });
  }

  // /async-status command
  pi.registerCommand("async-status", {
    description: "Fullscreen overlay: list async agents, view live output, kill with x",
    handler: async (_args, ctx) => handleAsyncStatus(ctx),
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
      // Record killed reviewer as having 0 findings — prevents permanent commit block
      if (job.agent.startsWith("code-reviewer-")) {
        try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch { /* best-effort */ }
      }
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

  // /async-kill handler — extracted for readability (closure access preserved)
  async function handleAsyncKill(args: string, ctx: any): Promise<void> {
    // If arg provided, kill directly without interactive selection
    if (args) {
      const { killed, errors } = killAsyncAgent(args);
      if (killed.length > 0) {
        ctx.ui.notify(`Killed: ${killed.join(", ")}`, "info");
      }
      if (errors.length > 0) {
        ctx.ui.notify(errors.join("\n"), "warning");
      }
      return;
    }

    if (!ctx.hasUI) return;
    // Same overlay as /async-status, scoped to running/queued
    await openAsyncStatusOverlay(ctx, {
      title: "Kill async agents",
      emptyMessage: "No running async agents.",
      footerHints: "↑↓/jk select · Enter view · x kill · Esc close",
      listJobs: () =>
        Array.from(asyncState.jobs.values()).filter(
          (j) => j.status === "running" || j.status === "queued",
        ),
      killJob: (id) => {
        killAsyncAgent(id);
      },
      formatDuration,
      readLiveStatus: (workerDir) => readAsyncStatus(workerDir),
    });
  }

  // /async-kill command — accepts name/id/"all" or interactive overlay
  pi.registerCommand("async-kill", {
    description:
      "Kill async agent(s) — /async-kill <name|id|all> or overlay picker",
    handler: async (_args, ctx) => handleAsyncKill((_args || "").trim(), ctx),
  });

  // Handle async-kill from pidash browser UI
  pi.events.on("pidash:async-kill", (target: unknown) => {
    if (typeof target === "string") {
      killAsyncAgent(target);
    }
  });

  // ── pi-subagents RPC compatibility bridge ──────────────────────────────
  // Implements the subagents:rpc:* protocol so pi-tasks' TaskExecute
  // can spawn our agents. Protocol version 2 matches @tintinweb/pi-subagents.

  const RPC_PROTOCOL_VERSION = 2;

  /** Handle an RPC request: parse params, run fn, reply on scoped channel. */
  function handleRpc<P extends { requestId: string }>(
    channel: string,
    fn: (params: P) => unknown | Promise<unknown>,
  ): () => void {
    return pi.events.on(channel, async (raw: unknown) => {
      const params = raw as P;
      try {
        const data = await fn(params);
        const reply: { success: true; data?: unknown } = { success: true };
        if (data !== undefined) reply.data = data;
        pi.events.emit(`${channel}:reply:${params.requestId}`, reply);
      } catch (err: any) {
        pi.events.emit(`${channel}:reply:${params.requestId}`, {
          success: false, error: err?.message ?? String(err),
        });
      }
    });
  }

  // Ping — returns protocol version
  handleRpc("subagents:rpc:ping", () => {
    return { version: RPC_PROTOCOL_VERSION };
  });

  // Spawn — create an async agent from pi-tasks' TaskExecute
  handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    "subagents:rpc:spawn", ({ type, prompt, options }) => {
      const ctx = asyncState.lastCtx;
      if (!ctx) throw new Error("No active session");
      if (!type || typeof type !== "string") throw new Error("Missing or invalid 'type' parameter");
      if (!prompt || typeof prompt !== "string") throw new Error("Missing or invalid 'prompt' parameter");

      const cwd = options?.cwd || ctx.cwd;
      const discovery = discoverAgents(cwd, "both");
      const agents = discovery.agents;

      // Find agent by type (case-insensitive, fall back to "worker")
      const agentName = agents.find(a => a.name.toLowerCase() === type.toLowerCase())?.name
        || agents.find(a => a.name === "worker")?.name
        || type;

      const result = spawnAsyncAgent(agentName, prompt, cwd, agents, {
        name: options?.description || agentName,
        taskId: "-1",  // pi-tasks manages its own task linkage via agentTaskMap
        fireAndForget: false,
      });

      if (result.error) throw new Error(result.error);
      return { id: result.id };
    },
  );

  // Stop — kill a running async agent
  handleRpc<{ requestId: string; agentId: string }>(
    "subagents:rpc:stop", ({ agentId }) => {
      const { killed, errors } = killAsyncAgent(agentId);
      if (killed.length === 0) throw new Error(errors[0] || "Agent not found");
    },
  );

  // Emit subagents:ready so pi-tasks can discover us
  pi.on("session_start", () => {
    pi.events.emit("subagents:ready", {});
  });

  return {
    spawnAsyncAgent,
    killAsyncAgent,
    getAsyncJobs: () => Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued"),
  };
}
