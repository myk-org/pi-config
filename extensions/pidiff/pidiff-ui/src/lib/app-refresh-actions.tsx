import React from "react";
import { createLogger } from "./create-logger.ts";
import { PidiffRefreshControl } from "./refresh-control.tsx";

const log = createLogger("pidiff-ui");

/** Header + stale-banner Refresh slots used by App. */
export function AppRefreshActions({
  hasSession,
  stale,
  refreshing,
  onRefresh,
}: {
  hasSession: boolean;
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  log.debug("AppRefreshActions", { hasSession, stale, refreshing });
  return (
    <>
      {hasSession && (
        <PidiffRefreshControl
          slot="header"
          refreshing={refreshing}
          onRefresh={onRefresh}
          className="h-7 px-2.5 text-[11px] rounded-md border border-border"
        />
      )}
      {stale && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
          <span className="text-xs text-amber-400">Files have changed since this diff was loaded</span>
          <PidiffRefreshControl
            slot="banner"
            refreshing={refreshing}
            onRefresh={onRefresh}
            className="h-6 px-2 text-[11px] rounded-md border border-amber-500/30 text-amber-400"
          />
        </div>
      )}
    </>
  );
}
