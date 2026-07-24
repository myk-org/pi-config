/**
 * /async-status fullscreen overlay — list dashboard → live output detail.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAsyncOutputLine } from "./async-status-parse.js";
import {
  openListDetailOverlay,
  OverlayScrollDetail,
} from "./overlay-dashboard.js";

export { parseAsyncOutputLine } from "./async-status-parse.js";

export interface AsyncStatusJobView {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: string;
  workerDir: string;
  startedAt: number;
  durationMs?: number;
  model?: string;
}

export interface AsyncStatusUiDeps {
  listJobs: () => AsyncStatusJobView[];
  killJob: (id: string) => void;
  formatDuration: (ms: number) => string;
  /** Optional live status.json reader for detail header. */
  readLiveStatus?: (workerDir: string) => { state?: string } | null;
  title?: string;
  emptyMessage?: string;
  footerHints?: string;
}

function jobTitle(job: AsyncStatusJobView): string {
  return job.name || job.agent;
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
  return Date.now() - job.startedAt;
}

/**
 * Open fullscreen async-status picker. Loops list → detail until user closes list.
 */
export async function openAsyncStatusOverlay(
  ctx: ExtensionCommandContext,
  deps: AsyncStatusUiDeps,
): Promise<void> {
  await openListDetailOverlay(ctx, {
    emptyMessage:
      deps.emptyMessage ?? "No async agents running or recently completed.",
    listSpec: {
      title: deps.title ?? "Async agents",
      countLabel: (jobs) => `${jobs.length} job${jobs.length === 1 ? "" : "s"}`,
      borderTitle: (jobs) => {
        const active = jobs.filter((j) => isActive(j.status)).length;
        return `jobs · ${active} active / ${jobs.length}`;
      },
      footerHints:
        deps.footerHints ?? "↑↓/jk select · Enter view · x kill · Esc close",
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
            theme.fg("muted", job.agent),
            ...(job.model ? [theme.fg("dim", job.model)] : []),
            theme.fg("dim", taskPreview),
            theme.fg("muted", deps.formatDuration(elapsedMs(job))),
            statusWord(job.status, theme),
          ],
        };
      },
      onX: (job) => {
        if (isActive(job.status)) deps.killJob(job.id);
      },
    },
    createDetail: (job, tui, theme, done) => {
      const lines: string[] = [];
      let filePos = 0;
      let textBuffer = "";
      let lastLoggedError = "";

      const readNewContent = (): boolean => {
        try {
          const content = fs.readFileSync(
            path.join(job.workerDir, "output.log"),
            "utf-8",
          );
          if (content.length <= filePos) return false;
          const newContent = content.slice(filePos);
          filePos = content.length;
          textBuffer += newContent;

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
          return changed;
        } catch (e: any) {
          if (e?.code === "ENOENT") return false;
          const msg = e?.message || String(e);
          if (msg !== lastLoggedError) {
            lastLoggedError = msg;
            console.debug("[async-status-ui] live output read failed:", msg);
          }
          return false;
        }
      };

      const jobId = job.id;
      return new OverlayScrollDetail(
        tui,
        theme,
        {
          followTail: true,
          emptyBody: "(no output yet)",
          footerHints:
            "↑↓/jk scroll · PgUp/PgDn · Home/End · x kill · Esc back",
          pollMs: 500,
          onPoll: readNewContent,
          onX: () => {
            const current = deps.listJobs().find((j) => j.id === jobId);
            if (current && isActive(current.status)) {
              deps.killJob(jobId);
              return true;
            }
            return false;
          },
          getHeader: (t) => {
            const live = deps.readLiveStatus?.(job.workerDir);
            const current = deps.listJobs().find((j) => j.id === jobId) || job;
            const state = live?.state || current.status;
            const dur = deps.formatDuration(elapsedMs(current));
            return (
              `${statusGlyph(state, t)} ` +
              t.fg(
                "accent",
                t.bold(`${jobTitle(current)} · ${current.id.slice(-8)}`),
              ) +
              t.fg("muted", ` · ${state} · ${dur}`) +
              t.fg("dim", ` · ${current.task.slice(0, 40)}`)
            );
          },
          getBodyLines: () => lines,
        },
        done,
      );
    },
  });
}
