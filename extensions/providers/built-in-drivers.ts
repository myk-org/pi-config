/**
 * BUILT_IN_DRIVERS — the static set of ProviderDrivers this build ships with.
 *
 * Adapted from t3code's `builtInDrivers.ts`. Every driver that the server
 * knows how to instantiate from settings is listed here. The registry
 * iterates this array when resolving provider instances; anything not in
 * the array surfaces as an "unavailable" shadow snapshot.
 *
 * Adding a new first-party driver means:
 *   1. Implement `ProviderDriver` in a sibling `<Name>Driver.ts`
 *   2. Add it to this array
 *   3. Update the unified extension entry to register it
 *
 * @module providers/built-in-drivers
 */

import type { AnyProviderDriver } from "../shared/provider-driver.js";
import { ClaudeDriver } from "./claude-driver.js";
import { GeminiDriver } from "./gemini-driver.js";
import { CursorCliDriver } from "./cursor-cli-driver.js";
import { AcpxDriver } from "./acpx-driver.js";

/**
 * Ordered list of built-in drivers. Order matters only for tie-breaking
 * in UI presentation — the registry itself is keyed by `driverKind`, so
 * iteration order has no functional effect on instance lookup.
 */
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ClaudeDriver,
  GeminiDriver,
  CursorCliDriver,
  AcpxDriver,
];

/**
 * Map from setting agent name → driver kind(s).
 *
 * Settings use agent names like "cursor", "claude", "gemini".
 * Drivers use kinds like "cursor-cli", "acpx", "claude-cli".
 * This map resolves the mapping.
 */
export const CLI_AGENT_TO_DRIVER: Record<string, string> = {
  claude: "claude-cli",
  gemini: "gemini-cli",
  cursor: "cursor-cli",
};

export const ACPX_AGENT_TO_DRIVER: Record<string, string> = {
  cursor: "acpx",
  claude: "acpx",
  gemini: "acpx",
};
