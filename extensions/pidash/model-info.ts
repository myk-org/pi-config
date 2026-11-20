import { modelInfoPayload } from "../../scripts/pidash-session-state.ts";

export function pidashModelInfo(model: any): { model: string; contextWindow: number; reasoning: boolean } {
  const { model: name, contextWindow, reasoning } = modelInfoPayload(model);
  return { model: name, contextWindow, reasoning };
}
