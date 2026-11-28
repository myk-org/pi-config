/**
 * Coms peer overlay — `[1] Roster` (live & recently stopped supervised peers, `r` revive,
 * `f` scope, `q` inbound queue, `m` message, `x`/`X` kill, `Enter` drilldown) and
 * `[2] Activity` (unified cross-peer live COMS activity log with `f` filter, `/` search,
 * `Space` follow, and `Enter` jump-to-peer).
 */
import type { Component } from "@earendil-works/pi-tui";
import { renderWorkloadPart } from "./coms-workload.js";
import { backTarget, buildDrilldownRows, buildPeerInfoRow, itemIdLabel, logDetailOpen, sectionCountLabel, sectionEnterMode, type DrilldownItem, type DrilldownRow } from "./coms-drilldown.js";
import { sanitizePeerText } from "./peer-text.js";
import type { DescribeResult } from "./coms-describe.js";
import {
  OVERLAY_OPTS,
  OverlayScrollDetail,
  bulkResultMessage,
  matchesOverlayKey,
  openListDetailOverlay,
  type OverlayNotice,
  type OverlayNotify,
} from "../orchestrator/overlay-dashboard.js";
import {
  OverlayActivityView,
  formatActivityTabBar,
  type ActivityEvent,
  type ActivityFilter,
  type OverlayActivityResult,
  type OverlayActivityTab,
} from "../orchestrator/overlay-activity-log.js";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { buildTellRequest } from "./coms-shared.js";
import {
  collectComsActivityEvents,
  formatComsPeersPlainText,
  isPeerBusy,
  peerOverlayRowId,
  type RegistryRow,
} from "./coms-peers.js";

const log = createLogger("coms-peers-ui");

export type ComsPeerScope = "project" | "all";

/** Delivery is stated, never inferred from a message's first character. */
export type TellOutcome = { ok: true } | { ok: false; reason: string; code: string };

/** Explicit revive outcome for a stopped supervised peer (`r` key). */
export type RevivePeerOutcome =
  | { ok: true; message: string; pid?: number | null }
  | { ok: false; reason: string };

export interface ComsPeersOverlayDeps {
  /** Live rows, freshly read each render (a peer can die or join while the overlay is open). */
  listPeers: (scope?: ComsPeerScope) => RegistryRow[];
  /** Optional recently stopped supervised peers shown for `r` revive (#1417). */
  listStoppedPeers?: (scope?: ComsPeerScope) => RegistryRow[];
  /** Optional revive handler (`r`) that respawns a stopped supervised peer via the supervisor. */
  revivePeer?: (row: RegistryRow) => RevivePeerOutcome | Promise<RevivePeerOutcome>;
  /** Optional chronological COMS activity feed for the `[2] Activity` tab. */
  listActivityEvents?: (scope: ComsPeerScope) => ActivityEvent[];
  /** Kill one peer; returns what happened so the overlay can say so. */
  killPeer: (row: RegistryRow) => string;
  /** Kill every live peer in the active scope. */
  killAll: (scope?: ComsPeerScope) => string;
  /** Open the local inbound queue overlay (`q` key). */
  openQueue?: () => Promise<void>;
  /** Send the user's own message to a peer (#1077). Absent means no composer is offered.
   *  Returns a stated outcome: a caller that sniffs text to decide delivery counts a dead socket
   *  as a success (#1084). */
  tellPeer?: (request: { target: string; prompt: string; project?: string; expectedEndpoint?: string }) => Promise<TellOutcome>;
  /** The shared list→detail overlay. Injected only by tests, which need to drive Enter without a
   *  TUI; production always uses the default. */
  openOverlay?: typeof openListDetailOverlay;
  /** #1083: ask the focused peer for its own active workload. `ok` = it answered (possibly
   *  with nothing active); `reason` = it never did — rendered as `unknown`, never as zeros. */
  describePeer?: (row: RegistryRow) => Promise<DescribeResult>;
  heartbeatAgeSeconds?: (row: RegistryRow) => number | null;
  /** Optional clock override (primarily for tests verifying pending-revive TTL expiry). */
  now?: () => number;
  emptyMessage?: string;
}

type Row = RegistryRow & { id: string };

/** Matches coms-wrapper's REVIVE_CLAIM_TTL_MS so stalled supervisor launches return to retryable stopped state. */
export const REVIVE_PENDING_TTL_MS = 45_000;

function isThenable<T>(value: unknown): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as Promise<T>).then === "function";
}

function reportSinglePeerRevive(
  row: Row,
  outcome: RevivePeerOutcome,
  notify: OverlayNotify,
): void {
  const safeName = sanitizePeerText(row.name, 40);
  if (outcome.ok) {
    log.info("overlay_revive_peer_ok", { name: row.name, project: row.project, pid: outcome.pid ?? null });
    notify(sanitizePeerText(outcome.message || `Revived peer "${safeName}".`, 160), "info");
  } else {
    log.error("overlay_revive_peer_failed", { name: row.name, project: row.project, reason: outcome.reason });
    notify(sanitizePeerText(`Could not revive "${safeName}": ${outcome.reason}`, 160), "error");
  }
}

function peerKey(row: Pick<RegistryRow, "project" | "name">): string {
  return `${row.project}::${row.name}`;
}

function isRevivePending(pendingRevives: Map<string, number>, key: string, now: number): boolean {
  const claimedAt = pendingRevives.get(key);
  if (claimedAt === undefined) return false;
  if (now - claimedAt >= REVIVE_PENDING_TTL_MS) {
    pendingRevives.delete(key);
    return false;
  }
  return true;
}

function triggerSinglePeerRevive(
  row: Row,
  revivePeer: NonNullable<ComsPeersOverlayDeps["revivePeer"]>,
  notify: OverlayNotify,
  pendingRevives: Map<string, number>,
  now: () => number,
): void {
  const safeName = sanitizePeerText(row.name, 40);
  if (!row.stopped) {
    log.debug("overlay_revive_peer_skipped_live", { name: row.name, project: row.project });
    notify(`Peer "${safeName}" is already running.`, "info");
    return;
  }
  const key = peerKey(row);
  const ts = now();
  if (isRevivePending(pendingRevives, key, ts)) {
    log.debug("overlay_revive_peer_skipped_pending", { name: row.name, project: row.project });
    notify(`Peer "${safeName}" is already reviving…`, "info");
    return;
  }
  pendingRevives.set(key, ts);
  try {
    const outcome = revivePeer(row);
    if (isThenable<RevivePeerOutcome>(outcome)) {
      outcome
        .then((res) => {
          if (!res.ok) pendingRevives.delete(key);
          reportSinglePeerRevive(row, res, notify);
        })
        .catch((err: unknown) => {
          pendingRevives.delete(key);
          reportSinglePeerRevive(row, { ok: false, reason: err instanceof Error ? err.message : String(err) }, notify);
        });
    } else {
      if (!outcome.ok) pendingRevives.delete(key);
      reportSinglePeerRevive(row, outcome, notify);
    }
  } catch (err: unknown) {
    pendingRevives.delete(key);
    reportSinglePeerRevive(row, { ok: false, reason: err instanceof Error ? err.message : String(err) }, notify);
  }
}

function triggerBulkPeerRevive(
  selected: readonly Row[],
  revivePeer: NonNullable<ComsPeersOverlayDeps["revivePeer"]>,
  notify: OverlayNotify,
  pendingRevives: Map<string, number>,
  now: () => number,
): void {
  const stoppedSelected = selected.filter((r) => r.stopped === true);
  if (stoppedSelected.length === 0) {
    log.debug("overlay_revive_selection_none_eligible", { selected: selected.length });
    notify("No stopped peers in selection to revive.", "warning");
    return;
  }
  const ts = now();
  const eligible = stoppedSelected.filter((r) => !isRevivePending(pendingRevives, peerKey(r), ts));
  if (eligible.length === 0) {
    log.debug("overlay_revive_selection_all_pending", { selected: stoppedSelected.length });
    notify("Selected stopped peer(s) are already reviving…", "info");
    return;
  }

  const syncFailed: string[] = [];
  const asyncResults: Array<Promise<{ name: string; key: string; outcome: RevivePeerOutcome }>> = [];
  let hasAsync = false;

  for (const row of eligible) {
    const safeName = sanitizePeerText(row.name, 40);
    const key = peerKey(row);
    pendingRevives.set(key, ts);
    try {
      const outcome = revivePeer(row);
      if (isThenable<RevivePeerOutcome>(outcome)) {
        hasAsync = true;
        asyncResults.push(
          outcome
            .then((res) => {
              if (!res.ok) pendingRevives.delete(key);
              return { name: safeName, key, outcome: res };
            })
            .catch((err: unknown) => {
              pendingRevives.delete(key);
              return {
                name: safeName,
                key,
                outcome: { ok: false as const, reason: err instanceof Error ? err.message : String(err) },
              };
            }),
        );
      } else {
        if (!outcome.ok) {
          pendingRevives.delete(key);
          syncFailed.push(`${safeName}: ${outcome.reason}`);
        }
        asyncResults.push(Promise.resolve({ name: safeName, key, outcome }));
      }
    } catch (err: unknown) {
      pendingRevives.delete(key);
      const reason = err instanceof Error ? err.message : String(err);
      asyncResults.push(Promise.resolve({ name: safeName, key, outcome: { ok: false as const, reason } }));
      syncFailed.push(`${safeName}: ${reason}`);
    }
  }

  const emitSummary = (failed: string[]) => {
    log.info("overlay_revive_selection_done", { attempted: eligible.length, failed: failed.length });
    notify(
      sanitizePeerText(bulkResultMessage("revived", "peer", eligible.length, failed), 160),
      failed.length === 0 ? "info" : "warning",
    );
  };

  if (!hasAsync) {
    emitSummary(syncFailed);
    return;
  }
  void Promise.all(asyncResults).then((settled) => {
    const failed = settled
      .filter((entry) => !entry.outcome.ok)
      .map((entry) => `${entry.name}: ${(entry.outcome as { ok: false; reason: string }).reason}`);
    emitSummary(failed);
  });
}

export async function openComsPeersOverlay(
  ctx: ExtensionCommandContext,
  deps: ComsPeersOverlayDeps,
): Promise<void> {
  const openOverlay = deps.openOverlay ?? openListDetailOverlay;
  let projectScope: ComsPeerScope = "project";

  const getActivityEvents = (): ActivityEvent[] => {
    if (deps.listActivityEvents) return deps.listActivityEvents(projectScope);
    return collectComsActivityEvents({
      historyRecords: [],
      livePeers: deps.listPeers(projectScope),
      stoppedPeers: deps.listStoppedPeers?.(projectScope) ?? [],
    });
  };

  if (!ctx.hasUI) {
    const live = deps.listPeers(projectScope);
    const stopped = deps.listStoppedPeers?.(projectScope) ?? [];
    const events = getActivityEvents();
    const text = formatComsPeersPlainText(
      live,
      stopped,
      events,
      deps.emptyMessage ?? "No peers in the coms registry.",
    );
    log.debug("coms_overlay_plain_fallback", { live: live.length, stopped: stopped.length, events: events.length });
    try { ctx.ui?.notify?.(text, "info"); } catch {}
    return;
  }

  // Peers currently being revived (`project::name` -> claim epoch ms), preventing duplicate
  // supervisor launches while expiring cleanly if a spawned supervisor stalls or exits early.
  const now = deps.now ?? (() => Date.now());
  const pendingRevives = new Map<string, number>();

  // Names can be reused; ticks and focus belong to this session's endpoint (or stopped key).
  const toRowsForScope = (scope: ComsPeerScope): Row[] => {
    const currentNow = now();
    const live = deps.listPeers(scope);
    const liveKeys = new Set(live.map((row) => peerKey(row)));
    for (const [key, claimedAt] of pendingRevives.entries()) {
      if (liveKeys.has(key) || currentNow - claimedAt >= REVIVE_PENDING_TTL_MS) {
        pendingRevives.delete(key);
      }
    }
    const liveRows: Row[] = live.map((row) => ({ ...row, id: peerOverlayRowId(row) }));
    const stopped = (deps.listStoppedPeers?.(scope) ?? [])
      .filter((row) => !liveKeys.has(peerKey(row)))
      .map((row) => {
        const key = peerKey(row);
        const claimedAt = pendingRevives.get(key);
        const stoppedTs = row.stoppedAt ? Date.parse(row.stoppedAt) : Number.NaN;
        if (claimedAt !== undefined && !Number.isNaN(stoppedTs) && stoppedTs > claimedAt) {
          // A newer stop/failure record landed after we claimed revive — clear so user can retry.
          pendingRevives.delete(key);
        }
        return { ...row, stopped: true, id: peerOverlayRowId({ ...row, stopped: true }) };
      });
    return [...liveRows, ...stopped];
  };
  const toRows = (): Row[] => toRowsForScope(projectScope);

  // `m` needs the whole terminal for a text dialog, `q` opens the inbound queue overlay, `2` opens
  // the Activity Log tab, and Enter navigates a level deeper, so the list closes and re-opens.
  const composeQueue: Array<{ rows: Row[]; missing: readonly string[] }> = [];
  // The ticks belong to the USER, not to one dashboard instance: entering a drilldown re-opens the
  // list with a fresh instance, so the selection survives here instead (a `Set` the overlay seeds
  // and reports back into). Same reason `reselectPeer` exists for the cursor.
  const selectedIds = new Set<string>();
  const peerQueue: Row[] = [];
  let queueRequested = false;
  // #1084: Esc from the drilldown returns to the peer list focused on the peer it came from.
  let reselectPeer: string | undefined;

  let activeTab: OverlayActivityTab = "roster";
  let activityFilter: ActivityFilter = "all";
  let activitySearch = "";
  let activityFollowing = true;
  let pendingNotice: OverlayNotice | undefined;

  const footerHints = [
    "↑↓/jk navigate",
    "Space select",
    ...(deps.revivePeer ? ["r revive"] : []),
    ...(deps.tellPeer ? ["m message"] : []),
    "x kill",
    "X kill all",
    "f scope",
    ...(deps.openQueue ? ["q queue"] : []),
    "1/2 view",
    "Esc close",
  ].join(" · ");

  for (;;) {
    if (activeTab === "activity") {
      const initialNotice = pendingNotice;
      pendingNotice = undefined;
      const activityResult = await ctx.ui.custom<OverlayActivityResult>(
        (tui, theme, keybindings, done) => {
          const view = new OverlayActivityView(
            tui,
            theme,
            keybindings,
            {
              title: "Coms peers",
              listEvents: getActivityEvents,
              initialFilter: activityFilter,
              initialSearch: activitySearch,
              initialFollowing: activityFollowing,
              onFilterChange: (f) => { activityFilter = f; },
              onSearchChange: (s) => { activitySearch = s; },
              onFollowChange: (f) => { activityFollowing = f; },
              emptyMessage: "No COMS activity recorded yet.",
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
        // Match ONLY by exact project-qualified sourceId — never fall back to bare display name,
        // which would open a different namesake peer in another project. If a verified cross-project
        // peer is outside the current project scope, look it up in the all-projects inventory.
        const target =
          toRows().find((r) => r.id === activityResult.event.sourceId) ??
          (projectScope === "project"
            ? toRowsForScope("all").find((r) => r.id === activityResult.event.sourceId)
            : undefined);
        if (!target) {
          const safeLabel = sanitizePeerText(activityResult.event.sourceLabel, 40);
          pendingNotice = {
            message: activityResult.event.sourceId.startsWith("peer:ambiguous:")
              ? `Peer "${safeLabel}" matches multiple projects (legacy history) — select it from Roster.`
              : `Peer "${safeLabel}" is not in the current roster.`,
            level: "warning",
          };
          continue;
        }
        await openPeerDrilldown(ctx, deps, target, pendingRevives, now);
        continue;
      }
      continue;
    }

    const allowEmpty =
      Boolean(deps.openQueue) ||
      deps.listPeers("project").length > 0 ||
      deps.listPeers("all").length > 0 ||
      (deps.listStoppedPeers?.("project").length ?? 0) > 0 ||
      (deps.listStoppedPeers?.("all").length ?? 0) > 0;

    let switchToActivity = false;
    const initialNotice = pendingNotice;
    pendingNotice = undefined;

    await openOverlay<string, Row>(ctx, {
      emptyMessage: deps.emptyMessage ?? "No peers in the coms registry.",
      allowEmpty,
      initialSelectionId: reselectPeer,
      initialSelectionIds: [...selectedIds],
      initialNotice,
      listSpec: {
        title: "Coms peers",
        headerSuffix: (theme) => formatActivityTabBar("roster", theme),
        countLabel: (rows) => `${rows.length} peer${rows.length === 1 ? "" : "s"}`,
        borderTitle: (rows) => {
          const liveRows = rows.filter((r) => !r.stopped);
          const stoppedCount = rows.length - liveRows.length;
          const stoppedPart = stoppedCount > 0 ? ` · ${stoppedCount} stopped` : "";
          return `peers (${projectScope === "all" ? "all projects" : "this project"}) · ${liveRows.filter((r) => isPeerBusy(r)).length} busy / ${liveRows.length}${stoppedPart}`;
        },
        emptyBody: () =>
          projectScope === "all"
            ? (deps.openQueue ? "No peers in any project. Press q for inbound queue or 2 for activity." : "No peers in any project. Press 2 for activity.")
            : (deps.openQueue ? "No peers in this project. Press f for all projects, q for queue, or 2 for activity." : "No peers in this project. Press f for all projects or 2 for activity."),
        footerHints,
        listItems: toRows,
        rowParts: (row, theme: Theme) => {
          if (row.stopped) {
            const isReviving = isRevivePending(pendingRevives, peerKey(row), now());
            return {
              glyph: isReviving ? theme.fg("warning", "◐") : theme.fg("muted", "○"),
              title: sanitizePeerText(row.name, 100),
              idLabel: theme.fg("dim", sanitizePeerText(row.project, 100)),
              rightParts: [
                isReviving ? theme.fg("warning", "reviving…") : theme.fg("muted", "stopped"),
                ...(row.container ? [theme.fg("accent", `🐳 ${sanitizePeerText(row.container, 32)}`)] : []),
                ...(row.piSessionId ? [theme.fg("dim", "session")] : []),
                ...(typeof row.exitCode === "number" && row.exitCode !== 0
                  ? [theme.fg("error", `exit:${row.exitCode}`)]
                  : []),
                ...(row.cwd ? [theme.fg("dim", sanitizePeerText(row.cwd, 40))] : []),
                ...(!isReviving && deps.revivePeer ? [theme.fg("dim", "r revive")] : []),
              ],
            };
          }
          // #1083: the peer's own active work — or `unknown`, never a fabricated 0.
          const workload = renderWorkloadPart(row.workload, theme).trim();
          const busy = isPeerBusy(row);
          return {
            glyph: busy ? theme.fg("warning", "◆") : theme.fg("success", "●"),
            title: sanitizePeerText(row.name, 100),
            idLabel: theme.fg("dim", sanitizePeerText(row.project, 100)),
            rightParts: [
              theme.fg("muted", busy ? "busy" : "idle"),
              ...(row.queueDepth ? [theme.fg("dim", `queue:${row.queueDepth}`)] : []),
              ...(row.contextUsedPct === null ? [] : [theme.fg("dim", `ctx:${Math.round(row.contextUsedPct)}%`)]),
              ...(row.container ? [theme.fg("accent", `🐳 ${sanitizePeerText(row.container, 32)}`)] : []),
              ...((row.hostPid ?? row.pid) ? [theme.fg("dim", `pid:${row.hostPid ?? row.pid}`)] : []),
              ...(workload ? [workload] : []),
            ],
          };
        },
        onKey: (key, row, selected, notify) => {
          if (matchesOverlayKey(key, "2")) {
            if (row) reselectPeer = row.id;
            switchToActivity = true;
            log.debug("overlay_tab_switch", { to: "activity" });
            return "close";
          }
          if (matchesOverlayKey(key, "1")) {
            return "redraw";
          }
          if (matchesOverlayKey(key, "r") && deps.revivePeer) {
            if (selected.length > 0) {
              triggerBulkPeerRevive(selected, deps.revivePeer, notify, pendingRevives, now);
              return "redraw-clear";
            }
            if (!row) {
              notify("No peer selected to revive.", "info");
              return "redraw";
            }
            triggerSinglePeerRevive(row, deps.revivePeer, notify, pendingRevives, now);
            return "redraw";
          }
          if (matchesOverlayKey(key, "f")) {
            projectScope = projectScope === "project" ? "all" : "project";
            log.debug("overlay_scope_toggled", { scope: projectScope });
            return "redraw";
          }
          if (matchesOverlayKey(key, "q") && deps.openQueue) {
            if (row) reselectPeer = row.id;
            queueRequested = true;
            log.debug("overlay_open_queue_requested");
            return "close";
          }
          return false;
        },
        onX: (row, notify) => {
          if (row.stopped) {
            notify(`Peer "${sanitizePeerText(row.name, 40)}" is already stopped — press r to revive.`, "info");
            return;
          }
          // No detail pane holds a result any more, so the outcome is notified where the user looks.
          const killed = deps.killPeer(row);
          log.info("overlay_kill_peer", { name: row.name, project: row.project });
          notify(sanitizePeerText(killed, 120), "info");
        },
        selectable: true,
        onXSelected: (rows, notify) => {
          const liveRows = rows.filter((r) => !r.stopped);
          if (liveRows.length === 0) {
            notify("No live peers in selection to kill.", "info");
            return;
          }
          const results = liveRows.map((row) => deps.killPeer(row)).join(" · ");
          log.info("overlay_kill_selection", { count: liveRows.length });
          notify(sanitizePeerText(results, 120), "info");
        },
        onKillAll: (notify) => {
          const killed = deps.killAll(projectScope);
          log.info("overlay_kill_all", { scope: projectScope });
          notify(sanitizePeerText(killed, 120), "info");
        },
        // The overlay keeps no state across re-opens: it reports the ticks and takes them back.
        onSelectionChange: (ids) => {
          selectedIds.clear();
          for (const id of ids) selectedIds.add(String(id));
          log.debug("overlay_selection_changed", { count: selectedIds.size });
        },
        // Compose acts on the selection (the overlay hands over every selected row).
        onCompose: deps.tellPeer ? (rows, missingIds) => { composeQueue.push({ rows, missing: missingIds }); } : undefined,
        // #1084: Enter walks INTO the peer instead of opening a wall of text.
        onSelect: (row) => { peerQueue.push(row); },
      },
    });

    if (switchToActivity) {
      activeTab = "activity";
      continue;
    }

    if (queueRequested && deps.openQueue) {
      queueRequested = false;
      await deps.openQueue();
      continue;
    }

    const inspected = peerQueue.pop();
    if (inspected) {
      reselectPeer = inspected.id;
      await openPeerDrilldown(ctx, deps, inspected, pendingRevives, now);
      continue;
    }

    const picked = composeQueue.pop();
    if (!picked || !deps.tellPeer) return;
    // Dedupe by id, keeping row order: the same peer twice must be sent to once, not twice.
    const uniqueRows = [...new Map(picked.rows.map((row) => [row.id, row])).values()];
    const stoppedPicked = uniqueRows.filter((row) => row.stopped);
    const targets = uniqueRows.filter((row) => !row.stopped);
    const missing = [...new Set(picked.missing)];
    const total = targets.length + missing.length + stoppedPicked.length;
    const nameOf = (id: string): string => sanitizePeerText(id.split("\0")[0].slice(id.indexOf(":") + 1), 40) || "unknown peer";
    const goneNote = missing.length > 0
      ? ` · ${missing.length} peer${missing.length === 1 ? "" : "s"} left before sending: ${missing.map(nameOf).join(", ")}`
      : "";
    const stoppedNames = stoppedPicked.map((r) => sanitizePeerText(r.name, 40)).join(", ");
    const stoppedNote = stoppedPicked.length > 0
      ? ` · skipped ${stoppedPicked.length} stopped peer${stoppedPicked.length === 1 ? "" : "s"} (${stoppedNames} — press r to revive)`
      : "";

    if (targets.length === 0 && stoppedPicked.length > 0 && missing.length === 0) {
      pendingNotice = {
        message: `Cannot message stopped peer${stoppedPicked.length === 1 ? "" : "s"} (${stoppedNames}) — press r to revive first.`,
        level: "warning",
      };
      continue;
    }

    // Everyone left before the dialog opened: say nothing was sent, do not ask for text.
    if (targets.length === 0) {
      log.warn("overlay_tell_nothing_sent", { selected: total, missing: missing.length, stopped: stoppedPicked.length });
      try { ctx.ui.notify(sanitizePeerText(`⚠️ nothing sent · Esc closes; reopen /coms to reset selection${goneNote}${stoppedNote}`, 160), "error"); } catch {}
      continue;
    }

    const title = targets.length === 1
      ? `Message ${sanitizePeerText(targets[0].name, 40)} (sent as you)`
      : `Message ${targets.length} peers (sent as you)`;
    const text = await ctx.ui.input(title, "one line to the peer");
    const first = buildTellRequest(targets[0], text ?? "");
    if (!first) {
      log.debug("overlay_tell_cancelled", { count: targets.length });
      continue;
    }

    // A nonempty send consumes the ticks, even when delivery fails. Cancel/back keeps them.
    log.debug("overlay_selection_consumed", { count: selectedIds.size, targets: targets.length });
    selectedIds.clear();

    // One request per peer. Only a stated `ok` counts as delivered; a failure keeps its reason.
    let sent = 0;
    const failed: string[] = [];
    const failures: string[] = [];
    const failCodes: string[] = [];
    for (const target of targets) {
      const request = buildTellRequest(target, text ?? "");
      if (!request) continue;
      const name = sanitizePeerText(target.name, 40);
      // ONE event and ONE level for every non-delivery, whatever produced it (#1084 finding 3).
      const fail = (code: string, reason: string): void => {
        failed.push(name);
        failures.push(reason);
        failCodes.push(code);
        log.error("overlay_tell_failed", { name: request.target, code, peers: targets.length });
      };
      try {
        const result = await deps.tellPeer(request);
        if (result.ok) sent += 1;
        else fail(result.code, result.reason);
      } catch (err) {
        fail("threw", err instanceof Error ? err.message : String(err));
      }
    }
    log.info("overlay_tell_peer", { selected: picked.rows.length, unique: targets.length, sent, failed: failed.length, missing: missing.length, chars: first.prompt.length });

    // ONE line for the whole send: per-peer notifies would bury the failures. The count is stated
    // ("sent 1 of 3") whenever the selection did not fully arrive, so a partial send (including
    // mixed selections containing stopped peers) cannot read as full success.
    const hasPartial = missing.length > 0 || failed.length > 0 || stoppedPicked.length > 0;
    const sentPart = hasPartial ? `sent ${sent} of ${total}` : `sent ${sent} peer${sent === 1 ? "" : "s"}`;
    {
      // One failing peer keeps its reason (that is what the user acts on); several get names only.
      const reason = failed.length === 1 && failures[0] ? ` (${failures[0]})` : "";
      const failurePart = failed.length > 0 ? ` · failed ${failed.length}: ${failed.join(", ")}${reason}` : "";
      const summary = !hasPartial
        ? `📡 ${sentPart}`
        : `⚠️ ${sentPart}${failurePart}${goneNote}${stoppedNote}`;
      const level = failed.length > 0 || missing.length > 0
        ? "error"
        : stoppedPicked.length > 0
          ? "warning"
          : "info";
      try { ctx.ui.notify(sanitizePeerText(summary, 200), level); } catch {}
    }
  }
}

/** One line of peer identity for the section list's border: the drilldown's own header, since the
 *  old text pane is gone. */
function peerHeader(row: Row, deps: ComsPeersOverlayDeps): string {
  const parts = [sanitizePeerText(row.name, 40), sanitizePeerText(row.project, 40), isPeerBusy(row) ? "busy" : "idle"];
  if (row.container) parts.push(`🐳 ${sanitizePeerText(row.container, 32)}`);
  if (row.contextUsedPct !== null) parts.push(`ctx ${Math.round(row.contextUsedPct)}%`);
  if (row.queueDepth) parts.push(`queue ${row.queueDepth}`);
  const age = deps.heartbeatAgeSeconds?.(row);
  if (typeof age === "number") parts.push(`hb ${age}s`);
  return parts.join(" · ");
}

/**
 * Level 2 + 3 (#1084): Enter on a peer lists its sections, Enter on a section opens the shared
 * overlay for that section's items, Esc walks back one level. Data is the `describe` reply fetched
 * once here — never the local store, never a file.
 *
 * READ-ONLY: acting on another session's tasks/crons would need a remote command protocol, and a
 * key that silently does nothing is worse than no key, so the footer says so instead.
 */
async function openPeerDrilldown(
  ctx: any,
  deps: ComsPeersOverlayDeps,
  row: Row,
  pendingRevives: Map<string, number>,
  now: () => number,
): Promise<void> {
  if (row.stopped) {
    const dash = (value: string | null | undefined): string => (value && value.trim() ? value : "—");
    const isReviving = isRevivePending(pendingRevives, peerKey(row), now());
    const detail: Array<[string, string]> = [
      ["Name", dash(sanitizePeerText(row.name, 40))],
      ["Project", dash(sanitizePeerText(row.project, 40))],
      ["State", isReviving ? "reviving… (starting supervisor)" : "stopped (supervised peer)"],
      ...(row.container ? [["Container", sanitizePeerText(row.container, 64)] as [string, string]] : []),
      ["cwd", dash(sanitizePeerText(row.cwd, 120))],
      ["Purpose", dash(sanitizePeerText(row.purpose, 120))],
      ["Session", dash(sanitizePeerText(row.piSessionId ?? "", 80))],
      ["Stopped at", dash(sanitizePeerText(row.stoppedAt ?? "", 40))],
      ["Exit code", typeof row.exitCode === "number" ? String(row.exitCode) : "—"],
      ["Action", isReviving ? "Revive already in progress" : (deps.revivePeer ? "Press r to revive this peer via supervisor" : "Supervised peer stopped")],
    ];
    const detailNotify: OverlayNotify = (msg, level = "info") => {
      try { ctx.ui?.notify?.(msg, level); } catch {}
    };
    await ctx.ui.custom(
      (tui: any, theme: Theme, _kb: any, done: (value: null) => void) =>
        new OverlayScrollDetail(
          tui,
          theme,
          {
            footerHints: deps.revivePeer && !isReviving
              ? "↑↓/jk scroll · r revive · Esc back"
              : "↑↓/jk scroll · Esc back",
            getHeader: (t) => t.fg("accent", t.bold(`${sanitizePeerText(row.name, 40)} · ${isReviving ? "reviving…" : "stopped"}`)),
            getBodyLines: (t) => detail.map(([label, value]) => `${t.fg("muted", label.padEnd(11))}  ${value}`),
            onKey: deps.revivePeer
              ? (key) => {
                  if (!matchesOverlayKey(key, "r")) return false;
                  triggerSinglePeerRevive(row, deps.revivePeer!, detailNotify, pendingRevives, now);
                  return "close";
                }
              : undefined,
          },
          done,
        ),
      OVERLAY_OPTS,
    );
    return;
  }

  const ask = deps.describePeer;
  let result: DescribeResult;
  if (!ask) {
    result = { ok: false, reason: "not-reported" };
  } else {
    try {
      result = await ask(row);
    } catch (err) {
      log.warn("drilldown_describe_failed", { peer: row.name, error: err instanceof Error ? err.message : String(err) });
      result = { ok: false, reason: "malformed" };
    }
  }
  // #1084 finding 2: identity and location come back as the first row — the same registry fields
  // the old text pane showed, read from the row this list already holds (no new RPC, no files).
  const rows = [
    buildPeerInfoRow({ ...row, heartbeatAgeSeconds: deps.heartbeatAgeSeconds?.(row) ?? null }),
    ...buildDrilldownRows(result),
  ];
  log.debug("drilldown_opened", { peer: row.name, rows: rows.length, answered: result.ok });
  const header = peerHeader(row, deps);

  const sectionQueue: DrilldownRow[] = [];
  // #1084 finding 4: Esc from a section re-opens this list on that section, not on row 0.
  let reselectSection: string | undefined;
  for (;;) {
    await (deps.openOverlay ?? openListDetailOverlay)<string, DrilldownRow>(ctx, {
      emptyMessage: "This peer reported no work.",
      initialSelectionId: reselectSection,
      listSpec: {
        title: `Peer ${sanitizePeerText(row.name, 40)}`,
        countLabel: sectionCountLabel,
        borderTitle: () => header,
        footerHints: "↑↓/jk navigate · Enter open · Esc back · read-only (reported by the peer)",
        listItems: () => rows,
        rowParts: (item, theme: Theme) => ({
          glyph: theme.fg("accent", "▸"),
          title: item.label,
          idLabel: "",
          rightParts: [],
        }),
        onSelect: (item) => { sectionQueue.push(item); },
      },
    });
    const section = sectionQueue.pop();
    if (!section) {
      // Esc from the sections hands control back to the caller, which re-opens the peer list.
      log.debug("drilldown_esc", { to: backTarget({ level: "sections", peer: row.name })?.level ?? "close" });
      return;
    }
    reselectSection = section.id;
    // One item is one Enter step: open its detail directly instead of a row list of one.
    if (sectionEnterMode(section.items) === "detail") {
      await ctx.ui.custom(
        (tui: any, theme: Theme, _kb: any, done: (value: null) => void) =>
          itemDetailComponent(section.items[0], tui, theme, done, "direct"),
        OVERLAY_OPTS,
      );
      continue;
    }
    await openSectionOverlay(ctx, row, section, deps.openOverlay ?? openListDetailOverlay);
  }
}

/** Level 3: one section's items, the detail pane reusing the fields the peer reported. */
async function openSectionOverlay(
  ctx: any,
  row: Row,
  section: DrilldownRow,
  openOverlay: typeof openListDetailOverlay,
): Promise<void> {
  const title = `${section.label} · ${sanitizePeerText(row.name, 40)}`;
  log.debug("drilldown_section_open", { peer: row.name, section: section.section ?? "status", items: section.items.length });
  await openOverlay<string, DrilldownItem>(ctx, {
    emptyMessage: `${section.label}: nothing to show.`,
    listSpec: {
      title,
      countLabel: (items) => `${items.length} item${items.length === 1 ? "" : "s"}`,
      borderTitle: () => `${title} · read-only`,
      // Acting on a peer's own work needs a remote command protocol; a silent no-op key would be worse.
      footerHints: "↑↓/jk navigate · Enter view · Esc back · read-only: remote data",
      listItems: () => section.items,
      rowParts: (item, theme: Theme) => ({
        glyph: theme.fg("accent", "·"),
        title: item.row,
        // The composite row identity is bookkeeping: only the peer's own id may be shown.
        idLabel: itemIdLabel(item) ? theme.fg("dim", itemIdLabel(item)) : "",
        rightParts: [],
      }),
    },
    createDetail: (item, tui, theme, done): Component =>
      itemDetailComponent(item, tui, theme, done, "list"),
  });
}

/** The read-only detail pane for one item — used by a section list AND by the single-item path,
 *  so the two can never render differently. */
function itemDetailComponent(
  item: DrilldownItem,
  tui: any,
  theme: Theme,
  done: (value: null) => void,
  path: "direct" | "list",
): Component {
  // Construction only (never per render), ids and counts only.
  logDetailOpen(path, item);
  return new OverlayScrollDetail(
    tui,
    theme,
    {
      // Read-only: acting on a peer's own work would need a remote command protocol.
      footerHints: "↑↓/jk scroll · Esc back · read-only: remote data",
      getHeader: (t) => t.fg("accent", t.bold(sanitizePeerText(item.row, 120))),
      getBodyLines: (t) => item.detail.map(([label, value]) => `${t.fg("muted", label.padEnd(11))}  ${value}`),
    },
    done,
  );
}
