/**
 * Pierre's MultiFileDiff caches parsed diffs by FileContents.cacheKey,
 * defaulting to file name only. Refresh remounts FileBlock but keeps the
 * worker pool, so a name-only key shows the first parse until a full reload.
 */

import { createLogger } from "./create-logger.ts";

const log = createLogger("pidiff-ui");

/** 53-bit string hash (cyrb53). Two seeds avoid djb2 collisions like Aa vs BB. */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  log.debug("cyrb53", { seed, len: str.length });
  return hash;
}

/** Cache key that changes when file contents change. */
export function pierreFileCacheKey(name: string, contents: string): string {
  const key = `${name}:${cyrb53(contents, 0).toString(16)}:${cyrb53(contents, 1).toString(16)}:${contents.length}`;
  log.debug("pierreFileCacheKey", name, key.length);
  return key;
}
