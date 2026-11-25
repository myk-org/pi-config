/**
 * /worktree command — interactive worktree overlay + list/prune subcommands.
 * Built on openListDetailOverlay / OverlayScrollDetail.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";
import {
  countLinkedWorktrees,
  invalidateWorktreeCache,
  listWorktreesAsync,
  runGitAsync,
  type GitAsyncRunner,
  type OpenPr,
} from "./git-helpers.js";
import {
  OVERLAY_OPTS,
  OverlayScrollDetail,
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

/** Load worktrees with dirty counts, matched live COMS peers, and open GitHub PRs. */
export async function loadWorktreeViews(
  cwd: string,
  deps: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers" | "fetchOpenPrs"> = {},
  forceRefresh = true,
  opts: { includePrs?: boolean; forceRefreshPrs?: boolean; strictPeers?: boolean } = {},
): Promise<WorktreeView[]> {
  const includePrs = opts.includePrs ?? true;
  const prFetcher =
    deps.fetchOpenPrs ??
    ((dir, o) => fetchOpenPrsByBranchAsync(dir, { forceRefresh: o?.forceRefresh }));

  const [entries, prsByBranch] = await Promise.all([
    listWorktreesAsync(cwd, {
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
  const peerInspection: PeerInspectionResult = deps.inspectLivePeers
    ? deps.inspectLivePeers(cwd, { strict: opts.strictPeers })
    : deps.readLivePeers
      ? { peers: deps.readLivePeers(cwd), verified: true }
      : inspectLiveComsPeers(cwd, { strict: opts.strictPeers });
  const unverifiedReason = peerInspection.verified
    ? undefined
    : (peerInspection.error || "COMS registry unreadable");
  return attachPeersToWorktrees(entries, peerInspection.peers, prsByBranch, unverifiedReason);
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

  type ListAction =
    | { kind: "detail"; wt: WorktreeView }
    | { kind: "refresh" }
    | { kind: "prune" };

  for (;;) {
    if (!isLiveExtensionCtx(ctx)) return;
    const listQueue: ListAction[] = [];

    await openOverlay<string, WorktreeView>(ctx, {
      emptyMessage: "Not in a git repository (no worktrees found).",
      initialSelectionId: reselectId,
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
        footerHints: "↑↓/jk navigate · Enter detail · p prune · r refresh · Esc close",
        listItems: () => views,
        rowParts: (wt, theme) => buildWorktreeRowParts(wt, ctx.cwd, theme),
        onSelect: (wt) => {
          reselectId = wt.id;
          listQueue.push({ kind: "detail", wt });
        },
        onKey: (key, wt) => {
          if (wt) reselectId = wt.id;
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
    description: "Inspect and manage git worktrees (/worktree [list|prune])",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().toLowerCase();
      log.debug("worktree_command", { sub: sub || "overlay", hasUI: !!ctx?.hasUI });

      if (sub === "list") {
        const views = await loadWorktreeViews(ctx.cwd, effectiveDeps, true);
        emitOutput(pi, ctx, formatWorktreeTable(views, ctx.cwd, { hyperlinks: !!ctx?.hasUI }), "info");
        return;
      }

      if (sub === "prune") {
        const res = await runWorktreePrune(ctx.cwd, effectiveDeps);
        emitOutput(pi, ctx, res.message, res.ok ? "info" : "warning");
        return;
      }

      if (sub === "") {
        if (!ctx?.hasUI) {
          const views = await loadWorktreeViews(ctx.cwd, effectiveDeps, true);
          emitOutput(pi, ctx, formatWorktreeTable(views, ctx.cwd, { hyperlinks: false }), "info");
          return;
        }
        await openWorktreeOverlay(ctx, effectiveDeps);
        return;
      }

      emitOutput(pi, ctx, `Unknown subcommand "${sub}". Usage: /worktree [list|prune]`, "warning");
    },
  });
}
