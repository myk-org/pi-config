/**
 * /worktree command — interactive zero-arg worktree TUI overlay.
 * Built on openListDetailOverlay / OverlayScrollDetail.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isBrowserDispatch, isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";
import {
  countLinkedWorktrees,
  invalidateWorktreeCache,
  listWorktreesCheckedAsync,
  runGitAsync,
  type GitAsyncRunner,
  type OpenPr,
} from "./git-helpers.js";
import {
  OVERLAY_OPTS,
  OverlayScrollDetail,
  bulkResultMessage,
  matchesOverlayKey,
  openListDetailOverlay,
  type OverlayRowParts,
} from "./overlay-dashboard.js";
import {
  attachPeersToWorktrees,
  canRemoveWorktree,
  copyTextToClipboard,
  displayWorktreePath,
  fetchOpenPrsByBranchAsync,
  formatDirtyText,
  formatPruneResult,
  formatWorktreeLabel,
  formatWorktreeTable,
  formatWorktreeTags,
  inspectLiveComsPeers,
  type PeerInspectionResult,
  type WorktreePeerInfo,
  type WorktreeView,
} from "./worktree-helpers.js";

const log = createLogger("worktree");

const MAX_STATUS_LINES = 60;

export interface WorktreeDeps {
  runGitAsync?: GitAsyncRunner;
  readLivePeers?: (cwd: string) => WorktreePeerInfo[];
  inspectLivePeers?: (cwd: string, opts?: { strict?: boolean }) => PeerInspectionResult;
  fetchOpenPrs?: (cwd: string, opts?: { forceRefresh?: boolean }) => Promise<Map<string, OpenPr>>;
  copyToClipboard?: (text: string) => Promise<{ ok: boolean; method?: string; error?: string }>;
  openOverlay?: typeof openListDetailOverlay;
  onWorktreesChanged?: () => void;
}

function safeNotify(
  ctx: ExtensionCommandContext,
  msg: string,
  level: "info" | "warning" | "error",
): void {
  if (!isLiveExtensionCtx(ctx)) return;
  try {
    ctx.ui.notify(msg, level);
  } catch (e: any) {
    log.debug("worktree_notify_failed", { error: e?.message || String(e) });
  }
}

function emitOutput(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx?.hasUI) {
    safeNotify(ctx, text, level);
    return;
  }
  try {
    pi.sendMessage({ customType: "worktree", content: text, display: true }, { triggerTurn: false });
  } catch {
    try { ctx?.ui?.notify?.(text, level); } catch {}
  }
}

export interface CheckedWorktreeViewsResult {
  ok: boolean;
  views: WorktreeView[];
  error?: string;
}

/**
 * Load worktrees with dirty counts, matched live COMS peers, and open GitHub PRs,
 * preserving git listing errors (`ok: false`) distinctly from non-git directories (`ok: true, views: []`).
 */
export async function loadWorktreeViewsChecked(
  cwd: string,
  deps: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers" | "fetchOpenPrs"> = {},
  forceRefresh = true,
  opts: { includePrs?: boolean; forceRefreshPrs?: boolean; strictPeers?: boolean } = {},
): Promise<CheckedWorktreeViewsResult> {
  const includePrs = opts.includePrs ?? true;
  const prFetcher =
    deps.fetchOpenPrs ??
    ((dir, o) => fetchOpenPrsByBranchAsync(dir, { forceRefresh: o?.forceRefresh }));

  const [listed, prsByBranch] = await Promise.all([
    listWorktreesCheckedAsync(cwd, {
      includeDirty: true,
      forceRefresh,
      runGitAsync: deps.runGitAsync,
    }),
    includePrs
      ? prFetcher(cwd, { forceRefresh: opts.forceRefreshPrs }).catch((e: any) => {
          log.debug("open_prs_load_failed", { cwd, error: e?.message || String(e) });
          return new Map<string, OpenPr>();
        })
      : Promise.resolve(new Map<string, OpenPr>()),
  ]);
  if (!listed.ok) {
    return { ok: false, views: [], error: listed.error };
  }
  const peerInspection: PeerInspectionResult = deps.inspectLivePeers
    ? deps.inspectLivePeers(cwd, { strict: opts.strictPeers })
    : deps.readLivePeers
      ? { peers: deps.readLivePeers(cwd), verified: true }
      : inspectLiveComsPeers(cwd, { strict: opts.strictPeers });
  const unverifiedReason = peerInspection.verified
    ? undefined
    : (peerInspection.error || "COMS registry unreadable");
  return {
    ok: true,
    views: attachPeersToWorktrees(listed.entries, peerInspection.peers, prsByBranch, unverifiedReason),
  };
}

/** Load worktrees with dirty counts, matched live COMS peers, and open GitHub PRs. */
export async function loadWorktreeViews(
  cwd: string,
  deps: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers" | "fetchOpenPrs"> = {},
  forceRefresh = true,
  opts: { includePrs?: boolean; forceRefreshPrs?: boolean; strictPeers?: boolean } = {},
): Promise<WorktreeView[]> {
  const res = await loadWorktreeViewsChecked(cwd, deps, forceRefresh, opts);
  return res.views;
}

export interface WorktreeDetailInfo {
  headSubject: string;
  statusLines: string[];
  statusOk?: boolean;
  statusError?: string;
}

/** Load HEAD commit subject and `git status --short` lines for the detail view. */
export async function loadWorktreeDetail(
  wt: WorktreeView,
  runner: GitAsyncRunner = runGitAsync,
): Promise<WorktreeDetailInfo> {
  if (wt.prunable || wt.bare) {
    return { headSubject: "", statusLines: [], statusOk: true };
  }
  const [logRes, statusRes] = await Promise.all([
    runner(["log", "-1", "--format=%s"], wt.path),
    runner(["status", "--short"], wt.path),
  ]);
  const headSubject = logRes.code === 0 ? logRes.stdout.trim() : "";
  if (statusRes.code !== 0) {
    const statusError = (statusRes.stderr || statusRes.stdout || "git status failed").trim();
    log.debug("worktree_detail_status_failed", { path: wt.path, code: statusRes.code, error: statusError });
    return { headSubject, statusLines: [], statusOk: false, statusError };
  }
  const statusLines = statusRes.stdout
    ? statusRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
    : [];
  return { headSubject, statusLines, statusOk: true };
}

/** Build themed row parts for `openListDetailOverlay`. */
export function buildWorktreeRowParts(
  wt: WorktreeView,
  cwd: string,
  theme: Theme,
): OverlayRowParts {
  const isDirty = (wt.dirty?.total ?? 0) > 0;
  const glyph = wt.prunable
    ? theme.fg("error", "◌")
    : wt.bare
      ? theme.fg("dim", "○")
      : isDirty
        ? theme.fg("warning", "●")
        : theme.fg("success", "●");

  const title = formatWorktreeLabel(wt);
  const tagTokens = formatWorktreeTags(wt).map((tag) => {
    if (tag === "[current]") return theme.fg("accent", tag);
    if (tag === "[locked]") return theme.fg("warning", tag);
    if (tag === "[prunable]") return theme.fg("error", tag);
    return theme.fg("dim", tag);
  });
  const idLabel = tagTokens.join(" ");

  const dirtyText = formatDirtyText(wt);
  const dirtyPart =
    dirtyText === "clean"
      ? theme.fg("success", "clean")
      : dirtyText === "prunable"
        ? theme.fg("error", "prunable")
        : dirtyText === "bare" || dirtyText === "unknown"
          ? theme.fg("dim", dirtyText)
          : theme.fg("warning", dirtyText);

  const rightParts: string[] = [];
  if (wt.pr) {
    rightParts.push(theme.fg("accent", hyperlink(`#${wt.pr.number}`, wt.pr.url)));
  }
  rightParts.push(dirtyPart);
  if (wt.peers.length > 0) {
    const peerLabel =
      wt.peers.length === 1
        ? `📡 ${wt.peers[0].name}`
        : `📡 ${wt.peers[0].name} +${wt.peers.length - 1}`;
    rightParts.push(theme.fg("accent", peerLabel));
  }
  rightParts.push(theme.fg("dim", displayWorktreePath(wt.path, cwd)));

  return { glyph, title, idLabel, rightParts };
}

/** Build detail body lines for a single worktree. */
export function buildWorktreeDetailLines(
  wt: WorktreeView,
  detail: WorktreeDetailInfo,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  const kv = (label: string, value: string) =>
    `${theme.fg("muted", label.padEnd(11))} ${value}`;

  lines.push(kv("Path", wt.path));
  lines.push(kv("Branch", formatWorktreeLabel(wt)));
  if (wt.pr) {
    const prNum = theme.fg("accent", hyperlink(`#${wt.pr.number}`, wt.pr.url));
    const prUrl = theme.fg("dim", hyperlink(wt.pr.url, wt.pr.url));
    lines.push(kv("PR", `${prNum} — ${prUrl}`));
  }
  const shortSha = wt.head ? wt.head.slice(0, 10) : "(none)";
  const headText = detail.headSubject ? `${shortSha} — ${detail.headSubject}` : shortSha;
  lines.push(kv("HEAD", headText));

  const flags = formatWorktreeTags(wt);
  if (flags.length > 0) {
    const extra: string[] = [];
    if (wt.lockedReason) extra.push(`locked: ${wt.lockedReason}`);
    if (wt.prunableReason) extra.push(`prunable: ${wt.prunableReason}`);
    const flagStr = extra.length > 0 ? `${flags.join(" ")} (${extra.join("; ")})` : flags.join(" ");
    lines.push(kv("Flags", flagStr));
  }

  if (wt.peers.length > 0) {
    const peerDesc = wt.peers
      .map((p) => {
        const state = p.busy ? "busy" : "idle";
        const pid = p.pid ? `, pid:${p.pid}` : "";
        const purpose = p.purpose ? ` — ${p.purpose}` : "";
        return `${p.name} (${state}${pid})${purpose}`;
      })
      .join("; ");
    lines.push(kv("COMS peer", theme.fg("accent", peerDesc)));
  } else {
    lines.push(kv("COMS peer", theme.fg("dim", "none")));
  }

  const guard = canRemoveWorktree(wt);
  if (!guard.allowed) {
    lines.push(kv("Remove", theme.fg("dim", `blocked — ${guard.reason}`)));
  } else {
    lines.push(kv("Remove", theme.fg("muted", "press d to remove (confirmation required)")));
  }

  lines.push("");
  if (wt.prunable) {
    lines.push(theme.fg("error", "Worktree directory is missing/prunable — press p to prune."));
  } else if (wt.bare) {
    lines.push(theme.fg("dim", "Bare repository worktree."));
  } else if (detail.statusOk === false) {
    const errSuffix = detail.statusError ? ` (${detail.statusError})` : "";
    lines.push(theme.fg("warning", `Working tree status unavailable${errSuffix}.`));
  } else if (detail.statusLines.length === 0) {
    lines.push(theme.fg("success", "Working tree clean."));
  } else {
    lines.push(theme.fg("muted", `git status --short (${detail.statusLines.length}):`));
    const shown = detail.statusLines.slice(0, MAX_STATUS_LINES);
    for (const s of shown) lines.push(`  ${s}`);
    if (detail.statusLines.length > MAX_STATUS_LINES) {
      lines.push(theme.fg("dim", `  ... +${detail.statusLines.length - MAX_STATUS_LINES} more`));
    }
  }

  return lines;
}

/** Run `git worktree prune -v`, invalidate caches, and notify listeners. */
export async function runWorktreePrune(
  cwd: string,
  deps: Pick<WorktreeDeps, "runGitAsync" | "onWorktreesChanged"> = {},
): Promise<{ ok: boolean; pruned: string[]; message: string }> {
  const runner = deps.runGitAsync ?? runGitAsync;
  const res = await runner(["worktree", "prune", "-v"], cwd);
  const parsed = formatPruneResult(res.stdout, res.stderr ?? "", res.code);
  if (parsed.ok) {
    invalidateWorktreeCache(cwd);
    deps.onWorktreesChanged?.();
  }
  log.info("worktree_prune", { ok: parsed.ok, pruned: parsed.pruned.length });
  return parsed;
}

/**
 * Guarded `git worktree remove <path>` — re-verifies clean state and live COMS peers
 * right before executing git so state cannot drift between UI render and confirmation.
 */
export async function executeGuardedWorktreeRemove(
  cwd: string,
  targetPath: string,
  deps: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers" | "onWorktreesChanged"> = {},
): Promise<{ ok: boolean; message: string }> {
  const runner = deps.runGitAsync ?? runGitAsync;
  const freshViews = await loadWorktreeViews(cwd, deps, true, { includePrs: false, strictPeers: true });
  const fresh = freshViews.find((w) => w.path === targetPath);
  if (!fresh) {
    invalidateWorktreeCache(cwd);
    deps.onWorktreesChanged?.();
    return { ok: false, message: `Worktree no longer exists: ${targetPath}` };
  }
  const guard = canRemoveWorktree(fresh);
  if (!guard.allowed) {
    log.info("worktree_remove_blocked", { path: targetPath, reason: guard.reason });
    return { ok: false, message: guard.reason };
  }
  const res = await runner(["worktree", "remove", targetPath], cwd);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "git worktree remove failed").trim();
    log.warn("worktree_remove_failed", { path: targetPath, detail });
    return { ok: false, message: `Failed to remove worktree: ${detail}` };
  }
  invalidateWorktreeCache(cwd);
  deps.onWorktreesChanged?.();
  log.info("worktree_removed", { path: targetPath, branch: fresh.branch });
  return { ok: true, message: `Removed worktree: ${displayWorktreePath(targetPath, cwd)}` };
}

/** Interactive list → detail overlay for `/worktree`. */
export async function openWorktreeOverlay(
  ctx: ExtensionCommandContext,
  deps: WorktreeDeps = {},
): Promise<void> {
  const openOverlay = deps.openOverlay ?? openListDetailOverlay;
  const runner = deps.runGitAsync ?? runGitAsync;
  const copyFn = deps.copyToClipboard ?? copyTextToClipboard;

  let views = await loadWorktreeViews(ctx.cwd, deps, true);
  if (!isLiveExtensionCtx(ctx)) return;
  if (views.length === 0) {
    safeNotify(ctx, "Not in a git repository (no worktrees found).", "info");
    return;
  }

  let reselectId: string | undefined = views.find((w) => w.isCurrent)?.id ?? views[0]?.id;
  const selectedIds = new Set<string>();

  type ListAction =
    | { kind: "detail"; wt: WorktreeView }
    | { kind: "remove"; targets: WorktreeView[] }
    | { kind: "refresh" }
    | { kind: "prune" };

  for (;;) {
    if (!isLiveExtensionCtx(ctx)) return;
    const listQueue: ListAction[] = [];

    await openOverlay<string, WorktreeView>(ctx, {
      emptyMessage: "Not in a git repository (no worktrees found).",
      initialSelectionId: reselectId,
      initialSelectionIds: [...selectedIds],
      listSpec: {
        title: "Worktrees",
        countLabel: (items) => {
          const linked = countLinkedWorktrees(items);
          return `${items.length} worktree${items.length === 1 ? "" : "s"} (${linked} linked)`;
        },
        borderTitle: (items) => {
          const linked = countLinkedWorktrees(items);
          const dirty = items.filter((w) => (w.dirty?.total ?? 0) > 0).length;
          return `worktrees · ${linked} linked${dirty > 0 ? ` · ${dirty} dirty` : ""}`;
        },
        footerHints: "↑↓/jk navigate · Space select · d/x remove · p prune · r refresh · Enter detail · Esc close",
        listItems: () => views,
        rowParts: (wt, theme) => buildWorktreeRowParts(wt, ctx.cwd, theme),
        selectable: true,
        onSelectionChange: (ids) => {
          selectedIds.clear();
          for (const id of ids) selectedIds.add(String(id));
        },
        onSelect: (wt) => {
          reselectId = wt.id;
          listQueue.push({ kind: "detail", wt });
        },
        onKey: (key, wt, selected) => {
          if (wt) reselectId = wt.id;
          if (matchesOverlayKey(key, "d") || matchesOverlayKey(key, "x")) {
            const targets = selected.length > 0 ? [...selected] : wt ? [wt] : [];
            if (targets.length === 0) return false;
            listQueue.push({ kind: "remove", targets });
            return "close";
          }
          if (matchesOverlayKey(key, "r")) {
            listQueue.push({ kind: "refresh" });
            return "close";
          }
          if (matchesOverlayKey(key, "p")) {
            listQueue.push({ kind: "prune" });
            return "close";
          }
          return false;
        },
      },
    });

    const action = listQueue.pop();
    if (!action || !isLiveExtensionCtx(ctx)) return;

    if (action.kind === "remove") {
      const removable: WorktreeView[] = [];
      const blocked: Array<{ wt: WorktreeView; reason: string }> = [];
      for (const target of action.targets) {
        const guard = canRemoveWorktree(target);
        if (guard.allowed) removable.push(target);
        else blocked.push({ wt: target, reason: guard.reason });
      }
      if (removable.length === 0) {
        const msg =
          blocked.length === 1
            ? blocked[0].reason
            : `Cannot remove ${blocked.length} selected worktrees: ${blocked
                .map((b) => `${displayWorktreePath(b.wt.path, ctx.cwd)} (${b.reason})`)
                .join("; ")}`;
        safeNotify(ctx, msg, "warning");
        continue;
      }

      let confirmed = false;
      const blockedNote =
        blocked.length > 0
          ? `\n(${blocked.length} selected worktree${blocked.length === 1 ? "" : "s"} skipped: protected/dirty/active)`
          : "";
      try {
        if (removable.length === 1) {
          const wt = removable[0];
          const label = formatWorktreeLabel(wt);
          const rel = displayWorktreePath(wt.path, ctx.cwd);
          confirmed = await ctx.ui.confirm(
            "Remove worktree?",
            `Remove worktree "${rel}" (${label})?\nPath: ${wt.path}${blockedNote}`,
          );
        } else {
          const listText = removable
            .map((w) => `- ${displayWorktreePath(w.path, ctx.cwd)} (${formatWorktreeLabel(w)})`)
            .join("\n");
          confirmed = await ctx.ui.confirm(
            `Remove ${removable.length} worktrees?`,
            `Remove these worktrees?\n${listText}${blockedNote}`,
          );
        }
      } catch (e: any) {
        log.debug("worktree_confirm_failed", { count: removable.length, error: e?.message || String(e) });
        return;
      }
      if (!isLiveExtensionCtx(ctx)) return;
      if (!confirmed) {
        log.debug("worktree_remove_cancelled", { count: removable.length });
        continue;
      }

      selectedIds.clear();
      if (removable.length === 1 && blocked.length === 0) {
        const removed = await executeGuardedWorktreeRemove(ctx.cwd, removable[0].path, deps);
        safeNotify(ctx, removed.message, removed.ok ? "info" : "warning");
      } else {
        const failed: string[] = blocked.map((b) => displayWorktreePath(b.wt.path, ctx.cwd));
        for (const wt of removable) {
          const res = await executeGuardedWorktreeRemove(ctx.cwd, wt.path, deps);
          if (!res.ok) failed.push(displayWorktreePath(wt.path, ctx.cwd));
        }
        const total = removable.length + blocked.length;
        log.info("worktree_bulk_remove", { total, failed: failed.length });
        safeNotify(
          ctx,
          bulkResultMessage("removed", "worktree", total, failed),
          failed.length === 0 ? "info" : "warning",
        );
      }
      views = await loadWorktreeViews(ctx.cwd, deps, true);
      if (!isLiveExtensionCtx(ctx) || views.length === 0) return;
      reselectId = views.find((w) => w.isCurrent)?.id ?? views[0]?.id;
      continue;
    }

    if (action.kind === "refresh") {
      views = await loadWorktreeViews(ctx.cwd, deps, true, { forceRefreshPrs: true });
      if (!isLiveExtensionCtx(ctx) || views.length === 0) return;
      continue;
    }

    if (action.kind === "prune") {
      const pruned = await runWorktreePrune(ctx.cwd, deps);
      safeNotify(ctx, pruned.message, pruned.ok ? "info" : "warning");
      views = await loadWorktreeViews(ctx.cwd, deps, true);
      if (!isLiveExtensionCtx(ctx) || views.length === 0) return;
      continue;
    }

    // ── Detail view loop ──────────────────────────────────────────────
    const targetPath = action.wt.path;
    let currentWt: WorktreeView | undefined = action.wt;

    for (;;) {
      if (!currentWt || !isLiveExtensionCtx(ctx)) break;
      const wt = currentWt;
      const detail = await loadWorktreeDetail(wt, runner);
      if (!isLiveExtensionCtx(ctx)) return;

      type DetailAction = "copy" | "remove" | "prune" | "refresh";
      const detailQueue: DetailAction[] = [];

      await ctx.ui.custom<null>((tui, theme, _kb, done) => {
        return new OverlayScrollDetail(
          tui,
          theme,
          {
            footerHints: "↑↓/jk scroll · c copy path · d remove · p prune · r refresh · Esc back",
            getHeader: (t) => {
              const tags = formatWorktreeTags(wt).join(" ");
              const tagStr = tags ? ` ${t.fg("dim", tags)}` : "";
              return `${t.fg("accent", t.bold(formatWorktreeLabel(wt)))}${tagStr}`;
            },
            getBodyLines: (t) => buildWorktreeDetailLines(wt, detail, t),
            onKey: (key) => {
              if (matchesOverlayKey(key, "c")) {
                detailQueue.push("copy");
                return "close";
              }
              if (matchesOverlayKey(key, "d")) {
                const guard = canRemoveWorktree(wt);
                if (!guard.allowed) {
                  safeNotify(ctx, guard.reason, "warning");
                  return "redraw";
                }
                detailQueue.push("remove");
                return "close";
              }
              if (matchesOverlayKey(key, "p")) {
                detailQueue.push("prune");
                return "close";
              }
              if (matchesOverlayKey(key, "r")) {
                detailQueue.push("refresh");
                return "close";
              }
              return false;
            },
          },
          done,
        );
      }, OVERLAY_OPTS);

      const detailAction = detailQueue.pop();
      if (!detailAction) break;

      if (detailAction === "copy") {
        const res = await copyFn(wt.path);
        if (!isLiveExtensionCtx(ctx)) return;
        if (res.ok) {
          const msg =
            res.method === "osc52"
              ? `Sent worktree path to terminal clipboard (OSC 52): ${wt.path}`
              : `Copied worktree path: ${wt.path}`;
          safeNotify(ctx, msg, "info");
        } else {
          safeNotify(ctx, `Copy unavailable (${res.error}) — path: ${wt.path}`, "warning");
        }
        continue;
      }

      if (detailAction === "refresh") {
        views = await loadWorktreeViews(ctx.cwd, deps, true, { forceRefreshPrs: true });
        if (!isLiveExtensionCtx(ctx)) return;
        currentWt = views.find((w) => w.path === targetPath);
        continue;
      }

      if (detailAction === "prune") {
        const pruned = await runWorktreePrune(ctx.cwd, deps);
        safeNotify(ctx, pruned.message, pruned.ok ? "info" : "warning");
        views = await loadWorktreeViews(ctx.cwd, deps, true);
        if (!isLiveExtensionCtx(ctx)) return;
        currentWt = views.find((w) => w.path === targetPath);
        continue;
      }

      if (detailAction === "remove") {
        if (!isLiveExtensionCtx(ctx)) return;
        const label = formatWorktreeLabel(wt);
        const rel = displayWorktreePath(wt.path, ctx.cwd);
        let confirmed = false;
        try {
          confirmed = await ctx.ui.confirm(
            "Remove worktree?",
            `Remove worktree "${rel}" (${label})?\nPath: ${wt.path}`,
          );
        } catch (e: any) {
          log.debug("worktree_confirm_failed", { path: wt.path, error: e?.message || String(e) });
          return;
        }
        if (!isLiveExtensionCtx(ctx)) return;
        if (!confirmed) {
          log.debug("worktree_remove_cancelled", { path: wt.path });
          continue;
        }
        const removed = await executeGuardedWorktreeRemove(ctx.cwd, wt.path, deps);
        safeNotify(ctx, removed.message, removed.ok ? "info" : "warning");
        views = await loadWorktreeViews(ctx.cwd, deps, true);
        if (!isLiveExtensionCtx(ctx)) return;
        if (removed.ok) {
          reselectId = views.find((w) => w.isCurrent)?.id ?? views[0]?.id;
          break;
        }
        currentWt = views.find((w) => w.path === targetPath);
      }
    }
  }
}

export function registerWorktree(pi: ExtensionAPI, deps: WorktreeDeps = {}): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const effectiveDeps: WorktreeDeps = {
    ...deps,
    onWorktreesChanged: () => {
      deps.onWorktreesChanged?.();
      pi.events?.emit?.("orchestrator:worktrees-changed", {});
    },
  };

  pi.registerCommand("worktree", {
    description: "Open the git worktrees TUI overlay",
    handler: async (_args, ctx) => {
      log.debug("worktree_command", { hasUI: !!ctx?.hasUI, browser: isBrowserDispatch(ctx) });
      if (!ctx?.hasUI || isBrowserDispatch(ctx)) {
        const views = await loadWorktreeViews(ctx.cwd, effectiveDeps, true);
        emitOutput(pi, ctx, formatWorktreeTable(views, ctx.cwd, { hyperlinks: false }), "info");
        return;
      }
      await openWorktreeOverlay(ctx, effectiveDeps);
    },
  });

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "worktree_status",
      label: "Worktree Status",
      description:
        "Inspect git worktrees (path, branch, dirty counts, open PR, active COMS peers) or prune stale worktree metadata.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("prune")], {
          description: "'list' to list git worktrees with dirty counts, PRs, and active COMS peers; 'prune' to run git worktree prune -v.",
        }),
      }),
      async execute(_callId, params, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd || process.cwd();
        if (params.action === "list") {
          const views = await loadWorktreeViews(cwd, effectiveDeps, true);
          const text = formatWorktreeTable(views, cwd, { hyperlinks: false });
          log.debug("worktree_status_tool_list", { cwd, count: views.length });
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "list", count: views.length, worktrees: views },
          };
        }
        if (params.action === "prune") {
          const res = await runWorktreePrune(cwd, effectiveDeps);
          log.info("worktree_status_tool_prune", { cwd, ok: res.ok, pruned: res.pruned.length });
          return {
            content: [{ type: "text" as const, text: res.message }],
            details: { action: "prune", ...res },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Unknown action "${String(params.action)}". Use "list" or "prune".` }],
          details: { ok: false },
        };
      },
    });
  }
}
