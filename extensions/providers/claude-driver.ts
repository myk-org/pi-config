/**
 * ClaudeDriver — ProviderDriver for the Claude Code CLI agent.
 *
 * @module providers/claude-driver
 */

import type { ProviderDriver } from "../shared/provider-driver.js";
import { createLogger } from "../shared/logger.js";
import {
  createCliDriver,
  createSimpleCliAdapter,
  type CliDriverConfig,
  type SimpleCliAdapterShape,
} from "./cli-driver-shared.js";

const log = createLogger("claude-driver");

export type ClaudeCliConfig = CliDriverConfig;

export function createClaudeAdapter(
  config: ClaudeCliConfig,
  cwd: string,
  instanceId: string,
): SimpleCliAdapterShape {
  return createSimpleCliAdapter({
    agent: "claude",
    config,
    cwd,
    instanceId,
    log,
  });
}

export const ClaudeDriver: ProviderDriver<ClaudeCliConfig> = createCliDriver({
  agent: "claude",
  driverKind: "claude-cli",
  defaultBinary: "claude",
  defaultDisplayName: "Claude CLI",
  log,
  createAdapter: createClaudeAdapter,
});
