/**
 * Async agent infrastructure — background agent spawning, polling, result watching.
 */

import { createLogger } from "../shared/logger.js";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryResult } from "./agents.js";
import { resolveAgentModelProvider } from "./resolve-agent-model.js";
import { getPiInvocation, getProjectTmpDir, parseProcStartTime, djb2Hash } from "./utils.js";
import { addReviewerPending, recordReviewerResult, countFindings, readReviewState, markTestsPassed, markTestsFailed } from "./pi-config-review-state.js";
import {
  getMainBranch,
} from "./git-helpers.js";
import { waitForResultFiles } from "./async-wait.js";
import { formatAsyncResultOutput, reviewerOutputArchivePath } from "./async-result-format.js";
import { cleanupReviewerOutputArchives } from "./reviewer-output-archive.js";
const log = createLogger("async_agents");

export { autoCompleteTask, autoMarkInProgress } from "./task-lifecycle.js";
import { autoCompleteTask, autoMarkInProgress } from "./task-lifecycle.js";
import { setSlot } from "./status-bar.js";
import { getSetting } from "./project-settings.js";
import { substituteSettingsPlaceholders } from "./rule-placeholders.js";

const SETTINGS_KEYS: Record<string, unknown> = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"),
    "utf-8",
  ),
);

// ── Constants ────────────────────────────────────────────────────────────



// Resolved per-call from settings

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
  sideEffectsApplied?: boolean;
  fireAndForget?: boolean;
  onComplete?: () => void;
  groupId?: string;
  taskId?: string;
  cwd?: string;
  projectCwd?: string;
  sessionId?: string;
  model?: string;
  restoredPid?: number;
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
  runtime: {
    spawnProcess?: typeof spawn;
    discoverAgents?: (cwd: string, scope: "both") => Pick<AgentDiscoveryResult, "agents">;
  } = {},
): {
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; onComplete?: () => void; persistSession?: boolean; explicit?: { model?: string; provider?: string } }) => { id: string; error?: string; model?: string };
  killAsyncAgent: (target: string) => { killed: string[]; errors: string[] };
  getAsyncJobs: () => Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }>;
} {
  let PROJECT_TMP_DIR = path.join(process.cwd(), ".pi", "tmp"); // Computed only; created on session_start
  let ASYNC_RESULTS_DIR = ""; // Set on session_start to project-scoped dir

  function resultOutputPath(job: Pick<AsyncJob, "agent" | "id" | "workerDir">): string {
    const workerOutputPath = path.join(job.workerDir, "output.log");
    const outputPath = job.agent.startsWith("code-reviewer-")
      ? reviewerOutputArchivePath(PROJECT_TMP_DIR, job.id)
      : workerOutputPath;
    log.debug("async_result_output_path", { agent: job.agent, archived: outputPath !== workerOutputPath });
    return outputPath;
  }

  function preserveReviewerOutput(job: Pick<AsyncJob, "agent" | "id">, output: string): void {
    if (!job.agent.startsWith("code-reviewer-")) return;
    const outputPath = reviewerOutputArchivePath(PROJECT_TMP_DIR, job.id);
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(outputPath, output, { mode: 0o600 });
      fs.chmodSync(outputPath, 0o600);
      cleanupReviewerOutputArchives(path.dirname(outputPath));
      log.info("preserved_reviewer_output", { agent: job.agent, bytes: Buffer.byteLength(output, "utf8") });
    } catch (e: any) {
      log.error(`preserve reviewer output failed for ${job.id}: ${e?.message}`);
    }
  }

  const asyncState: AsyncState = {
    jobs: new Map(),
    poller: null,
    watcher: null,
    lastCtx: null,
  };

  // Track job IDs that have already been delivered in this session (including previous lifecycles).
  // Populated from status.json delivered flags on session_start to prevent re-delivery after reload.
  const deliveredResultIds = new Set<string>();

  /** Check if a job result was already delivered in a previous session lifecycle. */
  function wasAlreadyDelivered(jobId: string): boolean {
    return deliveredResultIds.has(jobId);
  }

  /** Record a job result as delivered so it won't be re-sent after reload. */
  function recordDelivered(jobId: string): void {
    deliveredResultIds.add(jobId);
  }

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
        log.debug("poller_check", job.id, "workerDir exists", fs.existsSync(job.workerDir), "pid", status?.pid);
        if (!status) {
          // No status file — process never started or died before writing status.
          // Check if workerDir still exists; if not, the job is definitely dead.
          if (!fs.existsSync(job.workerDir)) {
            // Worker dir missing (e.g. cleaned across a reload). Do NOT declare
            // death if the worker process is still alive — trust the live PID.
            const restoredPid = job.restoredPid;
            const stillAlive = restoredPid
              ? (() => { try { process.kill(restoredPid, 0); return true; } catch { return false; } })()
              : false;
            if (stillAlive) {
              const elapsed = Date.now() - job.startedAt;
              if (elapsed <= getSetting(jobCwd(job), "async_phantom_timeout_ms")) {
                log.debug(`restored job dir missing but pid ${restoredPid} alive — waiting`, job.id);
                continue;
              }
              // else fall through to failure below (grace window exceeded)
            }
            job.status = "failed";
            job.output = "Agent process died without writing status";
            job.durationMs = Date.now() - job.startedAt;
            job.updatedAt = Date.now();
            job.sideEffectsApplied = true;
            log.debug(`phantom: ${job.id} — no status file, worker dir missing`);
            if (job.agent.startsWith("code-reviewer-")) {
              try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch {}
            }
            if (job.groupId) {
              const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
              const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
              if (pending.length === 0) deliverGroupResults(groupJobs);
            }
          } else {
            // Worker dir exists but no status file — check timeout
            const elapsed = Date.now() - job.startedAt;
            if (elapsed > getSetting(jobCwd(job), "async_phantom_timeout_ms")) {
              job.status = "failed";
              job.output = `Agent process timed out — no status file after ${Math.round(elapsed / 1000)}s`;
              job.durationMs = elapsed;
              job.updatedAt = Date.now();
              job.sideEffectsApplied = true;
              log.debug(`phantom-timeout: ${job.id} — no status file after ${Math.round(elapsed / 1000)}s`);
              if (job.agent.startsWith("code-reviewer-")) {
                try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch {}
              }
              if (job.groupId) {
                const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
                const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
                if (pending.length === 0) deliverGroupResults(groupJobs);
              }
              updateAsyncWidget();
            }
          }
          continue;
        }
        {
          job.status = status.state;
          job.updatedAt = status.lastUpdate ?? Date.now();
          if (status.exitCode !== undefined) job.exitCode = status.exitCode;

          // Check if process is actually alive — clean up zombies
          if (job.status === "running" && !status.pid) {
            // Status file exists but no PID — process died before recording PID
            job.status = "failed";
            job.output = "Agent process died before recording PID";
            job.durationMs = Date.now() - job.startedAt;
            job.updatedAt = Date.now();
            job.sideEffectsApplied = true;
            log.debug(`phantom: ${job.id} — status file exists but no PID`);
            if (job.agent.startsWith("code-reviewer-")) {
              try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch {}
            }
            if (job.groupId) {
              const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
              const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
              if (pending.length === 0) deliverGroupResults(groupJobs);
            }
          } else if (job.status === "running" && status.pid) {
            try { process.kill(status.pid, 0); } catch {
              // Process exited — check if it wrote a result file first
              log.debug("poller_zombie", job.id, "pid", status.pid, "checking result file");
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
                  log.debug("poller_zombie_ingest", job.id, "status", job.status, "output_len", job.output?.length);
                  let zombieSideEffectsOk = true;
                  if (job.agent.startsWith("code-reviewer-")) {
                    const findings = countFindings(typeof data.output === "string" ? data.output : "");
                    try { recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings); } catch (e: any) { zombieSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
                  }
                  if (job.agent === "test-automator" || job.agent === "test-runner") {
                    try { job.status === "complete" ? markTestsPassed(jobCwd(job)) : markTestsFailed(jobCwd(job)); } catch (e: any) { zombieSideEffectsOk = false; log.error(`markTests failed for ${job.agent}: ${e?.message}`); }
                  }
                  if (zombieSideEffectsOk) job.sideEffectsApplied = true;
                  try { fs.unlinkSync(resultFilePath); } catch {}
                } catch {
                  job.status = "failed";
                  job.output = "Process exited before result could be read";
                  job.durationMs = Date.now() - job.startedAt;
                  job.updatedAt = Date.now();
                  let catchSideEffectsOk = true;
                  if (job.agent.startsWith("code-reviewer-")) {
                    try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch (e: any) { catchSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
                  }
                  if (catchSideEffectsOk) job.sideEffectsApplied = true;
                }
              } else {
                job.status = "failed";
                job.output = "Process exited without producing results";
                job.durationMs = Date.now() - job.startedAt;
                job.updatedAt = Date.now();
                log.debug("poller_zombie_no_result", job.id, "agent", job.agent, "pid", status?.pid, "elapsed_ms", Date.now() - job.startedAt);
                // Record killed reviewer as having 0 findings — prevents permanent commit block
                let noFileSideEffectsOk = true;
                if (job.agent.startsWith("code-reviewer-")) {
                  try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch (e: any) { noFileSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
                }
                if (noFileSideEffectsOk) job.sideEffectsApplied = true;
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
      if (fs.existsSync(ASYNC_RESULTS_DIR)) {
        try {
          const files = fs.readdirSync(ASYNC_RESULTS_DIR).filter(f => f.endsWith(".json"));
          for (const file of files) {
            try {
              processResultFile(path.join(ASYNC_RESULTS_DIR, file));
            } catch (e: any) { log.error(`processResultFile error for ${file}: ${e?.message}`); }
          }
        } catch (e: any) {
          // ENOENT = directory removed between existsSync and readdirSync — expected race
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            log.error(`result file scan error: ${e?.message}`);
          }
        }
      }

      // Reconciliation pass — retry side-effects + delivery for done-but-undelivered jobs
      for (const [id, job] of asyncState.jobs.entries()) {
        if ((job.status === "complete" || job.status === "failed") && !job.delivered) {
          // Side-effects: ensure they fired (only mark applied when ALL succeed)
          if (!job.sideEffectsApplied) {
            let sideEffectsOk = true;
            if (job.agent.startsWith("code-reviewer-")) {
              const findings = countFindings(typeof job.output === "string" ? job.output : "");
              try { recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings); } catch (e: any) { sideEffectsOk = false; log.error(`reconcile: recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
            }
            if (job.agent === "test-automator" || job.agent === "test-runner") {
              try { job.status === "complete" ? markTestsPassed(jobCwd(job)) : markTestsFailed(jobCwd(job)); } catch (e: any) { sideEffectsOk = false; log.error(`reconcile: markTests failed for ${job.agent}: ${e?.message}`); }
            }
            if (sideEffectsOk) job.sideEffectsApplied = true;
          }
          // Delivery: retry for groups where all members are done
          if (job.groupId) {
            const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
            const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
            if (pending.length === 0) {
              deliverGroupResults(groupJobs);
            }
          // Delivery: retry for non-grouped jobs (zombie-ingest path may skip delivery)
          } else if (asyncState.lastCtx && !job.fireAndForget) {
            const displayName = job.name || job.agent;
            const resultStatus = job.status === "complete" ? "✅ completed" : "❌ failed";
            const duration = job.durationMs || (job.updatedAt ? job.updatedAt - job.startedAt : 0);
            // Auto-complete linked task (with logging, matching processResultFile behavior)
            let autoCompleteError = "";
            if (job.taskId && job.taskId !== "-1" && job.status === "complete" && job.cwd) {
              try {
                autoCompleteTask(job.taskId, job.projectCwd || job.cwd, job.sessionId)
                  .then((completed) => log.info(`reconcile: auto-completed task #${job.taskId}: ${completed}`))
                  .catch((e: any) => log.error(`reconcile: auto-complete failed for task #${job.taskId}: ${e?.message}`));
              } catch (e: any) {
                const safeTaskId = /^-?\d+$/.test(job.taskId!) ? job.taskId : "(invalid)";
                autoCompleteError = `\n\n⚠️ Failed to auto-complete task #${safeTaskId}: ${e?.message}. Run TaskUpdate(taskId="${safeTaskId}", status="completed") manually.`;
                log.error(`reconcile: auto-complete failed for task #${safeTaskId}: ${e?.message}`);
              }
            }
            // Enforce same output-length budget as processResultFile.
            const maxOutput = Math.max(3000 - autoCompleteError.length, 500);
            const output = formatAsyncResultOutput(
              job.agent,
              job.output || "",
              resultOutputPath(job),
              maxOutput,
            );
            // Emit lifecycle events
            if (job.status === "complete") {
              pi.events.emit("subagents:completed", { id: job.id, result: job.output || "" });
            } else {
              pi.events.emit("subagents:failed", { id: job.id, error: job.output || "Agent failed", result: job.output || "", status: "failed" });
            }
            const msgContent = `## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${job.task}\nDuration: ${formatDuration(duration)}\n\n${output}${autoCompleteError}`;
            if (wasAlreadyDelivered(job.id)) {
              job.delivered = true;
              log.debug(`reconcile: skipping already-delivered result for ${job.id}`);
            } else {
              log.debug("reconcile_deliver", job.id, "hasCtx", !!asyncState.lastCtx);
              try {
                pi.sendMessage({
                  customType: "async-agent-result",
                  content: msgContent,
                  display: true,
                }, { triggerTurn: true, deliverAs: "followUp" });
                if (job.onComplete) {
                  try { job.onComplete(); } catch (e: any) { log.error(`onComplete callback failed for ${job.id}: ${e?.message}`); }
                }
                job.delivered = true;
                recordDelivered(job.id);
                log.debug("reconcile_deliver_ok", job.id);
              } catch (e: any) {
                log.error(`reconcile: sendMessage failed for ${job.id}: ${e?.message}`);
                // delivered stays false — will retry on next poll
              }
            }
            // Persist delivered state so restore skips this job
            if (job.delivered) {
              try {
                const sp = path.join(job.workerDir, "status.json");
                const ex = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : {};
                ex.delivered = true;
                fs.writeFileSync(sp, JSON.stringify(ex), { mode: 0o600 });
              } catch {}
            }
          } else if (job.fireAndForget) {
            if (job.onComplete) {
              try { job.onComplete(); } catch (e: any) { log.error(`onComplete callback failed for ${job.id}: ${e?.message}`); }
            }
            job.delivered = true;
          }
        }
      }

      // Remove completed/failed jobs older than 30s — require delivered before cleanup
      for (const [id, job] of asyncState.jobs.entries()) {
        if ((job.status === "complete" || job.status === "failed")
            && Date.now() - job.updatedAt > 30000
            && job.delivered) {
          asyncState.jobs.delete(id);
        }
      }
      updateAsyncWidget();
    }, getSetting(process.cwd(), "async_poll_interval_ms"));
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
        preserveReviewerOutput(j, typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? ""));
        j.exitCode = data.exitCode;
        j.durationMs = data.durationMs;
        if (data.success !== undefined) j.status = data.success ? "complete" : "failed";
        log.debug(`deliverGroupResults: late-ingested result for ${j.id}`);
      } catch (e: any) { log.error(`deliverGroupResults: late-ingest failed for ${j.id}: ${e?.message}`); }
    }

    // Track reviewer completions for ALL code-reviewer jobs in the group.
    // processResultFile may have already called recordReviewerResult for some,
    // but recordReviewerResult is idempotent (skips if reviewer already reported).
    for (const j of groupJobs) {
      if (!j.agent.startsWith("code-reviewer-")) continue;
      try {
        const output = typeof j.output === "string" ? j.output : "";
        const findings = countFindings(output);
        // -1 means invalid JSON output — treat conservatively as having findings
        recordReviewerResult(jobCwd(j), j.agent, findings < 0 ? 1 : findings);
      } catch (e: any) { j.sideEffectsApplied = false; log.error(`recordReviewerResult failed for ${j.agent}: ${e?.message}`); continue; }
    }

    // Track test agent completions for grouped test-automator/test-runner
    for (const j of groupJobs) {
      if (j.agent !== "test-automator" && j.agent !== "test-runner") continue;
      try {
        if (j.status === "complete") {
          markTestsPassed(jobCwd(j));
        } else if (j.status === "failed") {
          markTestsFailed(jobCwd(j));
        }
      } catch (e: any) { j.sideEffectsApplied = false; log.error(`markTests failed for ${j.agent}: ${e?.message}`); continue; }
    }

    // Mark side-effects applied per-job (only if not already marked false by a failed side-effect above)
    for (const j of groupJobs) {
      if (j.sideEffectsApplied !== false) j.sideEffectsApplied = true;
    }

    // Skip delivery if ALL jobs in group are fire-and-forget
    if (groupJobs.every(j => j.fireAndForget)) {
      for (const j of groupJobs) {
        if (j.onComplete) {
          try { j.onComplete(); } catch (e: any) { log.error(`onComplete callback failed for ${j.id}: ${e?.message}`); }
        }
        j.delivered = true;
      }
      // Clean up result files for fire-and-forget groups
      for (const j of groupJobs) {
        const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
        try { fs.unlinkSync(rp); } catch (e: any) { log.debug(`unlink failed ${rp}: ${e?.message}`); }
      }
      return;
    }

    // Emit lifecycle events for pitasks RPC bridge (one per job)
    for (const j of groupJobs) {
      if (j.status === "complete") {
        pi.events.emit("subagents:completed", { id: j.id, result: j.output || "" });
      } else if (j.status === "failed") {
        pi.events.emit("subagents:failed", { id: j.id, error: j.output || "Agent failed", result: j.output || "", status: "failed" });
      }
    }

    const sections: string[] = [];
    const deliverableJobs: AsyncJob[] = [];
    for (const j of groupJobs) {
      if (j.fireAndForget) { j.delivered = true; continue; }
      const resultStatus = j.status === "complete" ? "✅ completed" : "❌ failed";
      const displayName = j.name || j.agent;
      const output = formatAsyncResultOutput(
        j.agent,
        j.output || "",
        resultOutputPath(j),
      );
      let autoCompleteError = "";
      // Auto-complete linked task directly in the store file (no AI involvement)
      if (j.taskId && j.taskId !== "-1" && j.status === "complete" && j.cwd) {
        try {
          const completed = await autoCompleteTask(j.taskId, j.projectCwd || j.cwd, j.sessionId);
          log.info(`auto-completed task #${j.taskId}: ${completed}`);
        } catch (e: any) {
          autoCompleteError = `\n\n⚠️ Failed to auto-complete task #${j.taskId}: ${e?.message}. Run TaskUpdate(taskId="${j.taskId}", status="completed") manually.`;
          log.error(`auto-complete failed for task #${j.taskId}: ${e?.message}`);
        }
      }
      const duration = j.durationMs || (j.updatedAt ? j.updatedAt - j.startedAt : 0);
      sections.push(`## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${j.task}\nDuration: ${formatDuration(duration)}\n\n${output}${autoCompleteError}`);
      deliverableJobs.push(j);
    }

    if (sections.length > 0) {
      try {
        pi.sendMessage({
          customType: "async-agent-result",
          content: sections.join("\n\n---\n\n"),
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
        // Only mark delivered AFTER sendMessage succeeds
        for (const j of deliverableJobs) {
          j.delivered = true;
          // Persist delivered state so restore skips this job
          try {
            const sp = path.join(j.workerDir, "status.json");
            const ex = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : {};
            ex.delivered = true;
            fs.writeFileSync(sp, JSON.stringify(ex), { mode: 0o600 });
          } catch {}
        }
      } catch (e: any) {
        log.error(`deliverGroupResults: sendMessage failed: ${e?.message}`);
        // delivered stays false — reconciliation will retry on next poll
      }
    } else {
      // No sections to deliver (all fire-and-forget) — already marked above
    }

    // Clean up any remaining result files (most already deleted by processResultFile)
    for (const j of groupJobs) {
      const rp = path.join(ASYNC_RESULTS_DIR, `${j.id}.json`);
      try { fs.unlinkSync(rp); } catch (e: any) {
        // ENOENT = already deleted by processResultFile — expected
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.debug(`unlink failed ${rp}: ${e?.message}`);
      }
    }
    } finally {
      if (gid) groupDeliveryInProgress.delete(gid);
    }
  }

  async function processResultFile(resultPath: string) {
    if (!fs.existsSync(resultPath)) {
      log.debug(`processResultFile: file already deleted: ${path.basename(resultPath)}`);
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
      const job = asyncState.jobs.get(data.id);
      log.debug(`processResultFile: ${path.basename(resultPath)} job=${!!job} delivered=${job?.delivered} hasCtx=${!!asyncState.lastCtx} fireAndForget=${job?.fireAndForget} groupId=${job?.groupId}`);
      if (!job) {
        // Orphan result file — job not in current session. Clean up to prevent re-delivery on reload.
        try { fs.unlinkSync(resultPath); } catch (e: any) { log.debug(`orphan cleanup failed: ${resultPath}: ${e?.message}`); }
        return;
      }
      if (job.delivered) {
        // Already delivered — clean up stale file
        log.debug("processResultFile_skip_delivered", job.id);
        try { fs.unlinkSync(resultPath); } catch (e: any) { log.debug(`stale cleanup failed: ${resultPath}: ${e?.message}`); }
        return;
      }
      // Skip if already ingested — delete file to prevent re-scan every 3s
      if (job.output !== undefined) {
        try { fs.unlinkSync(resultPath); } catch (e: any) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.debug(`re-ingest unlink failed ${resultPath}: ${e?.message}`);
        }
        return;
      }

      // Update job state immediately (before group check)
      job.status = data.success ? "complete" : "failed";
      job.output = data.output;
      job.exitCode = data.exitCode;
      job.durationMs = data.durationMs;
      job.updatedAt = Date.now();
      preserveReviewerOutput(job, typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? ""));

      // Notify terminal per-agent (lightweight, non-conversational)
      const displayName = job.name || data.agent;
      terminalNotify("pi", `Async agent ${displayName} ${data.success ? "completed" : "failed"} (${formatDuration(data.durationMs)})`);

      // Track reviewer completion for review loop enforcement
      let processResultSideEffectsOk = true;
      if (job.agent.startsWith("code-reviewer-")) {
        try {
          const output = typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? "");
          const findings = countFindings(output);
          // -1 means invalid JSON output — treat conservatively as having findings
          recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings);
        } catch (e: any) { processResultSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
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
                  log.info(`Cleared session for ${job.agent} (context ${Math.round(pct)}%)`);
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
        } catch (e: any) { processResultSideEffectsOk = false; log.error(`markTests(Passed|Failed) failed for ${job.agent}: ${e?.message}`); }
      }

      if (processResultSideEffectsOk) job.sideEffectsApplied = true;

      // Always delete result file after ingestion — data is in memory (job.output).
      // Reconciliation uses in-memory data, not the file. Leaving files on disk
      // causes the poller's readdirSync to re-ingest them every 3s.
      try { fs.unlinkSync(resultPath); } catch (e: any) { log.debug(`unlink failed ${resultPath}: ${e?.message}`); }

      // Persist output summary to status.json so session restore can recover it
      // (result file is now deleted, but output must survive restart)
      try {
        const statusPath = path.join(job.workerDir, "status.json");
        const existing = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        existing.output = formatAsyncResultOutput(
          job.agent,
          data.output || "",
          resultOutputPath(job),
        );
        existing.state = job.status;
        existing.exitCode = job.exitCode;
        existing.durationMs = job.durationMs;
        fs.writeFileSync(statusPath, JSON.stringify(existing), { mode: 0o600 });
      } catch (e: any) { log.error(`status.json output persist failed for ${job.id}: ${e?.message}`); }

      // Group-aware delivery: hold results until ALL jobs in the group are done
      if (job.groupId) {
        const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
        const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
        log.info(`group ${job.groupId}: ${groupJobs.length} total, ${pending.length} pending`);
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

      // Emit lifecycle events for pitasks RPC bridge
      if (data.success) {
        pi.events.emit("subagents:completed", { id: job.id, result: data.output || "" });
      } else {
        pi.events.emit("subagents:failed", { id: job.id, error: data.output || "Agent failed", result: data.output || "", status: "failed" });
      }

      // Non-grouped job: deliver immediately (existing behavior)
      let sendSucceeded = false;
      if (asyncState.lastCtx && !job.fireAndForget) {
        const resultStatus = data.success ? "✅ completed" : "❌ failed";
        let autoCompleteError = "";
        // Auto-complete linked task directly in the store file (no AI involvement)
        if (job.taskId && job.taskId !== "-1" && data.success && job.cwd) {
          try {
            const completed = await autoCompleteTask(job.taskId, job.projectCwd || job.cwd, job.sessionId);
            log.info(`auto-completed task #${job.taskId}: ${completed}`);
          } catch (e: any) {
            autoCompleteError = `\n\n⚠️ Failed to auto-complete task #${job.taskId}: ${e?.message}. Run TaskUpdate(taskId="${job.taskId}", status="completed") manually.`;
            log.error(`auto-complete failed for task #${job.taskId}: ${e?.message}`);
          }
        }
        const maxOutput = Math.max(3000 - autoCompleteError.length, 500);
        const output = formatAsyncResultOutput(
          job.agent,
          data.output || "",
          resultOutputPath(job),
          maxOutput,
        );
        const pContent = `## Async Agent Result: ${displayName} ${resultStatus}\n\nTask: ${data.task}\nDuration: ${formatDuration(data.durationMs)}\n\n${output}${autoCompleteError}`;
        if (wasAlreadyDelivered(job.id)) {
          // Already delivered in previous lifecycle — skip send AND onComplete
          job.delivered = true;
          log.debug(`processResultFile: skipping already-delivered result for ${job.id}`);
          updateAsyncWidget();
          return;
        } else {
          try {
            pi.sendMessage({
              customType: "async-agent-result",
              content: pContent,
              display: true,
            }, { triggerTurn: true, deliverAs: "followUp" });
            sendSucceeded = true;
            recordDelivered(job.id);
          } catch (e: any) {
            log.error(`processResultFile: sendMessage failed for ${job.id}: ${e?.message}`);
            // sendSucceeded stays false — delivered won't be set, reconciliation retries
          }
        }
      } else if (job.fireAndForget) {
        sendSucceeded = true; // fire-and-forget doesn't need sendMessage
      }

      // Invoke onComplete callback if registered (e.g., dreaming → rebuildAndOrganize)
      if (job.onComplete) {
        try { job.onComplete(); } catch (e: any) { log.error(`onComplete callback failed for ${job.id}: ${e?.message}`); }
      }
      if (sendSucceeded) {
        job.delivered = true;
        // Persist delivered state so restore skips this job
        if (job.delivered) {
          try {
            const sp = path.join(job.workerDir, "status.json");
            const ex = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : {};
            ex.delivered = true;
            fs.writeFileSync(sp, JSON.stringify(ex), { mode: 0o600 });
          } catch {}
        }
      }
      // Result file already deleted above (non-grouped path)
      updateAsyncWidget();
    } catch (e: any) {
      log.error(`processResultFile ERROR: ${e.message}`);
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
        log.debug("watcher_event", ev, fileName);
        if (!fileName.endsWith(".json")) return;
        const resultPath = path.join(ASYNC_RESULTS_DIR, fileName);
        setTimeout(() => processResultFile(resultPath), 100);
      });
      if (asyncState.watcher.unref) asyncState.watcher.unref();
    } catch (e: any) { log.error(`watcher setup failed: ${e?.message || e}`); }
  }

  function spawnAsyncAgent(
    agentName: string,
    task: string,
    cwd: string,
    agents: AgentConfig[],
    options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; onComplete?: () => void; persistSession?: boolean; explicit?: { model?: string; provider?: string } },
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
      log.warn("async-spawn: could not read /proc/self/stat starttime after 3 attempts");
    }
    const { model: effectiveModel, provider: effectiveProvider } = resolveAgentModelProvider(agentName, agent, options?.parentModelId, options?.parentProvider, cwd, options?.explicit);
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
    if (effectiveModel) piArgs.push("--model", effectiveModel);
    if (effectiveProvider) piArgs.push("--provider", effectiveProvider);
    if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));

    if (agent.systemPrompt?.trim()) {
      const promptPath = path.join(workerDir, "system-prompt.md");
      const resolvedPrompt = substituteSettingsPlaceholders(
        agent.systemPrompt,
        (key) => getSetting(cwd, key as any),
        Object.keys(SETTINGS_KEYS),
      );
      fs.writeFileSync(promptPath, resolvedPrompt, { mode: 0o600 });
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
      reviewerOutputPath: agentName.startsWith("code-reviewer-")
        ? reviewerOutputArchivePath(PROJECT_TMP_DIR, id)
        : undefined,
      workerDir,
      sessionId: `${process.pid}:${process.cwd()}`,
      piCommand: inv.command,
      piArgs: inv.args,
    }), { mode: 0o600 });

    // Find the runner script
    const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "async-runner.ts");

    // Find jiti for TypeScript execution — walk UP from known roots until
    // found; never assume a fixed depth (install layouts vary: dist/,
    // dist/bundle/, workspace hoisting, nested node_modules).
    let jitiCliPath: string | undefined;
    const jitiProbes: string[] = [];
    const findJitiUnder = (label: string, startDir: string): string | undefined => {
      let dir = startDir;
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "node_modules/jiti/lib/jiti-cli.mjs");
        jitiProbes.push(`${fs.existsSync(candidate) ? "HIT" : "--"} ${candidate}`);
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
      }
      jitiProbes.push(`(exhausted from ${label}: ${startDir})`);
      return undefined;
    };

    // Strategy 1: resolve from pi's own install location (the running binary).
    try {
      if (process.argv[1]) {
        const piRoot = path.dirname(fs.realpathSync(process.argv[1]));
        jitiCliPath = findJitiUnder("argv-binary", piRoot);
      }
    } catch (e: any) {
      log.debug(`jiti strategy 1 (running binary) failed: ${e?.message || e}`);
    }

    // Strategy 2: resolve the pi SDK package from this module's require context.
    if (!jitiCliPath) {
      try {
        const req = createRequire(fileURLToPath(import.meta.url));
        let sdkPkgJson: string | undefined;
        try {
          sdkPkgJson = req.resolve("@earendil-works/pi-coding-agent/package.json");
        } catch {
          // Newer SDK "exports" maps hide ./package.json — resolve the entry
          // and walk up to the owning package.json instead.
          let dir = path.dirname(req.resolve("@earendil-works/pi-coding-agent"));
          while (dir !== path.dirname(dir)) {
            const pj = path.join(dir, "package.json");
            if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8"))?.name === "@earendil-works/pi-coding-agent") { sdkPkgJson = pj; break; }
            dir = path.dirname(dir);
          }
        }
        if (sdkPkgJson) jitiCliPath ??= findJitiUnder("sdk-pkg", path.dirname(sdkPkgJson));
      } catch (e: any) {
        log.debug(`jiti strategy 2 (SDK package) failed: ${e?.message || e}`);
      }
    }

    // Strategy 3: this package's own node_modules (git/stow clones ship jiti).
    if (!jitiCliPath) {
      try {
        jitiCliPath = findJitiUnder("extension-dir", path.dirname(fileURLToPath(import.meta.url)));
      } catch (e: any) {
        log.debug(`jiti strategy 3 (package root) failed: ${e?.message || e}`);
      }
    }

    // Fail fast with a self-explanatory error instead of spawning a child that
    // cannot load TypeScript (bare node dies on ".js"→".ts" specifiers).
    if (!jitiCliPath && !runtime.spawnProcess) {
      log.error(`async-spawn: ${id} — no jiti-cli.mjs found. Probes:\n  ${(jitiProbes.slice(-14)).join("\n  ")}`);
      // Clean up the artifacts we already created — nothing will consume them.
      try { fs.rmSync(configPath, { force: true }); } catch {}
      try { fs.rmSync(workerDir, { recursive: true, force: true }); } catch {}
      return { id, error: "jiti-cli.mjs not found — cannot execute async agent (see orchestrator logs)" };
    }

    const spawnArgs = jitiCliPath
      ? [jitiCliPath, runnerPath, configPath]
      : [runnerPath, configPath];

    // Resolve base branch for reviewers so they diff against the correct target
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      PI_SUBAGENT_CHILD: "1",
      PI_AGENT_NAME: agentName,
      PI_PRIMARY_MODEL: process.env.PI_PRIMARY_MODEL || process.env.PI_MODEL || "",
      // Isolate children from the shared jiti FS cache — other sessions running
      // different node/jiti versions can poison it and kill children at boot.
      JITI_CACHE: "false",
      JITI_FS_CACHE: "false",
      __PI_CONFIG_SESSION_ID: (globalThis as any).__piConfigSessionId || "",
      __PI_PARENT_SESSION_ID: (globalThis as any).__piConfigSessionId || "",
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

    // Register job BEFORE spawn — child can finish and write result file before
    // jobs.set runs; watcher/poller would then treat it as orphan and delete it.
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

    const stderrLogPath = path.join(workerDir, "child-stderr.log");
    const stderrLog = fs.createWriteStream(stderrLogPath, { flags: "w" });
    stderrLog.on("error", () => {}); // never let a log write failure crash the session
    log.debug(`async-spawn: ${job.id} stderr → ${stderrLogPath}`);

    const proc = (runtime.spawnProcess ?? spawn)(process.execPath, spawnArgs, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: spawnEnv,
    });
    proc.stderr?.pipe(stderrLog);

    proc.once("error", (err) => {
      try { stderrLog.destroy(); } catch {}
      log.info(`spawn-error: ${job.id} — ${err.message}`);
      if (job.status === "complete" || job.status === "failed") return;
      job.status = "failed";
      job.output = `Spawn error: ${err.message}`;
      job.durationMs = Date.now() - job.startedAt;
      job.updatedAt = Date.now();
      job.sideEffectsApplied = true;
      if (job.agent.startsWith("code-reviewer-")) {
        try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch {}
      }
      if (job.groupId) {
        const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
        const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
        if (pending.length === 0) deliverGroupResults(groupJobs);
      }
      updateAsyncWidget();
    });

    proc.once("exit", (code, signal) => {
      if (job.status === "complete" || job.status === "failed") return;
      if (code !== 0) {
        // Give 2s for result file to be written by async-runner
        setTimeout(() => {
          if (job.status === "complete" || job.status === "failed") return;
          log.info(`spawn-exit: ${job.id} — code=${code} signal=${signal}`);
          let stderrTail = "";
          try {
            if (fs.existsSync(stderrLogPath)) {
              // Tail-read only — the log can be arbitrarily large on noisy failures.
              const size = fs.statSync(stderrLogPath).size;
              const start = Math.max(0, size - 4096);
              let raw = "";
              if (size > 0) {
                const fd = fs.openSync(stderrLogPath, "r");
                try {
                  const buf = Buffer.alloc(Math.min(size - start, 4096));
                  fs.readSync(fd, buf, 0, buf.length, start);
                  raw = buf.toString("utf8");
                } finally { fs.closeSync(fd); }
              }
              stderrTail = raw.trim().slice(-1200);
            }
          } catch {}
          log.warn(`async-child failed: ${job.id} code=${code}${stderrTail ? " (see child-stderr.log)" : " (no stderr captured)"}`);
          job.status = "failed";
          job.output = `Process exited with code ${code} signal ${signal}${stderrTail ? `\n--- child stderr (tail) ---\n${stderrTail}` : ""}`;
          job.durationMs = Date.now() - job.startedAt;
          job.updatedAt = Date.now();
          job.sideEffectsApplied = true;
          if (job.agent.startsWith("code-reviewer-")) {
            try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch {}
          }
          if (job.groupId) {
            const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
            const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
            if (pending.length === 0) deliverGroupResults(groupJobs);
          }
          updateAsyncWidget();
        }, 2000).unref();
      }
    });

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
    deliveredResultIds.clear();

    // Set project-scoped dir first (getProjectTmpDir creates it if missing)
    PROJECT_TMP_DIR = getProjectTmpDir(ctx.cwd);
    // Export as env var so prompts/CLI commands can reference it
    process.env.PROJECT_TMP_DIR = PROJECT_TMP_DIR;

    cleanupReviewerOutputArchives(path.join(PROJECT_TMP_DIR, "reviewer-results"));

    // Scan worker directories for jobs with delivered=true in status.json
    // This is more reliable than content hashing — uses job IDs directly
    try {
      for (const entry of fs.readdirSync(PROJECT_TMP_DIR)) {
        const jobDir = path.join(PROJECT_TMP_DIR, entry);
        try {
          if (!fs.statSync(jobDir).isDirectory()) continue;
          const statusPath = path.join(jobDir, "status.json");
          if (!fs.existsSync(statusPath)) continue;
          const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
          if (status.delivered && status.runId) {
            deliveredResultIds.add(status.runId);
          }
        } catch {}
      }
      if (deliveredResultIds.size > 0) {
        log.info(`session_start: found ${deliveredResultIds.size} previously delivered job IDs`);
      }
    } catch (e: any) { log.error(`delivered job scan failed: ${e?.message}`); }

    // Set results dir — PID-scoped under project dir
    ASYNC_RESULTS_DIR = path.join(PROJECT_TMP_DIR, sessionResultsDirName());

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
    } catch (e: any) { log.error(`zombie cleanup failed: ${e?.message?.slice(0, 100)}`); }

    // Clean up stale result directories from dead sessions
    try {
      for (const entry of fs.readdirSync(PROJECT_TMP_DIR)) {
        if (!entry.startsWith("async-results-pid-")) continue;
        const resultDir = path.join(PROJECT_TMP_DIR, entry);
        if (resultDir === ASYNC_RESULTS_DIR) continue; // skip our own
        try {
          if (!fs.statSync(resultDir).isDirectory()) continue;
          // Extract PID and starttime from directory name
          // Format: async-results-pid-{pid}-{starttime} (current) or async-results-pid-{pid} (legacy)
          const match = entry.match(/^async-results-pid-(\d+)(?:-(\d+))?$/);
          if (!match) continue;
          const dirPid = parseInt(match[1], 10);
          const dirStartTime = match[2]; // undefined for legacy PID-only format
          let parentAlive = false;
          try {
            const stat = fs.readFileSync(`/proc/${dirPid}/stat`, "utf-8");
            const currentStartTime = parseProcStartTime(stat);
            if (currentStartTime) {
              // With starttime: must match exactly. Without: PID alive = keep (conservative)
              parentAlive = dirStartTime ? currentStartTime === dirStartTime : true;
            }
          } catch {} // /proc not found = dead
          if (!parentAlive) {
            // Parent dead — clean up entire result directory
            try { fs.rmSync(resultDir, { recursive: true, force: true }); } catch {}
            log.info(`cleaned stale result dir: ${entry}`);
          }
        } catch {} // skip unreadable dirs
      }
    } catch (e: any) { log.error(`stale result dir cleanup failed: ${e?.message?.slice(0, 100)}`); }

    log.info(`session_start: resultsDir=${path.basename(ASYNC_RESULTS_DIR)}`);

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
        // Skip completed/failed jobs — they were already delivered. Clean up worker dir.
        if (isComplete) {
          try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
          log.debug(`cleaned completed worker dir on restore: ${entry} (state=${status.state})`);
          continue;
        }
        // Only restore running/queued jobs with alive processes
        log.debug("restore_check", id, "isAlive", isAlive, "state", status.state);
        if (isAlive || status.state === "running") {
          // No result file = already processed and delivered — mark as delivered
          const hasResultFile = fs.existsSync(path.join(ASYNC_RESULTS_DIR, `${id}.json`));
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
            output: status.output || undefined,
            delivered: isComplete,
            sideEffectsApplied: isComplete,
            fireAndForget: marker.fireAndForget || false,
            taskId: marker.taskId || undefined,
            cwd: marker.cwd || undefined,
            projectCwd: marker.projectCwd || undefined,
            sessionId: marker.sessionId || undefined,
            model: status.model || marker.model || undefined,
            restoredPid: typeof status.pid === "number" ? status.pid : undefined,
          };
          asyncState.jobs.set(id, job);
          log.info(`restored job: ${id} state=${job.status}`);
        }
      }
    } catch (e: any) { log.error(`job restore failed: ${e?.message || e}`); }

    // Start poller if we have jobs or unprocessed result files
    let hasResultFiles = false;
    try {
      hasResultFiles = fs.existsSync(ASYNC_RESULTS_DIR) && fs.readdirSync(ASYNC_RESULTS_DIR).some(f => f.endsWith(".json"));
    } catch (e: any) { log.error(`result files check failed: ${e?.message || e}`); }
    if (asyncState.jobs.size > 0 || hasResultFiles) {
      ensureAsyncPoller();
    }
    updateAsyncWidget(); // Always set status (shows "0 async agents" when idle)

    startResultWatcher();
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    log.info(`shutdown: jobs=${asyncState.jobs.size}`);
    if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
    if (asyncState.watcher) { asyncState.watcher.close(); asyncState.watcher = null; }
  });

  // /async-status — fullscreen overlay list → live output detail
  async function handleAsyncStatus(ctx: any): Promise<void> {
    if (!ctx.hasUI) return;
    log.debug("opening_async_status_overlay", { jobs: asyncState.jobs.size });
    const { openAsyncStatusOverlay } = await import("./async-status-ui.js");
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
      job.durationMs = Date.now() - job.startedAt;
      // Persist killed state to disk — prevents stale re-delivery on reload
      try {
        const statusPath = path.join(job.workerDir, "status.json");
        const existing = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf-8")) : {};
        existing.state = "failed";
        existing.exitCode = -9;
        existing.endedAt = Date.now();
        existing.output = "Killed by user";
        fs.writeFileSync(statusPath, JSON.stringify(existing), { mode: 0o600 });
      } catch (e: any) { log.error(`kill: status.json update failed for ${job.id}: ${e?.message}`); }
      // Delete result file if it exists — prevent re-ingestion on reload
      try { fs.unlinkSync(path.join(ASYNC_RESULTS_DIR, `${job.id}.json`)); } catch {}
      // Record killed reviewer as having 0 findings — prevents permanent commit block
      let killSideEffectsOk = true;
      if (job.agent.startsWith("code-reviewer-")) {
        try { recordReviewerResult(jobCwd(job), job.agent, 0); } catch (e: any) { killSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
      }
      if (killSideEffectsOk) job.sideEffectsApplied = true;
      // Check if this completes a group — deliver remaining siblings' results
      if (job.groupId) {
        const groupJobs = Array.from(asyncState.jobs.values()).filter(j => j.groupId === job.groupId);
        const pending = groupJobs.filter(j => j.status !== "complete" && j.status !== "failed");
        if (pending.length === 0) {
          deliverGroupResults(groupJobs);
        }
      } else if (asyncState.lastCtx && !job.fireAndForget) {
        // Non-grouped killed job — deliver immediately so AI knows it was killed
        const displayName = job.name || job.agent;
        const duration = job.durationMs || (Date.now() - job.startedAt);
        const rawOutput = typeof job.output === "string" ? job.output : "Killed by user";
        const output = formatAsyncResultOutput(
          job.agent,
          rawOutput,
          resultOutputPath(job),
        );
        const killContent = `## Async Agent Result: ${displayName} ❌ failed\n\nTask: ${job.task}\nDuration: ${formatDuration(duration)}\n\n${output}`;
        if (wasAlreadyDelivered(job.id)) {
          job.delivered = true;
          log.debug(`kill: skipping already-delivered result for ${job.id}`);
        } else {
          try {
            pi.sendMessage({
              customType: "async-agent-result",
              content: killContent,
              display: true,
            }, { triggerTurn: true, deliverAs: "followUp" });
            job.delivered = true;
            recordDelivered(job.id);
          } catch (e: any) {
            log.error(`kill delivery failed for ${job.id}: ${e?.message}`);
            // delivered stays false — reconciliation will retry
          }
        }
      } else if (job.fireAndForget) {
        job.delivered = true;
      }
      // Delay cleanup — only for delivered jobs
      if (job.delivered) {
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
  // Implements the subagents:rpc:* protocol so pitasks' TaskExecute
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

  // Spawn — create an async agent from pitasks' TaskExecute
  handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    "subagents:rpc:spawn", async ({ type, prompt, options }) => {
      const ctx = asyncState.lastCtx;
      if (!ctx) throw new Error("No active session");
      if (!type || typeof type !== "string") throw new Error("Missing or invalid 'type' parameter");
      if (!prompt || typeof prompt !== "string") throw new Error("Missing or invalid 'prompt' parameter");

      const cwd = options?.cwd || ctx.cwd;
      log.debug("rpc_spawn_requested", { type, customCwd: Boolean(options?.cwd) });
      const discoverAgents = runtime.discoverAgents ?? (await import("./agents.js")).discoverAgents;
      const discovery = discoverAgents(cwd, "both");
      const agents = discovery.agents;

      // Find agent by type (case-insensitive, fall back to "worker")
      const agentName = agents.find(a => a.name.toLowerCase() === type.toLowerCase())?.name
        || agents.find(a => a.name === "worker")?.name
        || type;

      const result = spawnAsyncAgent(agentName, prompt, cwd, agents, {
        name: options?.description || agentName,
        taskId: "-1",  // pitasks manages its own task linkage via agentTaskMap
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

  // Emit subagents:ready so pitasks can discover us
  pi.on("session_start", () => {
    pi.events.emit("subagents:ready", {});
  });

  return {
    spawnAsyncAgent,
    killAsyncAgent,
    getAsyncJobs: () => Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued"),
  };
}
