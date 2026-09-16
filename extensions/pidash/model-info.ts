export function pidashModelInfo(model: any): { model: string; contextWindow: number; reasoning: boolean } {
  return {
    model: model?.name || model?.id || "",
    contextWindow: model?.contextWindow || 0,
    reasoning: model?.reasoning === true,
  };
}
