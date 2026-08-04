/**
 * Pure placeholder substitution for rules/*.md and agent system-prompt text.
 *
 * Kept in its own module (no heavy imports) so it can be unit tested without
 * pulling in the full orchestrator dependency chain (e.g. rules.ts → async-agents.ts
 * → @earendil-works/pi-tui, which is a runtime-only dependency not present in
 * the test install). Callers pass a resolve function for settings lookups.
 */

export function substituteRulePlaceholders(text: string, values: { reviewLoopMaxCycles: number }): string {
  return text.replaceAll("{{REVIEW_LOOP_MAX_CYCLES}}", String(values.reviewLoopMaxCycles));
}

const SETTINGS_PATTERN = /\{\{SETTINGS(?::([^}]+))?\}\}/g;

/**
 * Replace `{{SETTINGS:key1,key2,...}}` with JSON of resolved setting values.
 * `{{SETTINGS}}` (no colon) resolves every key in `allKeys`.
 */
export function substituteSettingsPlaceholders(
  text: string,
  resolve: (key: string) => unknown,
  allKeys: string[],
): string {
  return text.replace(new RegExp(SETTINGS_PATTERN.source, "g"), (_match, keysGroup: string | undefined) => {
    const keys = keysGroup !== undefined
      ? keysGroup.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
      : allKeys;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = resolve(key);
    }
    return JSON.stringify(result);
  });
}
