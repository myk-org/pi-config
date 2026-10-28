/**
 * Rendering for `/async` and `/cron`.
 *
 * Pure: it takes the snapshot the daemon cached and returns the message content
 * plus the jobs worth offering a Stop button for, so the layout is testable
 * without a Discord client.
 */
import { createLogger } from "../shared/logger.ts";

const log = createLogger("pidash-discord-jobs");

export interface JobsView {
  content: string;
  /** Ids offered as Stop buttons (empty when there are too many to fit). */
  stoppable: string[];
}

/**
 * Job id for a button, by position.
 *
 * Session ids contain a colon (`123:/repo`), so embedding one in a customId and
 * splitting on ":" resolved the wrong session — Stop silently did nothing
 * (Qodo cb61e7ae). Buttons carry an index; the caller keeps the mapping.
 */
export function jobIdAt(stoppable: string[], index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= stoppable.length) return null;
  return stoppable[index] ?? null;
}

const MAX_LINES = 15;
const MAX_CONTENT = 1900;
const MAX_BUTTONS = 5;

/** Cron snapshots carry millisecond timestamps; show a UTC clock, not an epoch. */
export function formatNextRun(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return String(value);
  const iso = new Date(ms).toISOString().replace("T", " ");
  return `${iso.slice(0, 16)} UTC`;
}

function line(text: string): string {
  return text.length <= 100 ? text : `${text.slice(0, 99)}…`;
}

export function renderJobsView(kind: "async" | "cron", snapshot: any): JobsView {
  const items: any[] = (kind === "async" ? snapshot?.jobs : snapshot?.tasks) ?? [];
  const count = Number(snapshot?.count ?? items.length);
  if (!items.length) {
    const content = kind === "async" ? "No async agents running." : "No cron jobs scheduled.";
    log.debug("jobs view empty", { kind });
    return { content, stoppable: [] };
  }
  const lines = items.slice(0, MAX_LINES).map((item: any, index: number) => {
    if (kind === "async") {
      const name = item?.name || item?.agent || item?.id || "agent";
      const status = String(item?.status ?? "");
      const task = item?.task ? `\n   ${line(String(item.task))}` : "";
      return `${index + 1}. **${line(String(name))}**${status ? ` — ${line(status)}` : ""}${task}`;
    }
    const title = item?.description || item?.id || "job";
    const schedule = item?.schedule ? `\n   \`${line(String(item.schedule))}\`` : "";
    const nextLabel = formatNextRun(item?.nextRun);
    const next = nextLabel ? ` · next ${line(nextLabel)}` : "";
    return `${index + 1}. **${line(String(title))}**${schedule}${next}`;
  });
  const overflow = items.length > MAX_LINES ? `\n…and ${items.length - MAX_LINES} more` : "";
  const header = kind === "async" ? `**Async agents** (${count})` : `**Cron jobs** (${count})`;
  const content = [header, "", ...lines, overflow].filter(Boolean).join("\n").slice(0, MAX_CONTENT);
  const stoppable = items.length <= MAX_BUTTONS ? items.map((item: any) => String(item?.id ?? "")).filter(Boolean) : [];
  log.debug("jobs view rendered", { kind, count, items: items.length, buttons: stoppable.length });
  return { content, stoppable };
}
