/**
 * Pure placeholder substitution for rules/*.md prompt text.
 *
 * Kept in its own module (no heavy imports) so it can be unit tested without
 * pulling in the full orchestrator dependency chain (e.g. rules.ts → async-agents.ts
 * → @earendil-works/pi-tui, which is a runtime-only dependency not present in
 * the test install).
 */

export function substituteRulePlaceholders(text: string, values: { reviewLoopMaxCycles: number }): string {
  return text.replaceAll("{{REVIEW_LOOP_MAX_CYCLES}}", String(values.reviewLoopMaxCycles));
}
