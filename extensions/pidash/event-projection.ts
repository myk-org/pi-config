import { createLogger } from "../shared/logger.js";

const log = createLogger("pidash");

export function projectTurnEndEvent(event: any, timestamp: number) {
  log.debug("projecting turn_end event", { turnIndex: event.turnIndex });
  return {
    type: "turn_end",
    turnIndex: event.turnIndex,
    outcome: event.outcome,
    messageEntryId: event.messageEntryId,
    message: {
      role: event.message?.role,
      model: event.message?.model,
      usage: event.message?.usage,
    },
    timestamp,
  };
}
