/**
 * Shared secret-detection patterns and env-var filters.
 *
 * Plain ESM JavaScript so both TypeScript extensions (`secret-obfuscation.ts`)
 * and standalone Node scripts (`scripts/diagnostic-report-collect.mjs`) consume
 * one authoritative set of credential rules with zero drift.
 */

/** Minimum character length required for literal secret matching. */
export const MIN_SECRET_LENGTH = 8;

/** Match whole `_`-delimited env-var tokens so GIT_AUTHOR_* and *_ASKPASS are never misclassified. */
export const SECRET_ENV_NAME_RE =
  /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIALS?|PRIVATE|OAUTH)(?:_|$)/i;

/** Well-known non-secret identity, askpass, socket, and keymap env vars. */
export const IGNORED_ENV_NAMES = new Set([
  "SSH_AUTH_SOCK",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "KEYMAP",
  "LESSKEY",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

/** Return true when `name` is a known non-secret environment variable. */
export function isIgnoredEnvName(name) {
  return (
    IGNORED_ENV_NAMES.has(name) ||
    name.startsWith("GIT_AUTHOR_") ||
    name.startsWith("GIT_COMMITTER_")
  );
}

/** Extract embedded passwords from URL credentials. */
export const URL_CREDENTIAL_EXTRACT_RE =
  /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]{8,})@[^\s"'`<>]+/g;

/** Built-in credential regex rules shared by secret obfuscation and diagnostic log redaction. */
export const BUILTIN_CREDENTIAL_RULES = [
  {
    label: "PEMKEY",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    label: "ANTHROPICKEY",
    regex: /\bsk-ant-(?:api\d+-|admin\d+-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    label: "OPENAIKEY",
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    label: "GHTOKEN",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    label: "GLTOKEN",
    regex: /\b(?:glpat|gloas|glrt)-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: "AWSKEY",
    regex: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g,
  },
  {
    label: "GOOGLEKEY",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    label: "SLACKTOKEN",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    label: "NPMTOKEN",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    label: "STRIPEKEY",
    regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  },
  {
    label: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    label: "BEARER",
    regex: /(\bBearer[ \t]+)([A-Za-z0-9._~+/=-]{16,})/gi,
    secretGroup: 2,
  },
  {
    label: "URLPASS",
    regex: /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]{8,})(@)/g,
    secretGroup: 2,
  },
];
