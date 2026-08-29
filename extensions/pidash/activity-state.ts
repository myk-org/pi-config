export type SessionActivity = "working" | "waiting_for_input" | "idle";

export interface ActivityState {
  activity: SessionActivity;
  streaming: boolean;
  sequence: number;
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
  if (!shouldAcceptActivityEvent(state, event)) return state;
  switch (event.type) {
    case "agent_start":
      return { activity: "working", streaming: true, sequence: event.sequence };
    case "agent_settled":
      return { ...state, streaming: false, sequence: event.sequence };
    case "agent_end":
      return { activity: "idle", streaming: false, sequence: event.sequence };
    case "ui_prompt_start":
      return { ...state, activity: "waiting_for_input", sequence: event.sequence };
    case "ui_prompt_end":
      return { ...state, activity: "working", sequence: event.sequence };
    default:
      return { ...state, sequence: event.sequence };
  }
}
