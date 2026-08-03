import { spawnSync } from "node:child_process";

/** Snapshot git working tree state for dirty detection. Returns shortstat string. */
export function gitDirtySnapshot(cwd: string): string {
  try {
    const result = spawnSync("git", ["diff", "--shortstat"], {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.stdout || "";
  } catch {
    return "";
  }
}
