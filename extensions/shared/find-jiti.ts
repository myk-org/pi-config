/**
 * Locate jiti-cli.mjs for spawning TypeScript daemons (pidash/pidiff).
 *
 * npm installs live under node_modules; Node 22 refuses to strip types there
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Bare `node file.ts` is not a
 * valid fallback. Walk from pi's real binary, same as async-agents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";

const log = createLogger("daemon-manager");

const JITI_CLI = path.join("node_modules", "jiti", "lib", "jiti-cli.mjs");

/** Walk parents of startDir looking for node_modules/jiti/lib/jiti-cli.mjs. */
export function findJitiUnder(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, JITI_CLI);
    if (fs.existsSync(candidate)) {
      log.debug("jiti HIT %s", candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  log.debug("jiti exhausted from %s", startDir);
  return undefined;
}

/**
 * Resolve jiti for the running pi process.
 * Optional roots are for tests; production uses argv[1] + this module.
 */
export function findJitiPath(roots?: { argv1?: string; moduleDir?: string }): string | undefined {
  const argv1 = roots?.argv1 ?? process.argv[1];
  const moduleDir = roots?.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));

  if (argv1) {
    try {
      const piRoot = path.dirname(fs.realpathSync(argv1));
      const hit = findJitiUnder(piRoot);
      if (hit) {
        log.debug("jiti from argv-binary %s", hit);
        return hit;
      }
    } catch (e: any) {
      log.debug("jiti strategy argv-binary failed: %s", e?.message || e);
    }
    try {
      const req = createRequire(path.resolve(argv1));
      const pkg = req.resolve("jiti/package.json");
      const cli = path.join(path.dirname(pkg), "lib", "jiti-cli.mjs");
      if (fs.existsSync(cli)) {
        log.debug("jiti from argv require %s", cli);
        return cli;
      }
    } catch (e: any) {
      log.debug("jiti strategy argv-require failed: %s", e?.message || e);
    }
  }

  try {
    const req = createRequire(fileURLToPath(import.meta.url));
    let sdkPkgJson: string | undefined;
    try {
      sdkPkgJson = req.resolve("@earendil-works/pi-coding-agent/package.json");
    } catch {
      let dir = path.dirname(req.resolve("@earendil-works/pi-coding-agent"));
      while (dir !== path.dirname(dir)) {
        const pj = path.join(dir, "package.json");
        if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8"))?.name === "@earendil-works/pi-coding-agent") {
          sdkPkgJson = pj;
          break;
        }
        dir = path.dirname(dir);
      }
    }
    if (sdkPkgJson) {
      const hit = findJitiUnder(path.dirname(sdkPkgJson));
      if (hit) {
        log.debug("jiti from sdk-pkg %s", hit);
        return hit;
      }
    }
  } catch (e: any) {
    log.debug("jiti strategy sdk-pkg failed: %s", e?.message || e);
  }

  const fromModule = findJitiUnder(moduleDir);
  if (fromModule) {
    log.debug("jiti from module dir %s", fromModule);
    return fromModule;
  }

  log.warn("jiti-cli.mjs not found — cannot spawn TypeScript daemons under node_modules");
  return undefined;
}
