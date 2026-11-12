/**
 * Coms peer overlay — the same interaction as `/async-status`, for the peer inventory.
 *
 * The text list answered "who exists?"; this answers it in the place a user acts: navigate with
 * j/k, `x` kills the focused peer, `X` kills every live peer, Esc closes. Detail pane shows where the
 * peer runs and how healthy it is (heartbeat age, socket, queue, context), which is the state a
 * headless peer can actually expose — it has no screen to watch.
 */
import type { Component } from "@earendil-works/pi-tui";
import { describePeerOrigin } from "./coms-peers.js";
import { renderWorkloadPart, workloadSectionLines, workloadUnknownLine } from "./coms-workload.js";
import type { DescribeResult } from "./coms-describe.js";
import { OverlayScrollDetail } from "../orchestrator/overlay-dashboard.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.js";
import { openListDetailOverlay } from "../orchestrator/overlay-dashboard.js";
import type { RegistryRow } from "./coms-peers.js";

const log = createLogger("coms-peers-ui");

export interface ComsPeersOverlayDeps {
  /** Live rows, freshly read each render (a peer can die or join while the overlay is open). */
  listPeers: () => RegistryRow[];
  /** Kill one peer; returns what happened so the overlay can say so. */
  killPeer: (row: RegistryRow) => string;
  /** Kill every live peer. */
  killAll: () => string;
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
  let status: string | null = null;

  await openListDetailOverlay< string, Row>(ctx, {
    emptyMessage: deps.emptyMessage ?? "No peers in the coms registry.",
    listSpec: {
      title: "Coms peers",
      countLabel: (rows) => `${rows.length} peer${rows.length === 1 ? "" : "s"}`,
      borderTitle: (rows) => `peers · ${rows.filter((r) => r.busy).length} busy / ${rows.length}`,
      footerHints: "↑↓/jk navigate · Space select · x kill peer · X kill all · Esc close",
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
        status = deps.killPeer(row);
        log.info("overlay_kill_peer", { name: row.name, project: row.project });
      },
      selectable: true,
      onXSelected: (rows) => {
        const results = rows.map((row) => deps.killPeer(row));
        status = results.join(" · ");
        log.info("overlay_kill_selection", { count: rows.length });
      },
      onKillAll: () => {
        status = deps.killAll();
        log.info("overlay_kill_all");
      },
    },
    createDetail: (row, tui, theme: Theme, done): Component => {
      const peerId = row.id;
      // #1083: ask the peer once, when the detail opens. `pending` renders nothing, so a slow
      // peer never paints a count it has not reported; the answer (or the 2s timeout) is picked
      // up by OverlayScrollDetail's own 1s invalidate tick — no polling of files.
      const workload: { state: "pending" | "done"; result: DescribeResult | null } = { state: "pending", result: null };
      const ask = deps.describePeer;
      if (ask) {
        void ask(row)
          .then((result) => { workload.result = result; workload.state = "done"; log.debug("describe_resolved", { peer: row.name, answered: result.ok }); })
          .catch((err) => {
            workload.result = { ok: false, reason: "malformed" };
            workload.state = "done";
            log.warn("describe_failed", { peer: row.name, error: err instanceof Error ? err.message : String(err) });
          });
      } else {
        workload.result = { ok: false, reason: "no-sources" };
        workload.state = "done";
      }
      // OverlayScrollDetail owns the detail contract: key handling, scrolling and done(). A bare
      // Text here painted over the chat and never released the session (user-reported hang).
      return new OverlayScrollDetail(
        tui,
        theme,
        {
          footerHints: "↑↓/jk scroll · x kill · Esc back",
          onX: () => {
            const current = deps.listPeers().find((p) => `${p.project}:${p.name}` === peerId);
            if (!current) return false;
            status = deps.killPeer(current);
            return true;
          },
          getHeader: (t) => {
            const current = deps.listPeers().find((p) => `${p.project}:${p.name}` === peerId) || row;
            const state = current.busy ? t.fg("warning", "busy") : t.fg("success", "idle");
            return `${state} ${t.fg("accent", t.bold(current.name))} ${t.fg("dim", `· ${current.project}`)}`;
          },
          getBodyLines: () => {
            const current = deps.listPeers().find((p) => `${p.project}:${p.name}` === peerId) || row;
            const age = deps.heartbeatAgeSeconds?.(current);
            const origin = describePeerOrigin(current);
            const lines = [
              `cwd       ${current.cwd || "?"}`,
              `purpose   ${current.purpose || "—"}`,
              `state     ${current.busy ? "busy" : "idle"}${current.queueDepth ? ` · queue ${current.queueDepth}` : ""}`,
              `created   ${origin.by === "unknown" ? "unknown (no record)" : origin.by} · via ${origin.via}`,
              `pid       ${current.pid ?? "?"}`,
              `socket    ${current.endpoint || "?"}`,
              `heartbeat ${age === null || age === undefined ? "unknown" : `${age}s ago`} (last keep-alive)`,
              `context   ${current.contextUsedPct === null ? "?" : `${Math.round(current.contextUsedPct)}%`}`,
              // The registry rewrites started_at on every heartbeat, so it is not a real start time.
              "",
            ];
            if (status) lines.push(status);
            if (workload.state === "done") {
              lines.push("");
              const result = workload.result;
              // An answered peer with nothing active says so; only silence is `unknown`.
              lines.push(...(result?.ok ? workloadSectionLines(result.detail) : [workloadUnknownLine(result?.reason ?? "timeout")]));
            }
            return lines;
          },
        },
        done,
      );
    },
  });
}
