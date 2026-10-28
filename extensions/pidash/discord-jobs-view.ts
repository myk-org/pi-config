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

const MAX_LINES = 15;
const MAX_CONTENT = 1900;
const MAX_BUTTONS = 5;

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
    const next = item?.nextRun ? ` · next ${line(String(item.nextRun))}` : "";
    return `${index + 1}. **${line(String(title))}**${schedule}${next}`;
  });
  const overflow = items.length > MAX_LINES ? `\n…and ${items.length - MAX_LINES} more` : "";
  const header = kind === "async" ? `**Async agents** (${count})` : `**Cron jobs** (${count})`;
  const content = [header, "", ...lines, overflow].filter(Boolean).join("\n").slice(0, MAX_CONTENT);
  const stoppable = items.length <= MAX_BUTTONS ? items.map((item: any) => String(item?.id ?? "")).filter(Boolean) : [];
  log.debug("jobs view rendered", { kind, count, items: items.length, buttons: stoppable.length });
  return { content, stoppable };
}
