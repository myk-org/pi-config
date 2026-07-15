/**
 * Shared helper for waiting on async result files.
 * Extracted so it can be tested without loading the full async-agents module.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Wait up to deadlineMs for result files to appear.
 * Uses a single group-level deadline (not per-file).
 */
export async function waitForResultFiles(
  resultDir: string,
  jobIds: string[],
  deadlineMs: number,
): Promise<Set<string>> {
  const found = new Set<string>();
  const deadline = Date.now() + deadlineMs;
  // Always scan at least once (handles deadlineMs=0)
  do {
    let allFound = true;
    for (const id of jobIds) {
      if (found.has(id)) continue;
      if (existsSync(join(resultDir, `${id}.json`))) {
        found.add(id);
      } else {
        allFound = false;
      }
    }
    if (allFound) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(250, remaining)));
  } while (Date.now() < deadline);
  return found;
}
