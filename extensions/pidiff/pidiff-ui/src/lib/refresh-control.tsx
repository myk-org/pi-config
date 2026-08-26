import { cn } from "./utils.ts";
import { createLogger } from "./create-logger.ts";
import { refreshButtonState } from "./request-diffs.ts";
import React from "react";
import { RefreshCw } from "lucide-react";

const log = createLogger("pidiff-ui");

export function PidiffRefreshControl({
  refreshing,
  onRefresh,
  className,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  className?: string;
}) {
  const btn = refreshButtonState(refreshing);
  log.debug("PidiffRefreshControl render", { refreshing, disabled: btn.disabled });
  return (
    <button
      type="button"
      data-pidiff-refresh="true"
      data-spinning={btn.spinning ? "true" : "false"}
      disabled={btn.disabled}
      onClick={onRefresh}
      className={cn("inline-flex items-center gap-1.5", className)}
    >
      <RefreshCw className={cn("h-3 w-3", btn.spinning && "animate-spin")} />
      Refresh
    </button>
  );
}
