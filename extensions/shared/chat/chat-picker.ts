/**
 * Generic picker paging for chat clients.
 *
 * Both `/model` (hundreds of models, grouped by provider) and long option lists
 * need the same thing: a bounded page of choices with the user's current group
 * first, and honest pagination. Kept pure so the ordering rule is testable
 * rather than buried in a discord.js builder.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("chat-picker");

export interface PickerEntry {
  /** Stable value sent back on selection. */
  id: string;
  /** Human label. */
  label: string;
  /** Grouping key — a provider name, a category, anything. */
  group?: string;
  /** Show a marker (e.g. the currently selected model). */
  current?: boolean;
}

export interface PickerPage {
  items: PickerEntry[];
  page: number;
  pages: number;
  total: number;
}

/** Discord select menus hold at most 25 options. */
export const PICKER_PAGE_SIZE = 25;

export function pickerPageCount(total: number, pageSize = PICKER_PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

export function clampPickerPage(page: number, total: number, pageSize = PICKER_PAGE_SIZE): number {
  const pages = pickerPageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), pages);
}

/**
 * Order entries for a picker.
 *
 * `preferGroup` wins: with 681 models on this machine, opening `/model` on the
 * provider you are already using is the useful default (user's choice), then
 * everything else stays grouped and alphabetical so nothing is unreachable.
 */
export function orderPickerEntries(entries: PickerEntry[], preferGroup?: string | null): PickerEntry[] {
  const withIndex = entries.map((entry, index) => ({ entry, index }));
  withIndex.sort((a, b) => {
    const aPreferred = preferGroup && a.entry.group === preferGroup ? 0 : 1;
    const bPreferred = preferGroup && b.entry.group === preferGroup ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    const groupCompare = (a.entry.group ?? "").localeCompare(b.entry.group ?? "");
    if (groupCompare !== 0) return groupCompare;
    return a.index - b.index; // stable within a group
  });
  log.debug("ordered picker entries", { total: entries.length, preferGroup: preferGroup ?? null });
  return withIndex.map((item) => item.entry);
}

export function buildPickerPage(
  entries: PickerEntry[],
  page: number,
  options: { pageSize?: number; preferGroup?: string | null } = {},
): PickerPage {
  const pageSize = options.pageSize ?? PICKER_PAGE_SIZE;
  const ordered = orderPickerEntries(entries, options.preferGroup);
  const pages = pickerPageCount(ordered.length, pageSize);
  const current = clampPickerPage(page, ordered.length, pageSize);
  const start = (current - 1) * pageSize;
  return { items: ordered.slice(start, start + pageSize), page: current, pages, total: ordered.length };
}

/** Label for one entry, marking the active choice and its group. */
export function pickerLabel(entry: PickerEntry, maxLength = 100): string {
  const group = entry.group ? ` (${entry.group})` : "";
  const marker = entry.current ? "✓ " : "";
  const text = `${marker}${entry.label}${group}`;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** `provider/model` ids are the canonical form; group is derived when absent. */
export function entriesFromModels(
  models: Array<{ id: string; name?: string; provider?: string }>,
  currentId?: string,
): PickerEntry[] {
  return models
    .filter((model) => typeof model?.id === "string" && model.id.length > 0)
    .map((model) => {
      const slash = model.id.lastIndexOf("/");
      const group = model.provider || (slash > 0 ? model.id.slice(0, slash) : undefined);
      return {
        id: model.id,
        label: model.name || model.id,
        group,
        current: currentId ? model.id === currentId : false,
      };
    });
}
