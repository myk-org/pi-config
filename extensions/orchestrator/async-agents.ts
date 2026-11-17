/**
 * Async agent infrastructure — background agent spawning, polling, result watching.
 */

import { parseAsyncOutputLine } from "./async-status-parse.js";
import { isProcessAlive, signalAndReportSurvivors } from "./async-kill-signal.js";
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
import { trailToolsArgs } from "./trail.js";
import { getPiInvocation, getProjectTmpDir, parseProcStartTime, djb2Hash } from "./utils.js";
import { addReviewerPending, recordReviewerResult, countFindings, readReviewState, subjectKey } from "./pi-config-review-state.js";
import { resolveReviewSubject } from "./review-subject.js";
import {
  getMainBranch,
} from "./git-helpers.js";
import { waitForResultFiles } from "./async-wait.js";
import { formatAsyncResultOutput, reviewerOutputArchivePath, MAX_OUTPUT_CHARS } from "./async-result-format.js";
import { cleanupReviewerOutputArchives } from "./reviewer-output-archive.js";
const log = createLogger("async_agents");

export { autoCompleteTask, autoMarkInProgress, resolveTaskStorePath } from "./task-lifecycle.js";
import { autoCompleteTask, autoMarkInProgress, resolveTaskStorePath } from "./task-lifecycle.js";
import { openAsyncStatusOverlay } from "./async-status-ui.js";
import type { AsyncStatusJobView } from "./async-status-ui.js";
import {
  abortSyncAgentRun,
  clearSyncAgentRuns,
  formatAgentsStatus,
  listSyncAgentRuns,
  onSyncAgentRunsChanged,
  syncAgentRunCount,
} from "./sync-agent-runs.js";
import { setSlot } from "./status-bar.js";
import { getSetting } from "./project-settings.js";
import { substituteSettingsPlaceholders } from "./rule-placeholders.js";
import { emitIfLive, isLiveExtensionCtx } from "../shared/live-ctx.js";
import { sendSystemNote } from "../shared/system-note.js";

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
  /** Delivered by the phantom-timeout fallback with no findings ingested. The result file may
   *  still land, so it is never unlinked and a late delivery is still owed. */
  deliveredWithoutResult?: boolean;
  /** One-shot: the late result for a `deliveredWithoutResult` job was sent. */
  lateResultSent?: boolean;
  sideEffectsApplied?: boolean;
  fireAndForget?: boolean;
  /** One-shot: fires once with the ingested result text. Used by async chains to feed {previous}. */
  onComplete?: (result: { text: string; isError: boolean }) => void;
  /** Set when the empty timeout fallback withheld this job's chain hook for the late result. */
  pendingChainHook?: boolean;
  /** When `pendingChainHook` was set — bounds how long the chain waits for a result that never comes. */
  pendingChainHookAt?: number;
  groupId?: string;
  taskId?: string;
  /** The task store file this job's task lives in, recorded at spawn time. The only path a
   *  later lifecycle write may use: after a reload the env no longer knows this job's list. */
  taskStorePath?: string;
  cwd?: string;
  projectCwd?: string;
  sessionId?: string;
  model?: string;
  restoredPid?: number;
  /** Who killed this job, if it was killed. Drives the attribution suffix in delivery headers. */
  killOrigin?: AsyncKillOrigin;
}

/**
 * Who requested an async-agent kill.
 * - `user` — a human action: the async-status overlay `x`/`a`, or the pidash browser UI
 * - `orchestrator` — the LLM via `subagent(asyncKill=...)`
 * - `task-system` — pitasks TaskExecute via `subagents:rpc:stop`
 * The pidash browser UI is a human clicking, so it is a `user` kill.
 */
export type AsyncKillOrigin = "user" | "orchestrator" | "task-system";

export interface AsyncChainStep {
  agent: string;
  task: string;
  cwd?: string;
  taskId?: string;
}

/** Durable record of an async chain's position, written into each step's workerDir
 *  as chain.json. The step's continuation lives in the onComplete closure, which a
 *  reload destroys — this file is what lets restoration report the chain instead of
 *  dropping it silently. */
export interface AsyncChainState {
  steps: AsyncChainStep[];
  /** Index (0-based) of the step being spawned when this was written. */
  index: number;
  previous: string;
  /** Set once restoration has reported this chain as interrupted. */
  interruptedAt?: number;
}

function readChainState(workerDir: string): AsyncChainState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workerDir, "chain.json"), "utf-8"));
    return Array.isArray(parsed?.steps) ? parsed as AsyncChainState : null;
  } catch { return null; }
}

/** Human-readable attribution per origin. The single source for every surface. */
export const KILL_ORIGIN_LABELS: Record<AsyncKillOrigin, string> = {
  user: "Killed by user",
  orchestrator: "Killed by orchestrator",
  "task-system": "Killed by task system",
};

/** Get the effective working directory for a job. */
function jobCwd(job: { cwd?: string; projectCwd?: string }): string {
  return job.cwd || job.projectCwd || process.cwd();
}

/** Fire the job's completion hook exactly once, with the already-ingested result.
 *  Clearing it first stops the reconciliation pass from re-firing it (which would
 *  spawn the next async-chain step twice after a failed delivery). */
export function fireOnComplete(job: AsyncJob): void {
  const cb = job.onComplete;
  job.onComplete = undefined;
  if (!cb) return;
  try {
    cb({ text: typeof job.output === "string" ? job.output : "", isError: job.status === "failed" });
  } catch (e: any) { log.error(`onComplete callback failed for ${job.id}: ${e?.message}`); }
}

/** Fire every pending completion hook in one reconciliation pass.
 *  Returns how many fired. Exported so the PASS is testable, not just the
 *  single-job helper — the hook-once guarantee is a property of the loop. */
export function firePendingCompletions(jobs: Iterable<AsyncJob>): number {
  let fired = 0;
  for (const job of jobs) {
    if (!job.onComplete) continue;
    fireOnComplete(job);
    fired++;
  }
  if (fired > 0) log.info("fire_pending_completions", { fired });
  return fired;
}

/** A withheld chain hook has no reader: if its result never lands, the chain stalls silently and
 *  its remaining steps are never spawned. Recover such a job once, past the grace period.
 *  Clearing the flag is what makes it fire at most once. */
export function recoverStalledChainHooks(
  jobs: Iterable<AsyncJob>,
  opts: { graceMs: number; now?: number },
): Array<{ job: AsyncJob; chain: AsyncChainState | null }> {
  const now = opts.now ?? Date.now();
  const recovered: Array<{ job: AsyncJob; chain: AsyncChainState | null }> = [];
  for (const job of jobs) {
    if (!job.pendingChainHook || job.output !== undefined) continue;
    if (now - (job.pendingChainHookAt ?? now) <= opts.graceMs) continue;
    job.pendingChainHook = false;
    job.pendingChainHookAt = undefined;
    // The parent is about to be told the chain STOPPED. A result landing afterwards is still
    // delivered through the late path, and a surviving hook would spawn the next step twice.
    job.onComplete = undefined;
    recovered.push({ job, chain: readChainState(job.workerDir) });
  }
  return recovered;
}

/** What the parent is told when a withheld chain hook was recovered without a result. */
export function chainStoppedNote(job: AsyncJob, chain: AsyncChainState | null): string {
  const step = chain ? `step ${chain.index + 1} of ${chain.steps.length}` : "its current step";
  const remaining = chain ? [...new Set(chain.steps.slice(chain.index + 1).map(s => s?.agent || "unknown"))] : [];
  return `⚠️ Async chain STOPPED at ${step} (job ${job.id}, ${job.agent}) — its result was never written, so the next step was not spawned on empty input.${remaining.length > 0 ? ` Remaining agents: ${remaining.join(", ")}.` : ""} Re-run them with subagent(chain: ...).`;
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

/** What the spawn-exit timer may do for a child that just exited.
 *
 *  Recording is independent of the extension instance: after /reload the ctx is gone, and gating the
 *  status write on it made a failed agent vanish from the task list. Delivery needs a live ctx.
 *  Pure so the decision is testable without spawning a process. */
export function planSpawnExitRecovery(args: { status: string; hasLiveCtx: boolean }): { record: boolean; deliver: boolean } {
  if (args.status === "complete" || args.status === "failed") return { record: false, deliver: false };
  return { record: true, deliver: args.hasLiveCtx };
}

export function registerAsyncAgents(
  pi: ExtensionAPI,
  terminalNotify: (title: string, body: string) => void,
  runtime: {
    spawnProcess?: typeof spawn;
    discoverAgents?: (cwd: string, scope: "both") => Pick<AgentDiscoveryResult, "agents">;
  } = {},
): {
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; projectCwd?: string; sessionId?: string; onComplete?: (result: { text: string; isError: boolean }) => void; persistSession?: boolean; explicit?: { model?: string; provider?: string }; chain?: AsyncChainState }) => { id: string; error?: string; model?: string };
  killAsyncAgent: (target: string, origin?: AsyncKillOrigin) => { killed: string[]; errors: string[] };
  /** The full job record: callers read `taskStorePath` and the delivery flags off it. */
  getAsyncJobs: () => AsyncJob[];
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

  /**
   * Readable text a killed worker had produced, recovered from its output.log.
   *
   * output.log is a JSONL event stream, so it is run through the same
   * parseAsyncOutputLine the async-status overlay uses — reading it raw ships the
   * raw event JSON to the AI instead of the work the agent actually did. Lines the
   * parser does not recognise are dropped, matching overlay behaviour.
   *
   * Capped so a chatty agent cannot push a megabyte into the delivery message and
   * the AI's context. The budget is sized so the composed kill output (label plus
   * this text) still fits inside formatAsyncResultOutput's MAX_OUTPUT_CHARS: that
   * formatter keeps the HEAD of its budget, so a tail kept here and then re-trimmed
   * from the head would hand the AI the OLDEST part of the newest context — exactly
   * the lines immediately before the kill that explain why it was stopped.
   */
  const TRUNCATION_MARKER = "…(earlier output truncated)\n";
  // Only a bounded tail is ever read: the runner appends output with no size cap, so
  // reading the whole log made killing a chatty agent block the orchestrator and cost
  // memory proportional to that log — for a tail we are about to discard anyway.
  const MAX_TAIL_BYTES = 256 * 1024;

  /**
   * Last-resort text recovery from a JSONL record the tail boundary cut in half.
   *
   * The read runs to EOF, so a record larger than the tail keeps its END and loses only its
   * opening — the delta field itself is usually intact. Pulling that field out directly is
   * what lets such an event still contribute its text instead of the delivery carrying only
   * the kill label. The second form covers a record cut mid-delta, whose closing quote never
   * made it into the tail.
   */
  function recoverTruncatedDelta(line: string, firstOfBoundedRead: boolean): string | null {
    // A COMPLETE record that parseAsyncOutputLine deliberately rejects is not truncated
    // output. toolcall_delta carries a `delta` field, and lifting it would ship a killed
    // worker's raw tool arguments into the persisted output and the AI-facing delivery.
    try {
      JSON.parse(line);
      return null;
    } catch {
      /* not a complete record — continue */
    }
    // A truncated record is recognised by what it CONTAINS, not by where it sits. The type
    // markers precede the value, so a record cut mid-write still carries them; stderr never
    // does. Positioning was the previous guard and it was wrong twice over: it discarded a
    // legitimate partial final event — exactly what a worker killed mid-write leaves behind —
    // whenever the log was read whole or the event followed other lines.
    // The INNER event type, not the envelope: toolcall_delta is also a message_update, so
    // matching the envelope would admit every truncated tool-call update as agent text.
    const looksLikeTextEvent = line.includes('"text_delta"');
    if (looksLikeTextEvent) {
      const closed = /"delta"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let last: RegExpExecArray | null = null;
      let m: RegExpExecArray | null;
      while ((m = closed.exec(line)) !== null) last = m;
      if (last) {
        try {
          return JSON.parse(`"${last[1]}"`);
        } catch {
          /* fall through to the open-ended form */
        }
      }
      const open = line.match(/"delta"\s*:\s*"((?:[^"\\]|\\.)*)$/);
      if (open) {
        try {
          return JSON.parse(`"${open[1]}"`);
        } catch {
          return null;
        }
      }
    }
    // The record is larger than the whole window, so even its type markers sit before the
    // tail and the fragment is recognisable only by position and shape: it must be the first
    // line of a BOUNDED read and must end in a closing quote followed by closing braces.
    // A diagnostic like `Error: cannot open "/tmp/x"` contains a quote but neither.
    if (!firstOfBoundedRead) return null;
    if (!/"\s*}\s*}\s*$/.test(line)) return null;
    const q = line.lastIndexOf('"');
    if (q <= 0) return null;
    const fragment = line.slice(0, q);
    try {
      return JSON.parse(`"${fragment}"`);
    } catch {
      return fragment;
    }
  }
  function readPartialWorkerOutput(job: Pick<AsyncJob, "id" | "workerDir">, budget: number): string {
    const outputPath = path.join(job.workerDir, "output.log");
    try {
      if (!fs.existsSync(outputPath)) {
        log.debug("kill_output_absent", job.id);
        return "";
      }
      const size = fs.statSync(outputPath).size;
      let raw: string;
      const usedTailRead = size > MAX_TAIL_BYTES;
      if (!usedTailRead) {
        raw = fs.readFileSync(outputPath, "utf-8");
      } else {
        const fd = fs.openSync(outputPath, "r");
        try {
          const buf = Buffer.alloc(MAX_TAIL_BYTES);
          const read = fs.readSync(fd, buf, 0, MAX_TAIL_BYTES, size - MAX_TAIL_BYTES);
          raw = buf.toString("utf-8", 0, read);
        } finally {
          fs.closeSync(fd);
        }
        // The tail may start mid-record, but that is NOT a reason to discard anything: the
        // record might be complete, and even a partial one can still yield its text. Blanking
        // the first line unconditionally lost a complete event whenever the offset happened to
        // land on a record boundary. Unparseable lines are recovered leniently below instead.
        log.debug("kill_output_tail_read", { job: job.id, size, read: MAX_TAIL_BYTES });
      }
      // Concatenate each parsed value VERBATIM. parseAsyncOutputLine returns text deltas
      // unchanged and prefixes tool events with a newline, so appending preserves both the
      // fragment boundaries of a streamed word ("Hel" + "lo") and the event boundaries.
      // Splitting each value into lines and rejoining with "\n" turned "Hel" "lo" into
      // "Hel\nlo" — corrupting the recovered text of every killed agent.
      let text = "";
      // Truncated-record recovery runs on any line that fails to parse, but recoverTruncatedDelta
      // decides on what the line CONTAINS: a partial assistant event keeps its type markers,
      // while stderr and complete-but-rejected events never qualify. `usedTailRead && i === 0`
      // is passed separately because an oversized record is recognisable only by position —
      // its markers fall before the window.
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const parsed = parseAsyncOutputLine(line)
          ?? recoverTruncatedDelta(line, usedTailRead && i === 0);
        if (parsed === null) continue;
        text += parsed;
      }
      text = text.trim();
      if (!text) {
        log.debug("kill_output_no_readable_events", job.id);
        return "";
      }
      const out = text.length > budget
        ? `${TRUNCATION_MARKER}${text.slice(-budget)}`
        : text;
      log.info("kill_output_recovered", { job: job.id, chars: out.length, truncated: out !== text });
      return out;
    } catch (e: any) {
      // Handled loss: the kill path has no other output to fall back on, so the agent's
      // partial work never reaches the result delivered to the AI.
      log.warn("kill_output_recovery_failed", { job: job.id, error: e?.message || String(e) });
      return "";
    }
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
  function getLiveAsyncCtx(): any | null {
    const ctx = asyncState.lastCtx;
    if (!isLiveExtensionCtx(ctx)) {
      log.debug("async_context_stale", { hadContext: ctx !== null });
      asyncState.lastCtx = null;
      return null;
    }
    return ctx;
  }

  /** Emit on the extension's event bus, tolerating a stale instance. After /reload or a session
   *  replacement the captured `pi` is dead and `emit` throws (pi's assertActive); an unguarded
   *  emit from a surviving timer exits the whole process. */
  /** Returns whether the event actually reached the bus, so a caller can react to a lost event. */
  function safeEmit(event: string, data: unknown): boolean {
    // Shared guard: after a reload the captured pi is dead and emit throws (pi's assertActive).
    return emitIfLive(pi, event, data);
  }

  function updateAsyncWidget() {
    try {
      const ctx = getLiveAsyncCtx();
      if (!ctx?.hasUI) return;
      const running = Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued");
      const names = running.map(j => j.name || j.agent).join(", ");
      // Sync agents are real child processes too; count both so nothing running is hidden.
      const syncRuns = listSyncAgentRuns();
      const syncNames = syncRuns.map(r => r.agent).join(", ");
      const widgetKey = `${running.length}:${names}:${syncRuns.length}:${syncNames}`;
      const changed = widgetKey !== lastWidgetKey;
      lastWidgetKey = widgetKey;
      const total = running.length + syncRuns.length;
      const label = formatAgentsStatus(running.length, syncRuns.length);
      if (total > 0) {
        setSlot("async", ctx.ui.theme.fg("warning", label), ctx);
      } else if (changed) {
        setSlot("async", ctx.ui.theme.fg("muted", label), ctx);
      }
      // Always emit to pidash — browser may have reconnected and needs fresh state
      safeEmit("pidash:async-status", {
        count: total,
        agents: [names, syncNames].filter(Boolean).join(", "),
        jobs: [
          ...running.map(j => ({
            id: j.id,
            name: j.name || j.agent,
            agent: j.agent,
            task: j.task,
            status: j.status,
            startedAt: j.startedAt,
            mode: "async" as const,
          })),
          ...syncRuns.map(r => ({
            id: r.id,
            name: r.agent,
            agent: r.agent,
            task: r.task,
            status: "running" as const,
            startedAt: r.startedAt,
            mode: "sync" as const,
            currentTool: r.currentTool,
          })),
        ],
      });
    } catch { /* stale ctx after session replacement */ }
  }

  // Sync runs share the footer/pidash surface with async jobs, so a change repaints both.
  const unsubscribeSyncRuns = onSyncAgentRunsChanged(() => updateAsyncWidget());

  function ensureAsyncPoller() {
    if (asyncState.poller) return;
    asyncState.poller = setInterval(() => {
      const liveCtx = getLiveAsyncCtx();
      if (!liveCtx) {
        // ctx is stale (session ended) — stop polling
        if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
        return;
      }
      try {
        if (!liveCtx.hasUI) return;
      } catch {
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
              try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch {}
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
                try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch {}
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
              try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch {}
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
                    try { recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings, { since: job.startedAt }); } catch (e: any) { zombieSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
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
                    try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch (e: any) { catchSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
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
                  try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch (e: any) { noFileSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
                }
                if (noFileSideEffectsOk) job.sideEffectsApplied = true;
              }
              // Delivery happens in the reconciliation sweep at the end of this tick.
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

      // Reconciliation sweep — deliver every finished-but-undelivered job, grouped or not,
      // on every tick. This is the safety net for a missed watcher event or a reload, and it
      // is also where poller-detected completions above get delivered. Idempotent: a job an
      // earlier path already delivered has `delivered` set and is skipped here.
      for (const job of asyncState.jobs.values()) {
        if ((job.status !== "complete" && job.status !== "failed") || job.delivered) continue;
        // Side-effects: ensure they fired (only mark applied when ALL succeed)
        if (!job.sideEffectsApplied) {
          let sideEffectsOk = true;
          if (job.agent.startsWith("code-reviewer-")) {
            const findings = countFindings(typeof job.output === "string" ? job.output : "");
            try { recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings, { since: job.startedAt }); } catch (e: any) { sideEffectsOk = false; log.error(`reconcile: recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
          }
          if (sideEffectsOk) job.sideEffectsApplied = true;
        }
        void deliverJobResult(job);
      }
      // A withheld hook whose result never arrives stalls the chain forever: report the stop once
      // instead of hanging, and never spawn the next step on empty input.
      for (const { job, chain } of recoverStalledChainHooks(asyncState.jobs.values(), { graceMs: 2 * getSetting(liveCtx.cwd, "async_phantom_timeout_ms") })) {
        log.warn("chain_hook_recovered_no_result", { job: job.id, agent: job.agent, step: chain ? chain.index + 1 : null, chain_steps: chain?.steps.length ?? null });
        void sendSystemNote(
          pi,
          chainStoppedNote(job, chain),
          { customType: "subagent-chain-error", triggerTurn: true, deliverAs: "followUp" },
        ).catch((e: any) => log.error(`chain_recovered note failed: ${e?.message || e}`));
      }
      // Remove completed/failed jobs older than 30s — require delivered before cleanup. A job
      // still owed a late result stays: evicting it would orphan (and so delete) that result.
      // shortcut: an owed late result that never arrives stays in the map for this session.
      for (const [id, job] of asyncState.jobs.entries()) {
        if ((job.status === "complete" || job.status === "failed")
            && Date.now() - job.updatedAt > 30000
            && job.delivered
            && !(job.deliveredWithoutResult && !job.lateResultSent)) {
          asyncState.jobs.delete(id);
        }
      }
      updateAsyncWidget();
    }, getSetting(process.cwd(), "async_poll_interval_ms"));
    if (asyncState.poller.unref) asyncState.poller.unref();
  }

  /** Deliver ONE job's result the moment it finishes. Never gated on `groupId`: a finished
   *  agent must not wait for its slowest sibling (issue #1110). `groupId` stays display-only.
   *  Idempotent (`job.delivered` + the in-flight set), so the watcher, the poller sweep, the
   *  spawn-exit timer and the kill path can all call it for the same job. */
  const deliveryInProgress = new Set<string>();
  async function deliverJobResult(job: AsyncJob, opts?: { fireHook?: boolean }): Promise<void> {
    const fireHook = opts?.fireHook !== false;
    // A timeout-fallback delivery carries no findings. A result file that lands afterwards
    // re-enters here as a one-shot late delivery, so the guard must let that one through.
    const isLate = job.deliveredWithoutResult === true && !job.lateResultSent;
    if ((job.delivered && !isLate) || deliveryInProgress.has(job.id)) return;
    if (job.status !== "complete" && job.status !== "failed") return;
    deliveryInProgress.add(job.id);
    try {
      // A kill/zombie/phantom path can reach delivery before the watcher has read this
      // job's result file — ingest it here so the message carries the agent's real output.
      if (job.output === undefined && !job.fireAndForget) {
        const resultPath = path.join(ASYNC_RESULTS_DIR, `${job.id}.json`);
        if (!fs.existsSync(resultPath)) await waitForResultFiles(ASYNC_RESULTS_DIR, [job.id], 2000);
        // Re-check after the wait: a concurrent ingestion may have filled the output in,
        // and the file it consumed is gone by now.
        if (job.output === undefined) {
          try {
            const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
            job.output = data.output;
            preserveReviewerOutput(job, typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? ""));
            job.exitCode = data.exitCode;
            job.durationMs = data.durationMs;
            if (data.success !== undefined) job.status = data.success ? "complete" : "failed";
            log.debug(`deliver: late-ingested result for ${job.id}`);
          } catch (e: any) { log.debug(`deliver: no result file to ingest for ${job.id}: ${e?.message}`); }
        }
      }

      // A terminal status is not a final result: async-runner writes it BEFORE its reviewer
      // JSON retries finish. Delivering now would send empty output and delete the findings
      // when they land, so wait until the result was ingested (`job.output` is its marker).
      // Killed/phantom/zombie jobs fill `output` themselves; the phantom timeout bounds the
      // wait so a genuinely missing file cannot strand the job forever.
      let noIngestedResult = false;
      if (job.output === undefined && !job.fireAndForget) {
        const sinceTerminal = Date.now() - (job.updatedAt || job.startedAt);
        const boundMs = getSetting(jobCwd(job), "async_phantom_timeout_ms");
        if (sinceTerminal <= boundMs) {
          log.debug("deliver_deferred_no_result", { job: job.id, status: job.status, since_terminal_ms: sinceTerminal });
          return;
        }
        log.warn("deliver_no_result_file", { job: job.id, status: job.status, since_terminal_ms: sinceTerminal });
        // The retry outlived the bound. Deliver what we have, but keep the result file and
        // stay open to a late one: a retry longer than the timeout still holds the findings.
        noIngestedResult = true;
      }

      let autoCompleteError = "";
      // A chain continuation fired with the empty fallback text would spawn its next step with
      // no {previous}. Withhold it so the late result fires it once with the real text.
      const withholdChainHook = noIngestedResult && !!job.onComplete && readChainState(job.workerDir) !== null;
      if (withholdChainHook) {
        job.pendingChainHook = true;
        job.pendingChainHookAt = Date.now();
        log.warn("chain_hook_withheld_no_result", { job: job.id, agent: job.agent });
      }
      // Auto-complete the linked task even without a live ctx: the poller stops for a stale
      // ctx, so gating this on one left the task open forever after a reload.
      if (!job.fireAndForget && job.taskId && job.taskId !== "-1" && job.status === "complete" && job.cwd) {
        try {
          const completed = await autoCompleteTask(job.taskId, job.projectCwd || job.cwd, job.taskStorePath);
          log.info(`auto-completed task #${job.taskId}: ${completed}`);
        } catch (e: any) {
          autoCompleteError = `\n\n⚠️ Failed to auto-complete task #${job.taskId}: ${e?.message}. Run TaskUpdate(taskId="${job.taskId}", status="completed") manually.`;
          log.error(`auto-complete failed for task #${job.taskId}: ${e?.message}`);
        }
      }

      if (job.fireAndForget) {
        if (fireHook && !withholdChainHook) fireOnComplete(job);
        job.delivered = true;
      } else if (getLiveAsyncCtx()) {
        const displayName = job.name || job.agent;
        const resultStatus = job.status === "complete" ? "✅ completed" : "❌ failed";
        const maxOutput = Math.max(MAX_OUTPUT_CHARS - autoCompleteError.length, 500);
        const output = formatAsyncResultOutput(job.agent, job.output || "", resultOutputPath(job), maxOutput);
        const duration = job.durationMs || (job.updatedAt ? job.updatedAt - job.startedAt : 0);
        const killSuffix = job.killOrigin ? ` — ${KILL_ORIGIN_LABELS[job.killOrigin]}` : "";
        const lateNote = isLate ? "\n\n_(late result — it arrived after the timeout fallback already delivered an empty one)_" : "";
        // A late reviewer result is NOT written to review state: it let an older round's findings
        // land on a newer one, and every delivery retry multiplied them. Deliver it and tell the
        // parent the loop has to re-poll instead.
        let lateReviewNote = "";
        if (isLate && job.agent.startsWith("code-reviewer-")) {
          const findings = countFindings(typeof job.output === "string" ? job.output : "");
          log.warn("late_reviewer_result_unapplied", { agent: job.agent, findings });
          lateReviewNote = `\n\n⚠️ Reviewer ${job.agent} produced its result AFTER the delivery timeout. It carried ${findings < 0 ? "an unparsable number of" : findings} finding(s) and the review state was NOT updated automatically — re-poll ${job.agent} to apply them.`;
        }
        const content = `## Async Agent Result: ${displayName} ${resultStatus}${killSuffix}${lateNote}\n\nTask: ${job.task}\nDuration: ${formatDuration(duration)}\n\n${output}${autoCompleteError}${lateReviewNote}`;
        if (job.status === "complete") {
          safeEmit("subagents:completed", { id: job.id, result: job.output || "" });
        } else {
          safeEmit("subagents:failed", { id: job.id, error: job.output || "Agent failed", result: job.output || "", status: "failed" });
        }
        if (wasAlreadyDelivered(job.id) && !isLate) {
          job.delivered = true;
          log.debug(`deliver: skipping already-delivered result for ${job.id}`);
        } else {
          try {
            pi.sendMessage({
              customType: "async-agent-result",
              content,
              display: true,
            }, { triggerTurn: true, deliverAs: "followUp" });
            recordDelivered(job.id);
            job.delivered = true;
            if (isLate) {
              job.lateResultSent = true;
              log.info("deliver_late_result", { job: job.id, agent: job.agent });
            }
            log.debug("deliver_ok", job.id);
          } catch (e: any) {
            log.error(`deliver: sendMessage failed for ${job.id}: ${e?.message}`);
            // delivered stays false — the reconciliation sweep retries on the next poll
          }
        }
        if (job.delivered && fireHook && !withholdChainHook) fireOnComplete(job);
      } else {
        // No live ctx: delivered stays false so the reconciliation sweep retries later.
        log.debug("deliver_deferred_no_live_ctx", { job: job.id, status: job.status });
      }

      // A result is consumed only once it actually reached the parent. An empty fallback
      // delivery never consumes it (the findings may still arrive), and a late attempt that
      // failed must keep its file so the poller can retry it.
      const consumed = job.delivered && !noIngestedResult && !(isLate && !job.lateResultSent);
      if (job.delivered && noIngestedResult) {
        // In-memory marker: a result file appearing later is the real result, not a stale one.
        job.deliveredWithoutResult = true;
      }
      if (consumed) {
        // Persist delivered state so restore skips this job
        try {
          const sp = path.join(job.workerDir, "status.json");
          const ex = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : {};
          ex.delivered = true;
          delete ex.deliveredWithoutResult;
          if (job.lateResultSent) ex.lateResultSent = true;
          fs.writeFileSync(sp, JSON.stringify(ex), { mode: 0o600 });
        } catch {}
        try { fs.unlinkSync(path.join(ASYNC_RESULTS_DIR, `${job.id}.json`)); } catch (e: any) {
          // ENOENT = already deleted by processResultFile — expected
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.debug(`unlink failed ${job.id}: ${e?.message}`);
        }
      } else if (job.delivered) {
        // Leak-free by design: keep `delivered` unset on disk so a reload reconstructs this job
        // and delivers the late result instead of unlinking it as an orphan.
        try {
          const sp = path.join(job.workerDir, "status.json");
          const ex = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf-8")) : {};
          if (noIngestedResult) {
            delete ex.delivered;
            ex.deliveredWithoutResult = true;
          }
          fs.writeFileSync(sp, JSON.stringify(ex), { mode: 0o600 });
        } catch {}
        log.warn("deliver_kept_result_file", { job: job.id, status: job.status, late_pending: isLate });
      }
    } catch (e: any) {
      log.error(`deliverJobResult failed for ${job.id}: ${e?.message}`);
    } finally {
      deliveryInProgress.delete(job.id);
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
      log.debug(`processResultFile: ${path.basename(resultPath)} job=${!!job} delivered=${job?.delivered} hasCtx=${!!getLiveAsyncCtx()} fireAndForget=${job?.fireAndForget} groupId=${job?.groupId}`);
      if (!job) {
        // Orphan result file — job not in current session. Clean up to prevent re-delivery on reload.
        try { fs.unlinkSync(resultPath); } catch (e: any) { log.debug(`orphan cleanup failed: ${resultPath}: ${e?.message}`); }
        return;
      }
      if (job.delivered) {
        // The timeout fallback already sent an empty result while this file was still being
        // written. The findings are the whole point — deliver them as a one-shot late result.
        if (job.deliveredWithoutResult && !job.lateResultSent) {
          job.status = data.success ? "complete" : "failed";
          job.output = data.output;
          job.exitCode = data.exitCode;
          job.durationMs = data.durationMs;
          preserveReviewerOutput(job, typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? ""));
          log.info("ingest_late_result", { job: job.id, agent: job.agent });
          await deliverJobResult(job);
          return;
        }
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
          recordReviewerResult(jobCwd(job), job.agent, findings < 0 ? 1 : findings, { since: job.startedAt });
        } catch (e: any) { processResultSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
        // Clear reviewer session if context usage > 80% to prevent overflow on next cycle
        // Use model context window from the agent's effective model.
        // If agent uses a custom model, we pass its context window via the config.
        // Fall back to orchestrator's model context window.
        const contextWindow = data.contextWindow || getLiveAsyncCtx()?.model?.contextWindow || 0;
        if (data.lastUsage?.totalTokens && data.lastUsage.totalTokens > 0 && contextWindow > 0) {
          const pct = (data.lastUsage.totalTokens / contextWindow) * 100;
          if (pct > 80) {
            const sessId = `async-${job.agent}-${djb2Hash(job.agent + ':' + (jobCwd(job)) + ':' + (getLiveAsyncCtx()?.sessionManager?.getSessionId?.() || '')).toString(36)}`;
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

      // Deliver this job's own result now. A grouped job never waits for its siblings:
      // `groupId` is display-only (issue #1110).
      await deliverJobResult(job);
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
      const resultsDir = ASYNC_RESULTS_DIR;
      asyncState.watcher = fs.watch(resultsDir, (ev, file) => {
        if (ev !== "rename" || !file) return;
        const fileName = file.toString();
        log.debug("watcher_event", ev, fileName);
        if (!fileName.endsWith(".json")) return;
        const resultPath = path.join(resultsDir, fileName);
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
    options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; projectCwd?: string; sessionId?: string; onComplete?: (result: { text: string; isError: boolean }) => void; persistSession?: boolean; explicit?: { model?: string; provider?: string }; chain?: AsyncChainState },
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
    let { model: effectiveModel, provider: effectiveProvider } = resolveAgentModelProvider(agentName, agent, options?.parentModelId, options?.parentProvider, cwd, options?.explicit);
    const liveCtx = getLiveAsyncCtx();
    const resolvedProjectCwd = liveCtx?.sessionManager?.getCwd?.() || liveCtx?.cwd || options?.projectCwd;
    const resolvedSessionId = liveCtx?.sessionManager?.getSessionId?.() || options?.sessionId;
    // Record the task's store file now — the only moment the live owner can say where this
    // job's task lives. A reload cannot re-derive it from an env that may have changed.
    // Resolve from the project dir — the same one the lifecycle call uses — or a worktree
    // agent records the worktree's store and never touches the parent task list.
    const taskStorePath = options?.taskId ? resolveTaskStorePath(resolvedProjectCwd || cwd, resolvedSessionId || undefined) : undefined;
    fs.writeFileSync(path.join(workerDir, "session.json"), JSON.stringify({
      resultsDir: ASYNC_RESULTS_DIR,
      fireAndForget: options?.fireAndForget || false,
      parentPid: process.pid,
      parentStartTime,
      taskId: options?.taskId || null,
      taskStorePath: taskStorePath || null,
      cwd,
      projectCwd: resolvedProjectCwd || null,
      sessionId: resolvedSessionId || null,
    }), { mode: 0o600 });

    // Chain position — a reload drops the onComplete continuation, so restore reads
    // this file to report the chain it can no longer resume instead of losing it.
    if (options?.chain) {
      fs.writeFileSync(path.join(workerDir, "chain.json"), JSON.stringify(options.chain), { mode: 0o600 });
    }

    // Track reviewer spawn BEFORE building args — addReviewerPending sets status to
    // in_progress, so all reviewers in the same batch see consistent state.
    if (agentName.startsWith("code-reviewer-")) {
      // The state must record WHAT is reviewed: its PR, or the commit when there is no open PR.
      // A round that cannot name a PR or commit still has to be attributable, or it counts for
      // nothing (the bug this whole change fixes). It is recorded as `other`, never dropped.
      const subject = resolveReviewSubject(cwd, log) ?? { kind: "other" as const, id: `unresolved:${cwd}` };
      if (subject.kind === "other") log.warn("review_subject_unresolved", { cwd, agent: agentName, subject: subjectKey(subject) });
      try { addReviewerPending(cwd, agentName, subject); } catch { /* best-effort */ }
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
    const parentSessionId = getLiveAsyncCtx()?.sessionManager?.getSessionId?.() || '';
    const sessionIdSource = persistSession
      ? agentName + ':' + cwd + ':' + parentSessionId
      : agentName + ':' + task.slice(0, 100);
    const deterministicSessionId = `async-${agentName}-${djb2Hash(sessionIdSource).toString(36)}`;
    piArgs.push("--session-id", deterministicSessionId);
    if (effectiveModel) piArgs.push("--model", effectiveModel);
    if (effectiveProvider) piArgs.push("--provider", effectiveProvider);
    piArgs.push(...trailToolsArgs(agent.tools, cwd));

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
      contextWindow: getLiveAsyncCtx()?.model?.contextWindow || 0,
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
      PI_MODEL: effectiveModel || undefined,
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
      taskStorePath,
      cwd,
      projectCwd: resolvedProjectCwd || undefined,
      sessionId: resolvedSessionId || undefined,
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
        try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch {}
      }
      void deliverJobResult(job);
      updateAsyncWidget();
    });

    proc.once("exit", (code, signal) => {
      if (job.status === "complete" || job.status === "failed") return;
      if (code !== 0) {
        // Give 2s for result file to be written by async-runner
        setTimeout(() => {
          // This timer outlives /reload. Recording the failure must NOT depend on the instance
          // being alive (a failed agent would vanish); only delivery does.
          const plan = planSpawnExitRecovery({ status: job.status, hasLiveCtx: Boolean(getLiveAsyncCtx()) });
          if (!plan.record) return;
          try {
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
            try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch {}
          }
          if (!plan.deliver) {
            log.warn("spawn_exit_delivery_skipped_stale_ctx", { job: job.id, status: job.status });
            return;
          }
          void deliverJobResult(job);
          updateAsyncWidget();
          } catch (error: any) {
            log.warn("spawn_exit_timer_failed", { job: job.id, error: String(error?.message ?? error).slice(0, 200) });
          }
        }, 2000).unref();
      }
    });

    // addReviewerPending already called above (before piArgs construction)

    updateAsyncWidget();
    ensureAsyncPoller();
    startResultWatcher();

    // Auto-mark linked task as in_progress AFTER successful spawn
    if (options?.taskId && options.taskId !== "-1") {
      autoMarkInProgress(options.taskId, resolvedProjectCwd || cwd, taskStorePath)
        .catch(() => {});  // best-effort, don't block spawn
    }

    return { id, model: effectiveModel };
  }

  // Start result watcher on session start
  pi.on("session_start", (_event, ctx) => {
    if (!isLiveExtensionCtx(ctx)) {
      log.warn("session_start received a stale ctx; preserving async results for a live session");
      return;
    }
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
        // A terminal job has only done its job once the result REACHED the parent —
        // `delivered` says that. The deferral leaves jobs terminal while their result file is
        // still being written, and the timeout fallback delivers without findings, so a reload
        // must reconstruct those and KEEP the worker dir: dropping it loses the job, and the
        // poller would then unlink its result file as an orphan.
        const alreadySent = status.delivered === true || status.deliveredWithoutResult === true;
        if (isComplete && status.delivered === true) {
          try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
          log.debug(`cleaned delivered worker dir on restore: ${entry} (state=${status.state})`);
          continue;
        }
        // Restore running/queued jobs with alive processes, plus terminal-but-undelivered ones.
        log.debug("restore_check", id, "isAlive", isAlive, "state", status.state, "delivered", status.delivered === true, "deliveredWithoutResult", status.deliveredWithoutResult === true);
        if (isAlive || status.state === "running" || isComplete) {
          if (isComplete) {
            log.debug("restore_undelivered_terminal", {
              job: id,
              state: status.state,
              delivered_without_result: status.deliveredWithoutResult === true,
              has_output: typeof status.output === "string",
            });
          }
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
            // Undelivered terminal jobs stay undelivered so the sweep/ingest delivers them;
            // a fallback-delivered one must not be sent twice, but still owes a late result.
            delivered: isComplete && alreadySent,
            deliveredWithoutResult: status.deliveredWithoutResult === true || undefined,
            lateResultSent: status.lateResultSent === true || undefined,
            sideEffectsApplied: isComplete && alreadySent,
            fireAndForget: marker.fireAndForget || false,
            taskId: marker.taskId || undefined,
            taskStorePath: marker.taskStorePath || undefined,
            cwd: marker.cwd || undefined,
            projectCwd: marker.projectCwd || ctx.cwd || undefined,
            sessionId: marker.sessionId || undefined,
            model: status.model || marker.model || undefined,
            restoredPid: typeof status.pid === "number" ? status.pid : undefined,
          };
          asyncState.jobs.set(id, job);
          log.info(`restored job: ${id} state=${job.status}`);

          // A chain's continuation lived in the onComplete closure this reload destroyed.
          // chain.json records what was still pending — report it, never drop it silently.
          const chain = readChainState(job.workerDir);
          if (chain && chain.interruptedAt === undefined && chain.index + 1 < chain.steps.length) {
            const unspawned = chain.steps.slice(chain.index + 1);
            const remaining = [...new Set(unspawned.map(s => s?.agent || "unknown"))];
            const hasStepMeta = unspawned.some(
              s => (typeof s?.taskId === "string" && s.taskId.length > 0) || (typeof s?.cwd === "string" && s.cwd.length > 0),
            );
            const stepDetails = hasStepMeta
              ? unspawned.map((s, offset) => {
                  const agentLabel = s?.agent || "unknown";
                  const meta: string[] = [];
                  if (typeof s?.taskId === "string" && s.taskId.length > 0) meta.push(`taskId: ${s.taskId}`);
                  if (typeof s?.cwd === "string" && s.cwd.length > 0) meta.push(`cwd: ${s.cwd}`);
                  return meta.length > 0
                    ? `step ${chain.index + 2 + offset} ${agentLabel} (${meta.join(", ")})`
                    : `step ${chain.index + 2 + offset} ${agentLabel}`;
                }).join("; ")
              : "";
            log.error(`async_chain_interrupted: chain interrupted at step ${chain.index + 1} of ${chain.steps.length} (${job.agent}), remaining agents: ${remaining.join(", ")}${stepDetails ? `, remaining steps: ${stepDetails}` : ""}`);
            void sendSystemNote(
              pi,
              `🚨 Async chain interrupted at step ${chain.index + 1} of ${chain.steps.length} — the extension reloaded, so the chain cannot continue. Step ${chain.index + 1} (${job.agent}) may still be running; steps ${chain.index + 2}-${chain.steps.length} were never spawned. Remaining agents: ${remaining.join(", ")}.${stepDetails ? ` Remaining steps: ${stepDetails}.` : ""} Re-run them with subagent(chain: ...).`,
              { customType: "subagent-chain-error", triggerTurn: true, deliverAs: "followUp" },
            ).catch((e: any) => log.error(`chain_interrupted note failed: ${e?.message || e}`));
            // Durable so a second reload does not repeat the note.
            chain.interruptedAt = Date.now();
            try { fs.writeFileSync(path.join(job.workerDir, "chain.json"), JSON.stringify(chain), { mode: 0o600 }); } catch {}
          }
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
    asyncState.lastCtx = null;
    if (asyncState.poller) { clearInterval(asyncState.poller); asyncState.poller = null; }
    if (asyncState.watcher) { asyncState.watcher.close(); asyncState.watcher = null; }
    unsubscribeSyncRuns();
    clearSyncAgentRuns();
  });

  // /async-status — fullscreen overlay list → live output detail
  async function handleAsyncStatus(ctx: any): Promise<void> {
    if (!ctx.hasUI) return;
    log.debug("opening_async_status_overlay", { jobs: asyncState.jobs.size, syncRuns: syncAgentRunCount() });
    await openAsyncStatusOverlay(ctx, {
      listJobs: () => {
        // Async first, then sync; newest first inside each group.
        const newestFirst = (a: { startedAt: number }, b: { startedAt: number }) => b.startedAt - a.startedAt;
        const asyncJobs: AsyncStatusJobView[] = Array.from(asyncState.jobs.values())
          .sort(newestFirst)
          .map(j => ({
            id: j.id,
            agent: j.agent,
            name: j.name,
            task: j.task,
            status: j.status,
            workerDir: j.workerDir,
            startedAt: j.startedAt,
            durationMs: j.durationMs,
            model: j.model,
            mode: "async" as const,
          }));
        const syncJobs: AsyncStatusJobView[] = listSyncAgentRuns()
          .sort(newestFirst)
          .map(r => ({
            id: r.id,
            agent: r.agent,
            name: r.agent,
            task: r.task,
            status: "running",
            // No worker dir, no status.json: the run lives in this process only.
            workerDir: "",
            startedAt: r.startedAt,
            currentTool: r.currentTool,
            mode: "sync" as const,
          }));
        return [...asyncJobs, ...syncJobs];
      },
      killJob: (id) => killSyncAgent(id) ?? killAsyncAgent(id, "user"),
      formatDuration,
      readLiveStatus: (workerDir) => readAsyncStatus(workerDir),
    });
  }

  // /async-status command
  pi.registerCommand("async-status", {
    description: "Fullscreen overlay: list async agents, view live output, kill with x",
    handler: async (_args, ctx) => handleAsyncStatus(ctx),
  });

  /** Sync runs live in this process, so a kill is just the spawn's abort handle. Null when
   *  no sync run matches — the caller then falls through to the async jobs. */
  function killSyncAgent(target: string): { killed: string[]; errors: string[] } | null {
    const want = target.toLowerCase();
    const match = listSyncAgentRuns().find(
      (r) => r.id.toLowerCase() === want || r.agent.toLowerCase() === want,
    );
    if (!match) return null;
    log.info("sync_kill_requested", { target, id: match.id, agent: match.agent });
    return abortSyncAgentRun(match.id)
      ? { killed: [match.agent], errors: [] }
      : { killed: [], errors: [`Could not stop sync agent ${match.agent}.`] };
  }

  // Kill an async agent by name, id prefix, or "all"
  function killAsyncAgent(target: string, origin: AsyncKillOrigin = "user"): { killed: string[]; errors: string[] } {
    // Runtime guard: callers outside the type system still get a safe, non-false label.
    // Object.hasOwn, not a plain lookup — inherited keys such as `toString` would otherwise
    // pass the truthiness check and make the label a function instead of a string.
    const killOrigin: AsyncKillOrigin = Object.hasOwn(KILL_ORIGIN_LABELS, origin) ? origin : "user";
    const killLabel = KILL_ORIGIN_LABELS[killOrigin];
    log.info("async_kill_requested", { target, origin: killOrigin, label: killLabel });
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

    // The failed-pid set is per-target: declared outside the loop, a pid that survived one
    // target's failed signal was re-checked for every later target, and a later agent that
    // had been signalled successfully would skip its state and result updates and stay
    // marked running.
    for (const job of targets) {
      const status = readAsyncStatus(job.workerDir);
      const pidsToSignal: number[] = [];
      if (status?.pid) {
        try {
          const tree = execFileSync("pstree", ["-p", String(status.pid)], { encoding: "utf-8", timeout: 3000 });
          const matches = tree.match(/\((\d+)\)/g);
          pidsToSignal.push(...(matches ? [...new Set(matches.map((m: string) => parseInt(m.slice(1, -1), 10)))] : [status.pid]));
        } catch {
          pidsToSignal.push(status.pid);
          if (status.childPid) pidsToSignal.push(status.childPid);
        }
      }
      const stillAlive = signalAndReportSurvivors(
        [...new Set(pidsToSignal)],
        (pid) => { process.kill(pid, "SIGKILL"); },
        isProcessAlive,
      );
      const label = job.name || job.agent;
      // A swallowed signal failure used to be reported as a successful kill: the job was
      // marked failed and counted as killed while its process kept running. Only claim a
      // kill when nothing we signalled is still alive.
      if (stillAlive.length > 0) {
        errors.push(`Could not stop ${label} (pid ${stillAlive.join(", ")} still running).`);
        log.error("async_kill_signal_failed", { label, pids: stillAlive, target });
        continue;
      }
      killed.push(label);
      job.status = "failed";
      job.updatedAt = Date.now();
      job.durationMs = Date.now() - job.startedAt;
      // Resolve the agent's prior output BEFORE writing either destination.
      // Prefer the in-memory value, then what status.json already held, then the worker's
      // output.log — a job killed mid-run has neither of the first two, because `output`
      // only lands in status.json on the completion path and job.output stays undefined
      // until then. Reading output.log is what stops the AI receiving a kill label and
      // none of the work the agent had actually done.
      let persistedPriorOutput = "";
      try {
        const statusPath = path.join(job.workerDir, "status.json");
        if (fs.existsSync(statusPath)) {
          persistedPriorOutput = typeof JSON.parse(fs.readFileSync(statusPath, "utf-8"))?.output === "string"
            ? JSON.parse(fs.readFileSync(statusPath, "utf-8")).output
            : "";
        }
      } catch (e: any) {
        log.debug(`kill: could not read prior output for ${job.id}: ${e?.message}`);
      }
      const inMemoryOutput = typeof job.output === "string" ? job.output : "";
      const partialFromLog = inMemoryOutput || persistedPriorOutput ? "" : readPartialWorkerOutput(
        job,
        // Budget the label, the newline joining them, and the truncation marker itself —
// otherwise the composed string still overruns MAX_OUTPUT_CHARS and
// formatAsyncResultOutput head-trims it, which drops the newest lines.
        Math.max(0, MAX_OUTPUT_CHARS - killLabel.length - TRUNCATION_MARKER.length - 1),
      );
      if (partialFromLog) {
        log.debug("kill: recovered partial output from output.log", { jobId: job.id, chars: partialFromLog.length });
      }
      const priorOutput = inMemoryOutput || persistedPriorOutput || partialFromLog;
      const composedOutput = priorOutput ? `${killLabel}\n${priorOutput}` : killLabel;
      job.output = composedOutput;
      job.killOrigin = killOrigin;
      // A kill must never advance an async chain, not even when delivery is retried: the
      // delivered flag stays false after a failed send, so clear the continuation itself.
      job.onComplete = undefined;

      // Persist killed state to disk — prevents stale re-delivery on reload
      try {
        const statusPath = path.join(job.workerDir, "status.json");
        const existing = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf-8")) : {};
        existing.state = "failed";
        existing.exitCode = -9;
        existing.endedAt = Date.now();
        existing.killOrigin = killOrigin;
        // Same composed text as job.output, so the overlay and pidash read exactly what
        // the AI receives instead of losing the partial output.
        existing.output = composedOutput;
        fs.writeFileSync(statusPath, JSON.stringify(existing), { mode: 0o600 });
      } catch (e: any) { log.error(`kill: status.json update failed for ${job.id}: ${e?.message}`); }
      // Delete result file if it exists — prevent re-ingestion on reload
      try { fs.unlinkSync(path.join(ASYNC_RESULTS_DIR, `${job.id}.json`)); } catch {}
      // Record killed reviewer as having 0 findings — prevents permanent commit block
      let killSideEffectsOk = true;
      if (job.agent.startsWith("code-reviewer-")) {
        try { recordReviewerResult(jobCwd(job), job.agent, 0, { since: job.startedAt }); } catch (e: any) { killSideEffectsOk = false; log.error(`recordReviewerResult failed for ${job.agent}: ${e?.message}`); }
      }
      if (killSideEffectsOk) job.sideEffectsApplied = true;
      // Deliver this job's own result — grouped or not, a finished agent never waits for
      // its siblings. No completion hook: a kill must not advance an async chain.
      void deliverJobResult(job, { fireHook: false });
      // Delay cleanup — only for delivered jobs
      if (job.delivered) {
        setTimeout(() => { asyncState.jobs.delete(job.id); updateAsyncWidget(); }, 5000);
      }
    }

    updateAsyncWidget();
    return { killed, errors };
  }

  // Handle async-kill from pidash browser UI
  pi.events.on("pidash:async-kill", (target: unknown) => {
    if (typeof target === "string") {
      // A human clicking in the browser UI — still a user kill. A sync run is not an
      // async job, so it is resolved through the sync registry first.
      if (killSyncAgent(target)) return;
      killAsyncAgent(target, "user");
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
        safeEmit(`${channel}:reply:${params.requestId}`, reply);
      } catch (err: any) {
        safeEmit(`${channel}:reply:${params.requestId}`, {
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
      const ctx = getLiveAsyncCtx();
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
      const { killed, errors } = killAsyncAgent(agentId, "task-system");
      if (killed.length === 0) throw new Error(errors[0] || "Agent not found");
    },
  );

  // Emit subagents:ready so pitasks can discover us
  pi.on("session_start", () => {
    safeEmit("subagents:ready", {});
  });

  return {
    spawnAsyncAgent,
    killAsyncAgent,
    getAsyncJobs: () => Array.from(asyncState.jobs.values()).filter(j => j.status === "running" || j.status === "queued"),
  };
}
