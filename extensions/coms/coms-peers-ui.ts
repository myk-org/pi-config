/**
 * Coms peer overlay — the same interaction as `/async-status`, for the peer inventory.
 *
 * The text list answered "who exists?"; this answers it in the place a user acts: navigate with
 * j/k, `x` kills the focused peer, `X` kills every live peer, `m` writes the focused peer a message
 * as the user, Esc closes. Detail pane shows where the peer runs and how healthy it is (heartbeat
 * age, socket, queue, context), which is the state a headless peer can actually expose — it has no
 * screen to watch.
 */
import type { Component } from "@earendil-works/pi-tui";
import { renderWorkloadPart } from "./coms-workload.js";
import { backTarget, buildDrilldownRows, type DrilldownItem, type DrilldownRow } from "./coms-drilldown.js";
import { sanitizePeerText } from "./peer-text.js";
import type { DescribeResult } from "./coms-describe.js";
import { OverlayScrollDetail } from "../orchestrator/overlay-dashboard.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.js";
import { openListDetailOverlay } from "../orchestrator/overlay-dashboard.js";
import { buildTellRequest } from "./coms-shared.js";
import type { RegistryRow } from "./coms-peers.js";

const log = createLogger("coms-peers-ui");

export interface ComsPeersOverlayDeps {
  /** Live rows, freshly read each render (a peer can die or join while the overlay is open). */
  listPeers: () => RegistryRow[];
  /** Kill one peer; returns what happened so the overlay can say so. */
  killPeer: (row: RegistryRow) => string;
  /** Kill every live peer. */
  killAll: () => string;
  /** Send the user's own message to a peer (#1077). Absent means no composer is offered. */
  tellPeer?: (request: { target: string; prompt: string; project?: string }) => Promise<string>;
  /** #1083: ask the focused peer for its own active workload. `ok` = it answered (possibly
   *  with nothing active); `reason` = it never did — rendered as `unknown`, never as zeros. */
  describePeer?: (row: RegistryRow) => Promise<DescribeResult>;
  heartbeatAgeSeconds?: (row: RegistryRow) => number | null;
  emptyMessage?: string;
}

type Row = RegistryRow & { id: string };

export async function openComsPeersOverlay(
  ctx: any,
  deps: ComsPeersOverlayDeps,
): Promise<void> {
  const toRows = (): Row[] => deps.listPeers().map((row) => ({ ...row, id: `${row.project}:${row.name}` }));
  // `m` needs the whole terminal for a text dialog, and Enter navigates a level deeper, so the
  // list closes and is re-opened after each. The overlay hands the focused row over through these
  // queues (a bare variable would be narrowed to null across the await, since the assignment
  // happens inside its callback).
  const composeQueue: Row[] = [];
  const peerQueue: Row[] = [];

  for (;;) {
    await openListDetailOverlay< string, Row>(ctx, {
      emptyMessage: deps.emptyMessage ?? "No peers in the coms registry.",
      listSpec: {
        title: "Coms peers",
        countLabel: (rows) => `${rows.length} peer${rows.length === 1 ? "" : "s"}`,
        borderTitle: (rows) => `peers · ${rows.filter((r) => r.busy).length} busy / ${rows.length}`,
        footerHints: deps.tellPeer
          ? "↑↓/jk navigate · Space select · m message · x kill peer · X kill all · Esc close"
          : "↑↓/jk navigate · Space select · x kill peer · X kill all · Esc close",
        listItems: toRows,
        rowParts: (row, theme: Theme) => {
          // #1083: the peer's own active work — or `unknown`, never a fabricated 0.
          const workload = renderWorkloadPart(row.workload, theme).trim();
          return {
            glyph: row.busy ? theme.fg("warning", "◆") : theme.fg("success", "●"),
            title: row.name,
            idLabel: theme.fg("dim", row.project),
            rightParts: [
              theme.fg("muted", row.busy ? "busy" : "idle"),
              ...(row.queueDepth ? [theme.fg("dim", `queue:${row.queueDepth}`)] : []),
              ...(row.contextUsedPct === null ? [] : [theme.fg("dim", `ctx:${Math.round(row.contextUsedPct)}%`)]),
              ...(row.pid ? [theme.fg("dim", `pid:${row.pid}`)] : []),
              ...(workload ? [workload] : []),
            ],
          };
        },
        onX: (row) => {
          // No detail pane holds a result any more, so the outcome is notified where the user looks.
          const killed = deps.killPeer(row);
          log.info("overlay_kill_peer", { name: row.name, project: row.project });
          try { ctx.ui.notify(sanitizePeerText(killed, 120), "info"); } catch {}
        },
        selectable: true,
        onXSelected: (rows) => {
          const results = rows.map((row) => deps.killPeer(row)).join(" · ");
          log.info("overlay_kill_selection", { count: rows.length });
          try { ctx.ui.notify(sanitizePeerText(results, 120), "info"); } catch {}
        },
        onKillAll: () => {
          const killed = deps.killAll();
          log.info("overlay_kill_all");
          try { ctx.ui.notify(sanitizePeerText(killed, 120), "info"); } catch {}
        },
        onCompose: deps.tellPeer ? (row) => { composeQueue.push(row); } : undefined,
        // #1084: Enter walks INTO the peer instead of opening a wall of text.
        onSelect: (row) => { peerQueue.push(row); },
      },
    });

    const inspected = peerQueue.pop();
    if (inspected) {
      await openPeerDrilldown(ctx, deps, inspected);
      continue;
    }

    const target = composeQueue.pop();
    if (!target || !deps.tellPeer) return;
    // Same one-line dialog the rest of pi uses; Esc or an empty line means "nothing to send" and
    // returns to the list rather than dropping the user back into the session. The list is closed
    // while the dialog is up and re-opens after the send — the composer needs the whole terminal.
    const text = await ctx.ui.input(`Message ${sanitizePeerText(target.name, 40)} (sent as you)`, "one line to the peer");
    const request = buildTellRequest(target, text ?? "");
    if (!request) {
      log.debug("overlay_tell_cancelled", { name: target.name, project: target.project });
      continue;
    }
    const result = await deps.tellPeer(request);
    log.info("overlay_tell_peer", { name: request.target, project: request.project ?? null, chars: request.prompt.length });
    // A failed user send must reach the user where they are looking: the composer closed the list,
    // so the reopened list's own lines are not on screen yet.
    if (result.startsWith("⚠")) {
      log.warn("overlay_tell_failed", { name: request.target, project: request.project ?? null });
      // The status carries the peer's own error text; sanitize the whole line, not just the name.
      try { ctx.ui.notify(sanitizePeerText(result, 120), "error"); } catch {}
    }
  }
}

/** One line of peer identity for the section list's border: the drilldown's own header, since the
 *  old text pane is gone. */
function peerHeader(row: Row, deps: ComsPeersOverlayDeps): string {
  const parts = [sanitizePeerText(row.name, 40), sanitizePeerText(row.project, 40), row.busy ? "busy" : "idle"];
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
async function openPeerDrilldown(ctx: any, deps: ComsPeersOverlayDeps, row: Row): Promise<void> {
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
  const rows = buildDrilldownRows(result);
  log.debug("drilldown_opened", { peer: row.name, rows: rows.length, answered: result.ok });
  const header = peerHeader(row, deps);

  const sectionQueue: DrilldownRow[] = [];
  for (;;) {
    await openListDetailOverlay<string, DrilldownRow>(ctx, {
      emptyMessage: "This peer reported no work.",
      listSpec: {
        title: `Peer ${sanitizePeerText(row.name, 40)}`,
        countLabel: (items) => `${items.length} section${items.length === 1 ? "" : "s"}`,
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
    await openSectionOverlay(ctx, row, section);
  }
}

/** Level 3: one section's items, the detail pane reusing the fields the peer reported. */
async function openSectionOverlay(ctx: any, row: Row, section: DrilldownRow): Promise<void> {
  const title = `${section.label} · ${sanitizePeerText(row.name, 40)}`;
  log.debug("drilldown_section_open", { peer: row.name, section: section.section ?? "status", items: section.items.length });
  await openListDetailOverlay<string, DrilldownItem>(ctx, {
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
        idLabel: theme.fg("dim", item.id),
        rightParts: [],
      }),
    },
    createDetail: (item, tui, theme: Theme, done): Component =>
      new OverlayScrollDetail(
        tui,
        theme,
        {
          footerHints: "↑↓/jk scroll · Esc back",
          getHeader: (t) => t.fg("accent", t.bold(sanitizePeerText(item.row, 120))),
          getBodyLines: (t) => item.detail.map(([label, value]) => `${t.fg("muted", label.padEnd(11))}  ${value}`),
        },
        done,
      ),
  });
}
