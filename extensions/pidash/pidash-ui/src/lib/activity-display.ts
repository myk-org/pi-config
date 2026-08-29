import type { SessionActivity } from "../../../activity-state.ts";

interface ActivitySession {
  active: boolean;
  activity?: SessionActivity;
  working?: boolean;
}

export function sessionActivityDisplay(session: ActivitySession): {
  label: "working" | "waiting for input" | "idle" | "offline";
  isWorking: boolean;
  indicatorClassName: string;
  badgeClassName: string;
} {
  if (!session.active) {
    return { label: "offline", isWorking: false, indicatorClassName: "bg-orange-400", badgeClassName: "bg-orange-400/15 text-orange-400" };
  }
  const activity = session.activity ?? (session.working ? "working" : "idle");
  if (activity === "working") {
    return { label: "working", isWorking: true, indicatorClassName: "bg-yellow-400 animate-pulse", badgeClassName: "bg-yellow-500/15 text-yellow-400" };
  }
  if (activity === "waiting_for_input") {
    return { label: "waiting for input", isWorking: false, indicatorClassName: "bg-cyan-400", badgeClassName: "bg-cyan-500/15 text-cyan-400" };
  }
  return { label: "idle", isWorking: false, indicatorClassName: "bg-green-500", badgeClassName: "bg-green-500/15 text-green-500" };
}
