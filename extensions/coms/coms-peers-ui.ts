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
import { backTarget, buildDrilldownRows, buildPeerInfoRow, itemIdLabel, logDetailOpen, sectionCountLabel, sectionEnterMode, type DrilldownItem, type DrilldownRow } from "./coms-drilldown.js";
import { sanitizePeerText } from "./peer-text.js";
import type { DescribeResult } from "./coms-describe.js";
import { OverlayScrollDetail } from "../orchestrator/overlay-dashboard.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.js";
import { OVERLAY_OPTS, openListDetailOverlay } from "../orchestrator/overlay-dashboard.js";
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
  /** Send the user's own message to a peer (#1077). Absent means no composer is offered.
   *  Returns a stated outcome: a caller that sniffs text to decide delivery counts a dead socket
   *  as a success (#1084). */
  tellPeer?: (request: { target: string; prompt: string; project?: string }) => Promise<TellOutcome>;
  /** The shared list→detail overlay. Injected only by tests, which need to drive Enter without a
   *  TUI; production always uses the default. */
  openOverlay?: typeof openListDetailOverlay;
  /** #1083: ask the focused peer for its own active workload. `ok` = it answered (possibly
   *  with nothing active); `reason` = it never did — rendered as `unknown`, never as zeros. */
  describePeer?: (row: RegistryRow) => Promise<DescribeResult>;
  heartbeatAgeSeconds?: (row: RegistryRow) => number | null;
  emptyMessage?: string;
}

type Row = RegistryRow & { id: string };

/** Delivery is stated, never inferred from a message's first character. */
export type TellOutcome = { ok: true } | { ok: false; reason: string; code: string };

export async function openComsPeersOverlay(
  ctx: any,
  deps: ComsPeersOverlayDeps,
): Promise<void> {
  const openOverlay = deps.openOverlay ?? openListDetailOverlay;
  const toRows = (): Row[] => deps.listPeers().map((row) => ({ ...row, id: `${row.project}:${row.name}` }));
  // `m` needs the whole terminal for a text dialog, and Enter navigates a level deeper, so the
  // list closes and is re-opened after each. The overlay hands the focused row over through these
  // queues (a bare variable would be narrowed to null across the await, since the assignment
  // happens inside its callback).
  // Each entry: the rows that survived to this moment, and the selected ids that had already gone.
  const composeQueue: Array<{ rows: Row[]; missing: string[] }> = [];
  // The ticks belong to the USER, not to one dashboard instance: entering a drilldown re-opens the
  // list with a fresh instance, so the selection survives here instead (a `Set` the overlay seeds
  // and reports back into). Same reason `reselectPeer` exists for the cursor.
  const selectedIds = new Set<string>();
  const peerQueue: Row[] = [];
  // #1084: Esc from the drilldown returns to the peer list focused on the peer it came from.
  let reselectPeer: string | undefined;

  for (;;) {
    await openOverlay<string, Row>(ctx, {
      emptyMessage: deps.emptyMessage ?? "No peers in the coms registry.",
      initialSelectionId: reselectPeer,
      initialSelectionIds: [...selectedIds],
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

    const inspected = peerQueue.pop();
    if (inspected) {
      reselectPeer = inspected.id;
      await openPeerDrilldown(ctx, deps, inspected);
      continue;
    }

    const picked = composeQueue.pop();
    if (!picked || !deps.tellPeer) return;
    // Dedupe by id, keeping row order: the same peer twice must be sent to once, not twice.
    const targets = [...new Map(picked.rows.map((row) => [row.id, row])).values()];
    const missing = [...new Set(picked.missing)];
    const total = targets.length + missing.length;
    const nameOf = (id: string): string => sanitizePeerText(id.slice(id.indexOf(":") + 1), 40) || id;
    const goneNote = missing.length > 0
      ? ` · ${missing.length} peer${missing.length === 1 ? "" : "s"} left before sending: ${missing.map(nameOf).join(", ")}`
      : "";

    // Everyone left before the dialog opened: say nothing was sent, do not ask for text.
    if (targets.length === 0) {
      log.warn("overlay_tell_nothing_sent", { selected: total, missing: missing.length });
      try { ctx.ui.notify(sanitizePeerText(`⚠️ nothing sent${goneNote}`, 160), "error"); } catch {}
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
    // ("sent 1 of 3") whenever the selection did not fully arrive, so a partial send cannot read
    // as success.
    const sentPart = missing.length > 0 || failed.length > 0 ? `sent ${sent} of ${total}` : `sent ${sent} peer${sent === 1 ? "" : "s"}`;
    if (targets.length + missing.length > 1 || failed.length > 0 || missing.length > 0) {
      // One failing peer keeps its reason (that is what the user acts on); several get names only.
      const reason = failed.length === 1 && failures[0] ? ` (${failures[0]})` : "";
      const failurePart = failed.length > 0 ? ` · failed ${failed.length}: ${failed.join(", ")}${reason}` : "";
      const summary = failed.length === 0 && missing.length === 0
        ? `📡 ${sentPart}`
        : `⚠️ ${sentPart}${failurePart}${goneNote}`;
      try { ctx.ui.notify(sanitizePeerText(summary, 200), failed.length === 0 && missing.length === 0 ? "info" : "error"); } catch {}
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
