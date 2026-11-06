/**
 * Temp dirs for tests: created under the OS temp dir and removed when the file's tests end.
 *
 * A test that calls `mkdtempSync` on its own leaves the directory behind — the node:test runner
 * only removes what it created, and a crashed run leaves everything. The observed cost was
 * `/tmp/review-learning-pr-*` piling up until the runner could not create a numbered dir any more.
 *
 * Usage:
 *
 *   import { after } from "node:test";
 *   import { makeTempDir, removeTempDirs } from "../../helpers/temp-dirs.js";
 *
 *   after(removeTempDirs);
 *   const cwd = makeTempDir("my-feature-");
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const created: string[] = [];

/** Create a throwaway dir that `removeTempDirs` will delete. */
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Remove every dir `makeTempDir` created. Safe to call more than once. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a test may have removed it already */
    }
  }
}
