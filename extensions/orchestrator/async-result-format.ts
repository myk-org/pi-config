/** Format async-agent output for bounded delivery and status persistence. */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("async_agents");
const MAX_OUTPUT_CHARS = 3000;

/** Return the completed-result archive path, outside cleanup-prone worker directories. */
export function reviewerOutputArchivePath(projectTmpDir: string, jobId: string): string {
  const archiveDir = path.resolve(projectTmpDir, "reviewer-results");
  const filename = `${createHash("sha256").update(jobId).digest("hex")}.json`;
  const archivePath = path.resolve(archiveDir, filename);
  if (path.dirname(archivePath) !== archiveDir) {
    throw new Error("Reviewer archive destination escapes its archive root");
  }
  log.debug("reviewer_output_archive_path", { jobId, archivePath });
  return archivePath;
}

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
  log.debug("format_async_result_output", { agent, outputChars: output.length, maxChars });
  if (agent.startsWith("code-reviewer-") && output.length > maxChars) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.findings)) {
        const metadata = {
          truncated: true,
          format: "json",
          outputBytes: Buffer.byteLength(output, "utf8"),
          outputPath,
        };
        const serialized = JSON.stringify(metadata);
        if (serialized.length <= maxChars) return serialized;
        log.warn("reviewer_metadata_path_exceeds_budget", { agent, maxChars });
        return JSON.stringify({
          truncated: true,
          format: "json",
          outputBytes: metadata.outputBytes,
          outputPathOmitted: true,
        });
      }
    } catch {
      // Invalid reviewer output retains ordinary bounded-text behavior.
    }
  }
  return output.slice(0, maxChars);
}
