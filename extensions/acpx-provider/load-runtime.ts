/**
 * Load acpx/runtime from the global npm install (entrypoint: npm install -g acpx).
 * Package-local node_modules is not the source of truth.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

/** Minimal surface used by acpx-provider (avoids depending on package-local acpx). */
export type AcpxRuntimeModule = {
  createAcpRuntime: (...args: any[]) => any;
  createFileSessionStore: (...args: any[]) => any;
  createAgentRegistry: (...args: any[]) => any;
};

function globalNodeModuleRoots(): string[] {
  const roots: string[] = [];
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    if (root) roots.push(root);
  } catch {
    /* ignore */
  }
  for (const candidate of [
    "/usr/local/lib/node_modules",
    join(homedir(), ".npm-global", "lib", "node_modules"),
  ]) {
    if (candidate && !roots.includes(candidate)) roots.push(candidate);
  }
  return roots;
}

async function importFromPackageRoot(pkgRoot: string): Promise<AcpxRuntimeModule | null> {
  const runtimeJs = join(pkgRoot, "dist", "runtime.js");
  if (existsSync(runtimeJs)) {
    return (await import(pathToFileURL(runtimeJs).href)) as AcpxRuntimeModule;
  }
  const pkgJson = join(pkgRoot, "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const req = createRequire(pkgJson);
    const resolved = req.resolve("./dist/runtime.js");
    return (await import(pathToFileURL(resolved).href)) as AcpxRuntimeModule;
  } catch {
    return null;
  }
}

/**
 * Resolve acpx/runtime: global install first, then bare import (dev only).
 */
export async function loadAcpxRuntime(): Promise<AcpxRuntimeModule> {
  for (const root of globalNodeModuleRoots()) {
    const mod = await importFromPackageRoot(join(root, "acpx"));
    if (typeof mod?.createAcpRuntime === "function") return mod;
  }

  try {
    const mod = (await import("acpx/runtime")) as AcpxRuntimeModule;
    if (typeof mod?.createAcpRuntime === "function") return mod;
  } catch {
    /* ignore */
  }

  throw new Error(
    "acpx is not installed globally. Install with: npm install -g acpx",
  );
}
