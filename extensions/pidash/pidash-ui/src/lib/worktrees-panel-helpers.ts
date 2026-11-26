import type { WorktreeItem } from "@/types";

const SAFE_PR_URL = /^https:\/\/[^\x00-\x1f\x7f\s]+$/;

/** Only allow https:// URLs without control characters or whitespace for external PR links. */
export function isSafePrUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && SAFE_PR_URL.test(url);
}

export type WorktreeBroadcastAction = "apply" | "refetch" | "ignore";

/**
 * Decide how a browser watching `currentSessionId` (in `currentRepoRoot`) should handle
 * an incoming `worktrees-list` message:
 * - Direct replies for this session -> `"apply"`.
 * - Broadcasts from the SAME session -> `"apply"` immediately (all tabs watching the same session stay in sync).
 * - Broadcasts from ANOTHER session in the SAME repo -> `"refetch"` so this session computes its own
 *   `isCurrent`, `relativePath`, and `canRemove` guard accurately.
 * - Broadcasts from a different repo (or before own repo identity is known) -> `"ignore"`.
 */
export function reconcileWorktreeBroadcast(
  ev: { broadcast?: boolean; sourceSessionId?: string; repoRoot?: string },
  currentSessionId: string,
  currentRepoRoot: string | null,
): WorktreeBroadcastAction {
  if (ev.broadcast) {
    if (ev.sourceSessionId && ev.sourceSessionId === currentSessionId) {
      return "apply";
    }
    if (ev.repoRoot && currentRepoRoot && ev.repoRoot === currentRepoRoot) {
      return "refetch";
    }
    return "ignore";
  }
  if (ev.sourceSessionId && ev.sourceSessionId !== currentSessionId) {
    return "ignore";
  }
  return "apply";
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
