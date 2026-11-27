/**
 * Type declarations for pi-agent-dir-parser.mjs.
 */

export interface ExtractAgentDirOptions {
  /** Option flags whose next argv token is consumed as their value and skipped. */
  valueFlags?: ReadonlySet<string>;
}

export declare const PI_VALUE_TAKING_FLAGS: ReadonlySet<string>;
export declare function expandTilde(value: string): string;
export declare function normalizeAgentDir(value: string): string;
export declare function extractAgentDirFromArgv(
  argv?: readonly string[],
  options?: ExtractAgentDirOptions,
): string | undefined;
