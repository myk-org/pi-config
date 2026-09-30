/**
 * One-time MCP config migration (#848).
 *
 * MCP used to be reached through the external `mcpc` binary, which read
 * `~/.pi/pi-config/mcp.json`. It is now pi's built-in `builtin:mcp`, which reads
 * `~/.pi/agent/mcp.json`. Without this, an existing install upgrades to a pi
 * that finds no MCP config at all — every server silently disappears, with no
 * error anywhere to look at.
 *
 * Deliberately a copy, not a move, and only when the new file is absent: the
 * old file stays as the user's to delete, and an existing `~/.pi/agent/mcp.json`
 * is never touched. Nothing is written when either file is missing.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("mcp-config-migration");

/** Where `mcpc` kept servers, and where `builtin:mcp` reads them from. */
export function mcpConfigPaths(home: string = homedir()): { legacy: string; current: string } {
  return {
    legacy: join(home, ".pi", "pi-config", "mcp.json"),
    current: join(home, ".pi", "agent", "mcp.json"),
  };
}

/**
 * Copy the legacy config into place when it is safe to do so.
 * Returns the path written, or undefined when nothing was done.
 */
export function migrateMcpConfig(home: string = homedir()): string | undefined {
  const { legacy, current } = mcpConfigPaths(home);
  if (existsSync(current)) {
    log.debug("mcp config present, nothing to do", { path: current });
    return undefined;
  }
  if (!existsSync(legacy)) {
    log.debug("no legacy mcp config", { path: legacy });
    return undefined;
  }
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    copyFileSync(legacy, current);
    log.info("migrated MCP config for builtin:mcp", { from: legacy, to: current });
    return current;
  } catch (error) {
    // A failed migration must not stop pi from starting — worst case the user
    // copies the file by hand, which the message tells them how to do.
    log.warn("MCP config migration failed; copy it by hand", {
      from: legacy,
      to: current,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
