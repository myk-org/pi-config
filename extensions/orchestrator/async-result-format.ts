/** Format async-agent output for bounded delivery and status persistence. */

const MAX_OUTPUT_CHARS = 3000;

/**
 * Preserve valid reviewer JSON unless it exceeds the delivery budget.
 * Oversized reviewer output is available only in its worker output.log.
 */
export function formatAsyncResultOutput(
  agent: string,
  output: string,
  outputPath: string,
  maxChars = MAX_OUTPUT_CHARS,
): string {
  if (agent.startsWith("code-reviewer-") && output.length > maxChars) {
    try {
      JSON.parse(output);
      return JSON.stringify({
        truncated: true,
        format: "json",
        outputBytes: Buffer.byteLength(output, "utf8"),
        outputPath,
      });
    } catch {
      // Invalid reviewer output retains ordinary bounded-text behavior.
    }
  }
  return output.slice(0, maxChars);
}
