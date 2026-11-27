/**
 * Type declarations for secret-patterns.mjs.
 */

export interface BuiltinCredentialRule {
  label: string;
  regex: RegExp;
  /** When set, only this capture group is replaced (e.g. Bearer token or URL password). */
  secretGroup?: number;
}

export declare const MIN_SECRET_LENGTH: number;
export declare const SECRET_ENV_NAME_RE: RegExp;
export declare const IGNORED_ENV_NAMES: ReadonlySet<string>;
export declare function isIgnoredEnvName(name: string): boolean;
export declare const URL_CREDENTIAL_EXTRACT_RE: RegExp;
export declare const BUILTIN_CREDENTIAL_RULES: readonly BuiltinCredentialRule[];
