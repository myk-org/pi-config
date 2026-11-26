import type { WorktreeItem } from "@/types";

const SAFE_PR_URL = /^https:\/\/[^\x00-\x1f\x7f\s]+$/;

/** Only allow https:// URLs without control characters or whitespace for external PR links. */
export function isSafePrUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && SAFE_PR_URL.test(url);
}

/** Normalize a cwd string for equality checks (strips trailing slashes). */
function normalizeCwd(cwd: string | undefined | null): string {
  if (typeof cwd !== "string") return "";
  const trimmed = cwd.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/**
 * Decide whether an incoming `worktrees-list` reply belongs to the active session, cwd,
 * and latest in-flight list request. Discards stale/out-of-order replies and foreign-cwd payloads.
 */
export function shouldAcceptWorktreesList(
  ev: { sourceSessionId?: string; cwd?: string; requestId?: string },
  currentSessionId: string,
  currentCwd: string,
  latestRequestId: string | null,
): boolean {
  if (ev.sourceSessionId && ev.sourceSessionId !== currentSessionId) {
    return false;
  }
  const evCwd = normalizeCwd(ev.cwd);
  const mineCwd = normalizeCwd(currentCwd);
  if (evCwd && mineCwd && evCwd !== mineCwd) {
    return false;
  }
  if (latestRequestId && ev.requestId && ev.requestId !== latestRequestId) {
    return false;
  }
  return true;
}

/** Compute operation timeout in ms — scales with target count for bulk guarded removes. */
export function computeOpTimeoutMs(op: "prune" | "remove", targetCount = 1): number {
  if (op === "remove") {
    return 30_000 + 15_000 * Math.max(1, targetCount);
  }
  return 30_000;
}

/** Drop selected paths that no longer exist or are no longer eligible for guarded removal. */
export function pruneSelectedWorktreePaths(
  selected: ReadonlySet<string>,
  worktrees: readonly WorktreeItem[],
): Set<string> {
  if (selected.size === 0) return new Set();
  const removable = new Set<string>();
  for (const wt of worktrees) {
    if (wt.canRemove) removable.add(wt.path);
  }
  const next = new Set<string>();
  for (const p of selected) {
    if (removable.has(p)) next.add(p);
  }
  return next;
}

/** Return worktrees eligible for guarded removal. */
export function getRemovableWorktrees(worktrees: readonly WorktreeItem[]): WorktreeItem[] {
  return worktrees.filter((wt) => wt.canRemove);
}

/** Copy text to the browser clipboard with a fallback for non-secure contexts. */
export async function copyTextInBrowser(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback
  }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
