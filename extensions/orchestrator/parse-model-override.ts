/** Parse 'provider/model-id' into separate provider and model. Plain 'model-id' returns undefined provider. */
export function parseModelOverride(modelStr: string | undefined): { model?: string; provider?: string } | undefined {
  if (!modelStr) return undefined;
  const trimmed = modelStr.trim();
  if (!trimmed) return undefined;
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0) {
    const provider = trimmed.slice(0, slashIdx).trim();
    const model = trimmed.slice(slashIdx + 1).trim();
    if (!provider || !model) return undefined;
    return { provider, model };
  }
  return { model: trimmed };
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
