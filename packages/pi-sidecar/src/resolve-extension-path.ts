/**
 * Extension path resolution — single source of truth.
 *
 * Used by sessions.ts at runtime and by tests for validation.
 * Logging is handled by the caller (sessions.ts) to avoid coupling
 * this module to the logger.
 */

import { accessSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface ResolveResult {
  path: string;
  error?: string;
}

export function resolveExtensionPath(envVar: string, packageName: string, entryFile: string): string {
  const result = resolveExtensionPathDetailed(envVar, packageName, entryFile);
  return result.path;
}

export function resolveExtensionPathDetailed(envVar: string, packageName: string, entryFile: string): ResolveResult {
  const envPath = process.env[envVar];
  if (envPath) {
    return { path: isAbsolute(envPath) ? envPath : resolve(envPath) };
  }
  try {
    // resolve() finds the package wherever npm installed it (hoisted or nested)
    const pkgJson = require.resolve(`${packageName}/package.json`);
    return { path: join(dirname(pkgJson), entryFile) };
  } catch (primaryErr) {
    // Fallback for ESM-only packages with strict "exports" that block /package.json.
    // Use require.resolve.paths() to get node_modules search dirs, then walk them
    // to find the package root without triggering exports validation.
    try {
      const searchPaths = require.resolve.paths(packageName);
      if (searchPaths) {
        for (const searchDir of searchPaths) {
          const candidate = join(searchDir, packageName, "package.json");
          try {
            accessSync(candidate);
            return { path: join(dirname(candidate), entryFile) };
          } catch {
            // not in this search dir, continue
          }
        }
      }
    } catch {
      // fallback exhausted
    }
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    return { path: "", error: `Could not resolve ${packageName}: ${errMsg}` };
  }
}
