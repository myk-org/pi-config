/** Parse 'provider/model-id' into separate provider and model. Plain 'model-id' returns undefined provider. */
export function parseModelOverride(modelStr: string | undefined): { model?: string; provider?: string } | undefined {
  if (!modelStr) return undefined;
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    return { provider: modelStr.slice(0, slashIdx), model: modelStr.slice(slashIdx + 1) };
  }
  return { model: modelStr };
}

/** Merge task-level model override with top-level explicit fallback. Task fields win. */
export function mergeModelOverride(
  taskModel: string | undefined,
  explicit: { model?: string; provider?: string } | undefined,
): { model?: string; provider?: string } | undefined {
  const taskParsed = parseModelOverride(taskModel);
  if (taskParsed) {
    return {
      model: taskParsed.model || explicit?.model,
      provider: taskParsed.provider || explicit?.provider,
    };
  }
  return explicit;
}
