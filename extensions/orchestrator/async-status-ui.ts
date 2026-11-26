/**
 * /async fullscreen overlay — `[1] Roster` (list → live output detail + `r` revive)
 * and `[2] Activity` (unified cross-agent live activity log).
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseAsyncOutputLine } from "./async-status-parse.js";
import {
  openListDetailOverlay,
  OverlayScrollDetail,
  OVERLAY_OPTS,
  bulkResultMessage,
  matchesOverlayKey,
  type OverlayNotice,
  type OverlayNotify,
} from "./overlay-dashboard.js";
import {
  OverlayActivityView,
  collectAsyncActivityEvents,
  formatActivityEventPlain,
  formatActivityTabBar,
  sanitizeActivityText,
  type ActivityEvent,
  type ActivityFilter,
  type OverlayActivityResult,
  type OverlayActivityTab,
} from "./overlay-activity-log.js";
import { createLogger } from "../shared/logger.js";
import { KILL_ORIGIN_LABELS, type AsyncKillOrigin } from "./async-agents.js";

const log = createLogger("async-status");

export { parseAsyncOutputLine } from "./async-status-parse.js";

export interface AsyncStatusJobView {
  id: string;
  agent: string;
  name?: string;
  task: string;
  /** Full un-truncated task prompt when available (used by `r` revive). */
  fullTask?: string;
  status: string;
  /** Where this job's status.json lives. A sync run under `sync-runs/<id>` has one too. */
  workerDir?: string;
  startedAt: number;
  durationMs?: number;
  model?: string;
  cwd?: string;
  taskId?: string;
  persistSession?: boolean;
  output?: string;
  /** "sync" marks a child of this session; absent/"async" is a background job. */
  mode?: "sync" | "async";
  /** Tool a sync agent is executing right now, when known. */
  currentTool?: string;
}

export type ReviveJobResult =
  | { ok: true; id: string; message?: string }
  | { ok: false; error: string };

export interface AsyncStatusUiDeps {
  listJobs: () => AsyncStatusJobView[];
  killJob: (id: string) => { killed: string[]; errors: string[] } | void;
  /** Optional revive handler (`r`) for killed, completed, or failed jobs. */
  reviveJob?: (job: AsyncStatusJobView) => ReviveJobResult | Promise<ReviveJobResult>;
  formatDuration: (ms: number) => string;
  /** Optional live status.json reader for detail header. */
  readLiveStatus?: (workerDir: string) => { state?: string; killOrigin?: string } | null;
  /** Optional custom activity event collector for the `[2] Activity` tab (defaults to reading job output logs). */
  listActivityEvents?: (jobs: readonly AsyncStatusJobView[]) => ActivityEvent[];
  title?: string;
  emptyMessage?: string;
  footerHints?: string;
}

function jobTitle(job: AsyncStatusJobView): string {
  return job.name || job.agent;
}

/**
 * Attribution suffix for the detail header: " · killed by <origin>" when the
 * live status.json records who killed the job, otherwise nothing.
 *
 * Uses KILL_ORIGIN_LABELS rather than echoing the stored key, so the overlay reads
 * "killed by task system" like every other surface instead of "killed by task-system".
 * An unrecognised value is ignored rather than rendered, so a hand-edited
 * status.json cannot inject arbitrary text into the header.
 *
 * Extracted so it can be tested without driving the interactive overlay loop.
 */
export function formatKillOriginSuffix(
  killOrigin: string | undefined,
  theme: Pick<Theme, "fg">,
): string {
  if (!killOrigin) {
    log.debug("kill_origin_header: no origin recorded");
    return "";
  }
  const label = Object.hasOwn(KILL_ORIGIN_LABELS, killOrigin)
    ? KILL_ORIGIN_LABELS[killOrigin as AsyncKillOrigin]
    : null;
  if (!label) {
    log.warn("kill_origin_header: unrecognised origin ignored", { killOrigin });
    return "";
  }
  log.debug("kill_origin_header: rendering attribution", { killOrigin });
  return theme.fg("dim", ` · ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
}

function isActive(status: string): boolean {
  return status === "running" || status === "queued";
}

function statusGlyph(status: string, theme: Theme): string {
  switch (status) {
    case "running":
    case "queued":
      return theme.fg("warning", "■");
    case "complete":
      return "\x1b[32m■\x1b[0m";
    case "failed":
      return theme.fg("error", "■");
    default:
      return theme.fg("muted", "■");
  }
}

function statusWord(status: string, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "running");
    case "queued":
      return theme.fg("warning", "queued");
    case "complete":
      return "\x1b[32mdone\x1b[0m";
    case "failed":
      return theme.fg("error", "failed");
    default:
      return theme.fg("muted", status);
  }
}

function elapsedMs(job: AsyncStatusJobView): number {
  if (job.durationMs != null && !isActive(job.status)) return job.durationMs;
  return Math.max(0, Date.now() - job.startedAt);
}

/** Plain-text fallback summary for headless / non-UI `/async` invocations. */
export function formatAsyncStatusPlainText(
  jobs: readonly AsyncStatusJobView[],
  events: readonly ActivityEvent[] = [],
  formatDuration: (ms: number) => string = (ms) => `${ms}ms`,
  emptyMessage = "No async agents running or recently completed.",
): string {
  if (jobs.length === 0 && events.length === 0) return emptyMessage;
  const lines: string[] = [];
  if (jobs.length > 0) {
    const active = jobs.filter((j) => isActive(j.status)).length;
    lines.push(`Async agents: ${active} active / ${jobs.length} total`);
    for (const j of jobs) {
      const label = sanitizeActivityText(jobTitle(j), 40);
      const shortId = j.id.length > 8 ? j.id.slice(-8) : j.id;
      const modeTag = j.mode === "sync" ? " [sync]" : "";
      const toolTag = j.currentTool ? ` · ${sanitizeActivityText(j.currentTool, 24)}` : "";
      const taskPreview = sanitizeActivityText(j.task, 60);
      lines.push(`- ${label} (${shortId})${modeTag} · ${j.status} · ${formatDuration(elapsedMs(j))}${toolTag} — ${taskPreview}`);
    }
  }
  if (events.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Recent activity:");
    for (const ev of events.slice(-10)) {
      lines.push(`  ${formatActivityEventPlain(ev)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Kill every running/queued job. No confirmation prompt: `X` is a deliberate,
 * capitalised key, and gating it on `ctx.ui.confirm` left the overlay hanging on
 * hosts where that dialog does not resolve — the key simply appeared dead.
 */
export function killAllJobs(
  ctx: ExtensionCommandContext,
  deps: AsyncStatusUiDeps,
  notify?: OverlayNotify,
): void {
  const emit: OverlayNotify = notify ?? ((msg, level) => { ctx.ui?.notify?.(msg, level); });
  const targets = deps.listJobs().filter((j) => isActive(j.status));
  if (targets.length === 0) {
    log.debug("kill_all: nothing active");
    emit("No running async agents to kill.", "info");
    return;
  }
  const { killed, failed } = killTargets(deps, targets);
  if (failed.length === 0) {
    log.info("kill_all: killed", { count: killed });
    emit(
      `Killed ${killed} async agent${killed === 1 ? "" : "s"}.`,
      "info",
    );
    return;
  }
  log.error("kill_all: partially failed", { killed, failed: failed.length });
  emit(
    `Killed ${killed} of ${targets.length} async agents — ${failed.length} failed. See logs.`,
    "warning",
  );
}

/**
 * Each kill is attempted independently: a failure on one job must not leave the remaining agents
 * running after the user asked for all of them to die. A callback that returns errors (rather than
 * throwing) counts as a failure too — signalling can fail while the worker is still alive, and
 * reporting that as "killed" would be a lie. Returns the failed labels, never a silent count.
 */
function killTargets(
  deps: AsyncStatusUiDeps,
  targets: readonly AsyncStatusJobView[],
): { killed: number; failed: string[] } {
  const failed: string[] = [];
  let killed = 0;
  for (const job of targets) {
    try {
      const result = deps.killJob(job.id);
      if (result?.errors?.length) {
        // One entry per failed job: the count in the notify is jobs, not error strings.
        failed.push(`${job.id}: ${result.errors.join("; ")}`);
        log.error("kill_all: job kill reported errors", { job: job.id, errors: result.errors });
        continue;
      }
      killed++;
    } catch (e: any) {
      const message = e?.message || String(e);
      failed.push(`${job.id}: ${message}`);
      log.error("kill_all: job kill failed", { job: job.id, error: message });
    }
  }
  return { killed, failed };
}

function isThenable<T>(value: unknown): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as Promise<T>).then === "function";
}

function reportSingleRevive(
  job: AsyncStatusJobView,
  result: ReviveJobResult,
  notify: OverlayNotify,
): void {
  const label = sanitizeActivityText(jobTitle(job), 40);
  if (result.ok) {
    const shortId = result.id.length > 8 ? result.id.slice(-8) : result.id;
    const msg = result.message || `Revived ${label} (${shortId}).`;
    log.info("overlay_revive_ok", { from: job.id, to: result.id, agent: job.agent });
    notify(msg, "info");
  } else {
    const msg = `Could not revive ${label}: ${result.error}`;
    log.error("overlay_revive_failed", { from: job.id, agent: job.agent, error: result.error });
    notify(msg, "error");
  }
}

function triggerSingleRevive(
  job: AsyncStatusJobView,
  reviveJob: NonNullable<AsyncStatusUiDeps["reviveJob"]>,
  notify: OverlayNotify,
): void {
  if (isActive(job.status)) {
    const label = sanitizeActivityText(jobTitle(job), 40);
    log.debug("overlay_revive_skipped_active", { id: job.id, status: job.status });
    notify(`Cannot revive active agent "${label}" — kill it first.`, "warning");
    return;
  }
  try {
    const outcome = reviveJob(job);
    if (isThenable<ReviveJobResult>(outcome)) {
      outcome
        .then((resolved) => reportSingleRevive(job, resolved, notify))
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          reportSingleRevive(job, { ok: false, error }, notify);
        });
    } else {
      reportSingleRevive(job, outcome, notify);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    reportSingleRevive(job, { ok: false, error }, notify);
  }
}

function triggerBulkRevive(
  selected: readonly AsyncStatusJobView[],
  reviveJob: NonNullable<AsyncStatusUiDeps["reviveJob"]>,
  notify: OverlayNotify,
): void {
  const eligible = selected.filter((j) => !isActive(j.status));
  if (eligible.length === 0) {
    log.debug("overlay_revive_selection_none_eligible", { selected: selected.length });
    notify("No completed or failed jobs in selection to revive.", "warning");
    return;
  }

  const syncFailed: string[] = [];
  const asyncResults: Array<Promise<{ id: string; result: ReviveJobResult }>> = [];
  let hasAsync = false;

  for (const job of eligible) {
    try {
      const outcome = reviveJob(job);
      if (isThenable<ReviveJobResult>(outcome)) {
        hasAsync = true;
        asyncResults.push(
          outcome
            .then((result) => ({ id: job.id, result }))
            .catch((err: unknown) => ({
              id: job.id,
              result: { ok: false as const, error: err instanceof Error ? err.message : String(err) },
            })),
        );
      } else {
        asyncResults.push(Promise.resolve({ id: job.id, result: outcome }));
        if (!outcome.ok) syncFailed.push(`${job.id}: ${outcome.error}`);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      asyncResults.push(Promise.resolve({ id: job.id, result: { ok: false as const, error } }));
      syncFailed.push(`${job.id}: ${error}`);
    }
  }

  const emitSummary = (failed: string[]) => {
    log.info("overlay_revive_selection_done", { attempted: eligible.length, failed: failed.length });
    notify(
      bulkResultMessage("revived", "async agent", eligible.length, failed),
      failed.length === 0 ? "info" : "warning",
    );
  };

  if (!hasAsync) {
    emitSummary(syncFailed);
    return;
  }
  void Promise.all(asyncResults).then((settled) => {
    const failed = settled
      .filter((entry) => !entry.result.ok)
      .map((entry) => `${entry.id}: ${(entry.result as { ok: false; error: string }).error}`);
    emitSummary(failed);
  });
}

/**
 * Incrementally read appended JSONL lines from `logPath` using byte offsets
 * and `StringDecoder("utf8")` so 500ms polling is O(delta_bytes) instead of O(file_size).
 */
export function createIncrementalLogReader(logPath: string): {
  readNewContent: () => boolean;
  getLines: () => string[];
} {
  let lines: string[] = [];
  let bytePos = 0;
  let textBuffer = "";
  let decoder = new StringDecoder("utf8");
  let lastLoggedError = "";

  const readNewContent = (): boolean => {
    try {
      const size = fs.statSync(logPath).size;
      if (size === bytePos) return false;
      let reset = false;
      if (size < bytePos) {
        bytePos = 0;
        textBuffer = "";
        decoder = new StringDecoder("utf8");
        if (lines.length > 0) {
          // Swap in a fresh array reference so OverlayScrollDetail drops its wrap cache.
          lines = [];
          reset = true;
        }
      }
      const bytesToRead = size - bytePos;
      if (bytesToRead <= 0) return reset;

      const buf = Buffer.allocUnsafe(bytesToRead);
      const fd = fs.openSync(logPath, "r");
      let totalRead = 0;
      try {
        while (totalRead < bytesToRead) {
          const n = fs.readSync(fd, buf, totalRead, bytesToRead - totalRead, bytePos + totalRead);
          if (n <= 0) break;
          totalRead += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      if (totalRead === 0) return reset;
      bytePos += totalRead;

      textBuffer += decoder.write(buf.subarray(0, totalRead));
      const parts = textBuffer.split("\n");
      textBuffer = parts.pop() || "";
      let changed = false;
      for (const part of parts) {
        if (!part.trim()) continue;
        const parsed = parseAsyncOutputLine(part);
        if (parsed === null) continue;
        for (const l of parsed.split("\n")) lines.push(l);
        changed = true;
      }
      return changed || reset;
    } catch (e: any) {
      if (e?.code === "ENOENT") return false;
      const msg = e?.message || String(e);
      if (msg !== lastLoggedError) {
        lastLoggedError = msg;
        log.debug("live output read failed", { error: msg });
      }
      return false;
    }
  };

  return { readNewContent, getLines: () => lines };
}

function createJobDetailComponent(
  job: AsyncStatusJobView,
  tui: TUI,
  theme: Theme,
  done: (value: null) => void,
  deps: AsyncStatusUiDeps,
  ctx: ExtensionCommandContext,
): Component {
  // No worker dir means no output.log — path.join("", ...) would read the cwd.
  const reader = job.workerDir
    ? createIncrementalLogReader(path.join(job.workerDir, "output.log"))
    : { readNewContent: () => false, getLines: () => [] as string[] };

  const jobId = job.id;
  const detailNotify: OverlayNotify = (msg, level = "info") => {
    try { ctx.ui?.notify?.(msg, level); } catch {}
  };

  return new OverlayScrollDetail(
    tui,
    theme,
    {
      followTail: true,
      emptyBody: "(no output yet)",
      footerHints: deps.reviveJob
        ? "↑↓/jk scroll · PgUp/PgDn · Home/End · r revive · x kill · Esc back"
        : "↑↓/jk scroll · PgUp/PgDn · Home/End · x kill · Esc back",
      pollMs: 500,
      onPoll: reader.readNewContent,
      onX: () => {
        const current = deps.listJobs().find((j) => j.id === jobId);
        if (current && isActive(current.status)) {
          deps.killJob(jobId);
          return true;
        }
        return false;
      },
      onKey: deps.reviveJob
        ? (key) => {
            if (!matchesOverlayKey(key, "r")) return false;
            const current = deps.listJobs().find((j) => j.id === jobId) || job;
            triggerSingleRevive(current, deps.reviveJob!, detailNotify);
            return "redraw";
          }
        : undefined,
      getHeader: (t) => {
        const live = job.workerDir ? deps.readLiveStatus?.(job.workerDir) : undefined;
        const current = deps.listJobs().find((j) => j.id === jobId) || job;
        const state = live?.state || current.status;
        const dur = deps.formatDuration(elapsedMs(current));
        // Show who killed a failed job rather than guessing "user".
        const origin = formatKillOriginSuffix(live?.killOrigin, t);
        return (
          `${statusGlyph(state, t)} ` +
          t.fg(
            "accent",
            t.bold(`${jobTitle(current)} · ${current.id.slice(-8)}`),
          ) +
          t.fg("muted", ` · ${state} · ${dur}`) +
          origin +
          t.fg("dim", ` · ${current.task.slice(0, 40)}`)
        );
      },
      getBodyLines: () => reader.getLines(),
    },
    done,
  );
}

/**
 * Open fullscreen async-status picker with `[1] Roster` and `[2] Activity` tabs.
 * Falls back safely to plain text when `ctx.hasUI` is false.
 */
export async function openAsyncStatusOverlay(
  ctx: ExtensionCommandContext,
  deps: AsyncStatusUiDeps,
): Promise<void> {
  const getEvents = (): ActivityEvent[] => {
    const jobs = deps.listJobs();
    return deps.listActivityEvents
      ? deps.listActivityEvents(jobs)
      : collectAsyncActivityEvents(jobs);
  };

  if (!ctx.hasUI) {
    const jobs = deps.listJobs();
    const events = getEvents();
    const text = formatAsyncStatusPlainText(
      jobs,
      events,
      deps.formatDuration,
      deps.emptyMessage ?? "No async agents running or recently completed.",
    );
    log.debug("async_overlay_plain_fallback", { jobs: jobs.length, events: events.length });
    try { ctx.ui?.notify?.(text, "info"); } catch {}
    return;
  }

  let activeTab: OverlayActivityTab = "roster";
  let activityFilter: ActivityFilter = "all";
  let activitySearch = "";
  let activityFollowing = true;
  let reselectJobId: string | undefined;
  let selectedIds: string[] = [];
  let pendingNotice: OverlayNotice | undefined;

  const defaultFooterHints = deps.reviveJob
    ? "↑↓/jk navigate · Space select · r revive · x kill · X kill all · 1/2 view · Esc close"
    : "↑↓/jk navigate · Space select · x kill selection · X kill all · 1/2 view · Esc close";

  for (;;) {
    if (activeTab === "roster") {
      let switchToActivity = false;
      const initialNotice = pendingNotice;
      pendingNotice = undefined;

      await openListDetailOverlay(ctx, {
        emptyMessage:
          deps.emptyMessage ?? "No async agents running or recently completed.",
        initialSelectionId: reselectJobId,
        initialSelectionIds: selectedIds,
        initialNotice,
        listSpec: {
          title: deps.title ?? "Async agents",
          headerSuffix: (theme) => formatActivityTabBar("roster", theme),
          countLabel: (jobs) => `${jobs.length} job${jobs.length === 1 ? "" : "s"}`,
          borderTitle: (jobs) => {
            const active = jobs.filter((j) => isActive(j.status)).length;
            return `jobs · ${active} active / ${jobs.length}`;
          },
          footerHints: deps.footerHints ?? defaultFooterHints,
          listItems: () => deps.listJobs(),
          rowParts: (job, theme) => {
            const shortId = job.id.length > 8 ? job.id.slice(-8) : job.id;
            const taskPreview =
              job.task.length > 40 ? `${job.task.slice(0, 40)}…` : job.task;
            return {
              glyph: statusGlyph(job.status, theme),
              title: jobTitle(job),
              idLabel: theme.fg("dim", shortId),
              rightParts: [
                // A sync row is not an async job: say so, because it is not restored by the
                // async poller and its result arrives in the orchestrator's turn instead.
                ...(job.mode === "sync" ? [theme.fg("dim", "sync")] : []),
                theme.fg("muted", job.agent),
                ...(job.model ? [theme.fg("dim", job.model)] : []),
                ...(job.currentTool ? [theme.fg("dim", job.currentTool)] : []),
                theme.fg("dim", taskPreview),
                theme.fg("muted", deps.formatDuration(elapsedMs(job))),
                statusWord(job.status, theme),
              ],
            };
          },
          onKey: (key, job, selected, notify) => {
            if (matchesOverlayKey(key, "2")) {
              if (job) reselectJobId = job.id;
              switchToActivity = true;
              log.debug("async_overlay_tab_switch", { to: "activity" });
              return "close";
            }
            if (matchesOverlayKey(key, "1")) {
              return "redraw";
            }
            if (matchesOverlayKey(key, "r") && deps.reviveJob) {
              if (selected.length > 0) {
                triggerBulkRevive(selected, deps.reviveJob, notify);
                return "redraw-clear";
              }
              if (!job) {
                notify("No job focused to revive.", "info");
                return "redraw";
              }
              triggerSingleRevive(job, deps.reviveJob, notify);
              return "redraw";
            }
            return false;
          },
          onSelectionChange: (ids) => {
            selectedIds = [...ids];
          },
          onX: (job) => {
            if (isActive(job.status)) deps.killJob(job.id);
          },
          selectable: true,
          onXSelected: (jobs, notify) => {
            const targets = jobs.filter((j) => isActive(j.status));
            if (targets.length === 0) {
              log.debug("kill_selection: nothing active", { selected: jobs.length });
              notify("No active jobs in selection.", "info");
              return;
            }
            const { killed, failed } = killTargets(deps, targets);
            log.debug("kill_selection", { selected: jobs.length, killed, failed: failed.length });
            // Same honesty as `X`: a selection kill that hid a still-running agent would look like a
            // clean sweep of the rows the user picked.
            if (killed === 0 && failed.length === 0) return;
            log.info("kill_selection: done", { killed, failed: failed.length });
            notify(
              bulkResultMessage("killed", "async agent", targets.length, failed),
              failed.length === 0 ? "info" : "warning",
            );
          },
          onKillAll: (notify) => {
            void killAllJobs(ctx, deps, notify);
          },
        },
        createDetail: (job, tui, theme, done) =>
          createJobDetailComponent(job, tui, theme, done, deps, ctx),
      });

      if (switchToActivity) {
        activeTab = "activity";
        continue;
      }
      return;
    }

    // `[2] Activity` tab
    const initialNotice = pendingNotice;
    pendingNotice = undefined;

    const activityResult = await ctx.ui.custom<OverlayActivityResult>(
      (tui, theme, keybindings, done) => {
        const view = new OverlayActivityView(
          tui,
          theme,
          keybindings,
          {
            title: deps.title ?? "Async agents",
            listEvents: getEvents,
            initialFilter: activityFilter,
            initialSearch: activitySearch,
            initialFollowing: activityFollowing,
            onFilterChange: (f) => { activityFilter = f; },
            onSearchChange: (s) => { activitySearch = s; },
            onFollowChange: (f) => { activityFollowing = f; },
            emptyMessage: "No async agent activity recorded yet.",
            pollMs: 1000,
          },
          done,
          (msg, level = "info") => {
            try { ctx.ui?.notify?.(msg, level); } catch {}
          },
        );
        if (initialNotice) {
          view.setNotice(initialNotice.message, initialNotice.level);
        }
        return view;
      },
      OVERLAY_OPTS,
    );

    if (!activityResult || activityResult.type === "close") return;

    if (activityResult.type === "switch-tab") {
      activeTab = activityResult.tab;
      continue;
    }

    if (activityResult.type === "inspect") {
      const target = deps.listJobs().find((j) => j.id === activityResult.event.sourceId);
      if (!target) {
        pendingNotice = {
          message: `Job "${activityResult.event.sourceLabel}" is no longer in the list.`,
          level: "warning",
        };
        continue;
      }
      await ctx.ui.custom<null>(
        (tui, theme, _kb, done) => createJobDetailComponent(target, tui, theme, done, deps, ctx),
        OVERLAY_OPTS,
      );
      continue;
    }
  }
}
