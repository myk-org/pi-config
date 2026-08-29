import { createLogger } from "../shared/logger.ts";

const log = createLogger("pidash");

export type SessionActivity = "working" | "waiting_for_input" | "idle";

export interface ActivityState {
  activity: SessionActivity;
  streaming: boolean;
  sequence: number;
  activityBeforePrompt?: SessionActivity;
}

export interface ActivityEvent {
  type: string;
  sequence: number;
}

export function initialActivityState(): ActivityState {
  return { activity: "idle", streaming: false, sequence: 0 };
}

export function shouldAcceptActivityEvent(state: ActivityState, event: ActivityEvent): boolean {
  return event.sequence > state.sequence;
}

export function applyActivityEvent(state: ActivityState, event: ActivityEvent): ActivityState {
  if (!shouldAcceptActivityEvent(state, event)) {
    log.debug(`activity event rejected: type=${event.type} sequence=${event.sequence} current=${state.sequence}`);
    return state;
  }
  log.debug(`activity event applied: type=${event.type} sequence=${event.sequence} activity=${state.activity}`);
  switch (event.type) {
    case "agent_start":
      return { activity: "working", streaming: true, sequence: event.sequence };
    case "agent_settled":
      return { ...state, streaming: false, sequence: event.sequence };
    case "agent_end":
      return { activity: "idle", streaming: false, sequence: event.sequence };
    case "ui_prompt_start":
      return {
        ...state,
        activity: "waiting_for_input",
        activityBeforePrompt: state.activity,
        sequence: event.sequence,
      };
    case "ui_prompt_end": {
      const { activityBeforePrompt, ...next } = state;
      return {
        ...next,
        activity: activityBeforePrompt ?? "working",
        sequence: event.sequence,
      };
    }
    default:
      return { ...state, sequence: event.sequence };
  }
}
