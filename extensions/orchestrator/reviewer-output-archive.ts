/** Durable reviewer-output archival and bounded retention. */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("async_agents");

export const REVIEWER_ARCHIVE_RETENTION = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxFiles: 100,
  maxBytes: 50 * 1024 * 1024,
};

type Retention = typeof REVIEWER_ARCHIVE_RETENTION;

/** Copy reviewer output into a durable owner-only archive. */
export function archiveReviewerOutput(outputPath: string, archivePath: string): void {
  fs.chmodSync(outputPath, 0o600);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(outputPath, archivePath);
  fs.chmodSync(archivePath, 0o600);
  cleanupReviewerOutputArchives(path.dirname(archivePath));
  log.info("archived_reviewer_output", { outputPath: archivePath });
}

/** Remove expired and oldest regular-file archives while preserving bounded storage. */
export function cleanupReviewerOutputArchives(
  archiveDir: string,
  retention: Retention = REVIEWER_ARCHIVE_RETENTION,
): void {
  let archives: Array<{ path: string; mtimeMs: number; size: number }>;
  try {
    archives = fs.readdirSync(archiveDir).flatMap((entry) => {
      const archivePath = path.join(archiveDir, entry);
      try {
        const stat = fs.lstatSync(archivePath);
        return stat.isFile() ? [{ path: archivePath, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
      } catch {
        return [];
      }
    });
  } catch (error: any) {
    if (error?.code !== "ENOENT") log.warn("reviewer_archive_cleanup_scan_failed", { archiveDir, error: error?.message });
    return;
  }

  const now = Date.now();
  const retained = archives
    .filter((archive) => {
      if (now - archive.mtimeMs <= retention.maxAgeMs) return true;
      try { fs.unlinkSync(archive.path); } catch (error: any) { log.warn("reviewer_archive_expiry_delete_failed", { archivePath: archive.path, error: error?.message }); return true; }
      return false;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  let totalBytes = retained.reduce((total, archive) => total + archive.size, 0);
  for (let index = retained.length - 1; index >= 0; index--) {
    const archive = retained[index];
    if (index < retention.maxFiles && totalBytes <= retention.maxBytes) continue;
    try {
      fs.unlinkSync(archive.path);
      totalBytes -= archive.size;
    } catch (error: any) {
      log.warn("reviewer_archive_retention_delete_failed", { archivePath: archive.path, error: error?.message });
    }
  }
  log.debug("reviewer_archive_cleanup_complete", { archiveDir, retainedFiles: retained.length, totalBytes });
}
