/**
 * Pierre's MultiFileDiff caches parsed diffs by FileContents.cacheKey,
 * defaulting to file name only. Refresh remounts FileBlock but keeps the
 * worker pool, so a name-only key shows the first parse until a full reload.
 */

function djb2(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Cache key that changes when file contents change. */
export function pierreFileCacheKey(name: string, contents: string): string {
  return `${name}:${djb2(contents).toString(16)}:${contents.length}`;
}
