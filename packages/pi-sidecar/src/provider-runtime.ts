import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type LoadExtensionsResult,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Model, Provider } from "@earendil-works/pi-ai";
import stripJsonComments from "strip-json-comments";

import { createLogger, logger } from "./logger.js";
import { readBoundedResponseBytes, sanitizeUrlForLog } from "./http-helpers.js";
import { createHttpToolExecutor, normalizeHttpToolConfig } from "./http-tool-executor.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const runtimeLog = createLogger("provider-runtime");
const redactorLog = createLogger("api-key-redactor");
const redactApiKeyLog = createLogger("redact-api-key");
const httpErrorLog = createLogger("http-error");
const keyModelDiscoveryLog = createLogger("key-model-discovery");
const authErrorFramesLog = createLogger("auth-error-frames");
const apiKeyValidationLog = createLogger("api-key-validation");
const sessionSettingsLog = createLogger("session-settings");
const agentDirLog = createLogger("agent-dir");
const legacyAmbientProvidersLog = createLogger("legacy-ambient-providers");
const internalRuntimeFactoryLog = createLogger("internal-runtime-factory");
const internalRuntimeExtensionsLog = createLogger("internal-runtime-extensions");
const internalRuntimeDiagnosticsLog = createLogger("internal-runtime-diagnostics");
const providerDiscoveryLog = createLogger("provider-discovery");
const sessionKeyCapabilityLog = createLogger("session-key-capability");
const providerStatusLog = createLogger("provider-status");
const sessionCreateLog = createLogger("session-create");

const isRedactorDebug = process.env.PI_SIDECAR_LOG_LEVEL?.toLowerCase().trim() === "debug";
const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });
const SESSION_API_KEY_RUNTIME_METHODS = new Set<PropertyKey>([
  "stream",
  "streamSimple",
  "complete",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
]);

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Error with HTTP status for the sidecar request handler. */
export type HttpError = Error & { statusCode: number };

export function httpError(message: string, statusCode: number, cause?: unknown): HttpError {
  httpErrorLog.debug(`Creating HTTP error: status=${statusCode}, hasCause=${cause !== undefined}`);
  const err = new Error(message, { cause }) as HttpError;
  err.statusCode = statusCode;
  return err;
}

const MAX_API_KEY_LENGTH = 1024;
const MAX_DIAGNOSTIC_LENGTH = 16_384;
const MAX_KEY_DECODE_DEPTH = 32;

/** Reject credentials at any encoding depth, including the last permitted decode. */
export function isKeyFree(value: string, redact: (value: string) => string): boolean {
  for (let depth = 0; depth <= MAX_KEY_DECODE_DEPTH; depth++) {
    if (redact(value) !== value) {
      keyModelDiscoveryLog.debug("Discovery value contains credential", { depth });
      return false;
    }
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch {
      keyModelDiscoveryLog.debug("Discovery value cannot be decoded safely", { depth });
      return !value.includes("%");
    }
    if (decoded === value) return true;
    value = decoded;
  }
  keyModelDiscoveryLog.debug("Discovery value exceeds decode bound", { depth: MAX_KEY_DECODE_DEPTH });
  return false;
}

/** Oversized diagnostics are omitted, not truncated: a truncated prefix can contain a partial key. */
export function redactDiagnostic(value: string, redact: (value: string) => string): string {
  return value.length > MAX_DIAGNOSTIC_LENGTH ? "[oversized diagnostic omitted]" : redact(value);
}

function safeErrorFrames(err: unknown): string[] | undefined {
  try {
    const stack = err instanceof Error ? err.stack : undefined;
    if (typeof stack !== "string") {
      authErrorFramesLog.debug("Auth error has no readable stack");
      return undefined;
    }
    const frames = stack.split("\n").slice(1, 9).map((line) => /^\s*at ([\w.$<>]+)\s*\(/.exec(line)?.[1] ?? "[anonymous]");
    authErrorFramesLog.debug("Sanitized auth error frames", { frameCount: frames.length });
    return frames;
  } catch {
    authErrorFramesLog.debug("Auth error stack getter failed");
    return undefined;
  }
}

export function isValidApiKey(value: unknown): value is string {
  const valid = typeof value === "string" && value.length <= MAX_API_KEY_LENGTH && value.trim().length > 0
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  apiKeyValidationLog.debug(`API key validation: valid=${valid}, lengthWithinLimit=${typeof value === "string" && value.length <= MAX_API_KEY_LENGTH}`);
  return valid;
}

/**
 * Longest source form each redactor can match, so a delta holdback is derived
 * from the secret itself instead of guessing a constant. `literal` is the key
 * as written, `escaped` is the widest form `redact` still recognizes (see
 * `keySourceForms`). A WeakMap keeps these off the function object and out of
 * every type that passes a redactor around; a redactor built without a key (or
 * any other function) reports 0.
 */
const redactorForms = new WeakMap<(value: string) => string, { literal: number; escaped: number }>();

/**
 * Every source form the redactor's two decode stages (JSON escapes, then
 * percent escapes) turn back into the key, widest last. A boundary can cut any
 * of them, and the escaped ones are LONGER than the key — `ab` also matches as
 * `%61%62` and as `\u0025\u0036\u0031\u0025\u0036\u0032` — so the holdback
 * has to come from the longest of these, not from the raw key's length.
 */
function keySourceForms(apiKey: string): string[] {
  const percent = [...Buffer.from(apiKey, "utf8")].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  // `\uXXXX` per UTF-16 code unit: the JSON stage accepts that for any character.
  const jsonEscaped = (value: string) =>
    Array.from({ length: value.length }, (_, i) => `\\u${value.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
  return [apiKey, jsonEscaped(apiKey), percent, jsonEscaped(percent)];
}

/**
 * How far a streamed delta may lag so a key split across two deltas is still
 * redacted as a whole: one character less than the widest form the redactor
 * matches. 0 when the redactor holds no key — then nothing needs holding back
 * and deltas are emitted immediately.
 */
export function redactorHoldback(redact: (value: string) => string): number {
  return Math.max(0, (redactorForms.get(redact)?.escaped ?? 0) - 1);
}

/**
 * Holdback for text that cannot be inside an escaped form (it holds no `%` and
 * no `\`): the key itself, one character less than its length. Escaped forms
 * are only wider, so a caller that can rule them out keeps deltas flowing
 * instead of lagging by the escaped bound.
 */
export function redactorLiteralHoldback(redact: (value: string) => string): number {
  return Math.max(0, (redactorForms.get(redact)?.literal ?? 0) - 1);
}

/** Compile key representations once per session, never per log or response. */
export function createApiKeyRedactor(apiKey?: string): (value: string) => string {
  if (isRedactorDebug) redactorLog.debug(`Creating API key redactor: hasKey=${Boolean(apiKey)}`);
  if (!apiKey) return (value) => value;
  if (apiKey.length > MAX_API_KEY_LENGTH) throw new RangeError("API key exceeds maximum length");
  const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  const redact = (value: string): string => {
    if (isRedactorDebug) redactorLog.debug(`Redacting API key: inputLength=${value.length}, hasKey=true`);
    if (!value.includes("\\") && !value.includes("%")) return value.replaceAll(apiKey, "[REDACTED]");
    const parts: string[] = [];
    // One key unit expands to at most 8 source units (JSON-escaped percent byte),
    // with up to four UTF-8 bytes per code point. Keep a full match's lookahead.
    const overlap = apiKey.length * 32 + 8;
    const chunkSize = 16_384;
    let cursor = 0;
    while (cursor < value.length) {
      const cut = Math.min(cursor + chunkSize, value.length);
      const raw = value.slice(cursor, Math.min(cut + overlap, value.length));
      const matches: Array<[number, number]> = [];
      for (let at = raw.indexOf(apiKey); at !== -1; at = raw.indexOf(apiKey, at + apiKey.length)) {
        matches.push([at, at + apiKey.length]);
      }
      const hasBackslash = raw.includes("\\");
      if (hasBackslash || raw.includes("%")) {
        let decoded: string;
        let starts: number[] | undefined;
        let ends: number[] | undefined;
        if (hasBackslash) {
          decoded = "";
          starts = [];
          ends = [];
          for (let i = 0; i < raw.length;) {
            const start = i;
            let char = raw[i++];
            if (char === "\\" && i < raw.length) {
              const next = raw[i];
              if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
                char = String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
                i += 5;
              } else if (Object.hasOwn(escapes, next)) {
                char = escapes[next];
                i++;
              }
            }
            decoded += char;
            starts.push(start);
            ends.push(i);
          }
        } else {
          decoded = raw;
        }
        if (!decoded.includes("%")) {
          // Only reachable when hasBackslash was true (since !hasBackslash && !raw.includes("%") skips this branch).
          for (let at = decoded.indexOf(apiKey); at !== -1; at = decoded.indexOf(apiKey, at + apiKey.length)) {
            matches.push([starts![at], ends![at + apiKey.length - 1]]);
          }
        } else {
          let text = "";
          const percentStarts: number[] = [];
          const percentEnds: number[] = [];
          for (let i = 0; i < decoded.length;) {
            let char = decoded[i];
            let end = i + 1;
            if (char === "%" && /^%[0-9a-fA-F]{2}$/.test(decoded.slice(i, i + 3))) {
              const lead = parseInt(decoded.slice(i + 1, i + 3), 16);
              const count = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2
                : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
              let valid = count > 0 && i + count * 3 <= decoded.length;
              for (let byte = 1; valid && byte < count; byte++) {
                const offset = i + byte * 3;
                if (!/^%[0-9a-fA-F]{2}$/.test(decoded.slice(offset, offset + 3))) { valid = false; break; }
                const continuation = parseInt(decoded.slice(offset + 1, offset + 3), 16);
                valid = continuation >= 0x80 && continuation <= 0xbf
                  && (byte !== 1 || !(lead === 0xe0 && continuation < 0xa0
                    || lead === 0xed && continuation > 0x9f
                    || lead === 0xf0 && continuation < 0x90
                    || lead === 0xf4 && continuation > 0x8f));
              }
              if (valid) {
                end = i + count * 3;
                char = decodeURIComponent(decoded.slice(i, end));
              }
            }
            text += char;
            const srcStart = starts ? starts[i] : i;
            const srcEnd = ends ? ends[end - 1] : end;
            for (let j = 0; j < char.length; j++) {
              percentStarts.push(srcStart);
              percentEnds.push(srcEnd);
            }
            i = end;
          }
          for (let at = text.indexOf(apiKey); at !== -1; at = text.indexOf(apiKey, at + apiKey.length)) {
            matches.push([percentStarts[at], percentEnds[at + apiKey.length - 1]]);
          }
        }
      }
      matches.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let consumed = 0;
      const limit = cut - cursor;
      for (const [start, end] of matches) {
        if (start >= limit) break;
        if (start < consumed) continue;
        parts.push(raw.slice(consumed, start), "[REDACTED]");
        consumed = end;
      }
      const advance = Math.max(limit, consumed);
      parts.push(raw.slice(consumed, advance));
      cursor += advance;
    }
    return parts.join("");
  };
  const forms = keySourceForms(apiKey);
  redactorForms.set(redact, { literal: apiKey.length, escaped: Math.max(...forms.map((form) => form.length)) });
  return redact;
}

export function redactApiKey(value: string, apiKey?: string): string {
  if (isRedactorDebug) redactApiKeyLog.debug(`Redacting API key value: inputLength=${value.length}, hasKey=${Boolean(apiKey)}`);
  return createApiKeyRedactor(apiKey)(value);
}

// ---------------------------------------------------------------------------
// Extension path resolution (absorbed from resolve-extension-path.ts)
// ---------------------------------------------------------------------------

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

function resolveAndLog(envVar: string, packageName: string, entryFile: string): string {
  const result = resolveExtensionPathDetailed(envVar, packageName, entryFile);
  if (!result.path) {
    logger.debug(`[sidecar] RESOLVE_SKIPPED: package=${packageName}, reason=${result.error || "unknown"}`);
  }
  return result.path;
}

/** Resolve extension: env override → npm package → monorepo relative path. */
export function resolveExt(envVar: string, packageName: string, entryFile: string, monorepoRelative: string): string {
  const envPath = process.env[envVar];
  if (envPath) return resolve(envPath);
  const pkg = resolveExtensionPathDetailed(envVar, packageName, entryFile);
  if (pkg.path) return pkg.path;
  return join(__dirname, "..", "..", "..", monorepoRelative);
}

const VERTEX_EXTENSION = resolveExt("SIDECAR_VERTEX_EXTENSION_PATH", "@myk-org/pi-vertex-claude", "index.ts", "packages/pi-vertex-claude/index.ts");
const SUBAGENT_EXTENSION = resolveAndLog("SIDECAR_SUBAGENT_EXTENSION_PATH", "@earendil-works/pi-coding-agent", "examples/extensions/subagent/index.ts");

interface ExtensionEntry {
  path: string;
  label: string;
  /** Marks this entry as the subagent extension for ResolvedExtensions.subagentPathFound —
   *  an explicit flag rather than matching on `label === "Subagent"`, so a future label rename
   *  can't silently break the create()/subagent path pre-check. Actual load success is verified
   *  after DefaultResourceLoader.reload() via getExtensions(). */
  isSubagent?: boolean;
}

interface ResolvedExtensions {
  paths: string[];
  /** True when the subagent extension file was found on disk (path resolve only). */
  subagentPathFound: boolean;
}

const extensionPathExistsCache = new Map<string, boolean>();
let cachedSubagentExtensions: ResolvedExtensions | undefined;

/** Resolve a list of candidate extension paths to existing files, logging each outcome. */
function resolveExtensionPaths(entries: ExtensionEntry[]): ResolvedExtensions {
  const paths: string[] = [];
  let subagentPathFound = false;
  for (const { path, label, isSubagent } of entries) {
    if (!path) {
      logger.warn(`[sidecar] EXTENSION_RESOLVE_EMPTY: label=${label}`);
      continue;
    }
    if (extensionPathExistsCache.get(path)) {
      paths.push(path);
      if (isSubagent) subagentPathFound = true;
      continue;
    }
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        logger.warn(`[sidecar] EXTENSION_NOT_FILE: label=${label}, path=${path}`);
        continue;
      }
      extensionPathExistsCache.set(path, true);
      paths.push(path);
      logger.log(`[sidecar] EXTENSION_FOUND: label=${label}, path=${path}`);
      if (isSubagent) subagentPathFound = true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[sidecar] EXTENSION_NOT_FOUND: label=${label}, path=${path}, error=${errMsg}`);
    }
  }
  return { paths, subagentPathFound };
}

function resolveSubagentExtensionOnce(): ResolvedExtensions {
  if (cachedSubagentExtensions) return cachedSubagentExtensions;
  const resolved = resolveExtensionPaths([
    { path: SUBAGENT_EXTENSION, label: "Subagent", isSubagent: true },
  ]);
  // Cache only positive resolutions so a transient stat failure can recover.
  if (resolved.subagentPathFound) {
    cachedSubagentExtensions = resolved;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Startup snapshots, pricing provenance, and Pi SDK runtime helpers
// ---------------------------------------------------------------------------

// Only SDK-owned literal endpoints are trusted for key-scoped model listing.
const builtinBaseUrls = new Map(builtinProviders().filter((provider) => provider.baseUrl).map((provider) => [provider.id, provider.baseUrl!]));

/**
 * Providers that require interactive browser OAuth and therefore cannot work
 * in this headless container. Excluded from getModels()'s catalog and from
 * getProviderStatus()'s reported model count — hoisted to module scope so all
 * call sites share one definition.
 */
export const HEADLESS_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot"]);

/**
 * Both the internal registrar runtime and every user session disable compaction
 * (sessions are short-lived/one-shot over HTTP — no need for the SDK to manage
 * context window pressure) and use an in-memory settings store (no on-disk
 * config to load/persist for either). Shared factory so the two call sites
 * (ensureInternalRuntime()'s createRuntime, createSession()) don't drift.
 *
 * The seed is the STARTUP SNAPSHOT of the deployment agent dir's settings.json
 * (read once by the PiProviderRuntime constructor via readSettingsSeed). It is
 * never re-read and never taken from a per-request agent_dir: an explicit
 * per-request agent_dir affects DefaultResourceLoader resource loading only, so
 * sessions cannot diverge from each other after settings.json edits or partial
 * writes. Deployments that want to supply pi settings (e.g. defaultProvider)
 * next to their custom models.json/auth.json restart the sidecar to apply
 * changes. Compaction stays disabled regardless of what the seed says: sidecar
 * sessions are one-shot over HTTP.
 *
 * Exported for tests.
 */
export function createSessionSettingsManager(seed: Record<string, unknown> = {}): SettingsManager {
  // Key count only — never settings values, which may carry configuration the
  // deployment considers sensitive.
  sessionSettingsLog.debug("Building in-memory session settings from startup snapshot", { seedKeys: Object.keys(seed).length });
  return SettingsManager.inMemory({ ...seed, compaction: { enabled: false } });
}

/** Read `<agentDir>/settings.json` as seed settings; {} when absent/unparseable.
 * Called once per process (PiProviderRuntime constructor) — the result is the
 * startup snapshot handed to createSessionSettingsManager. Exported for tests. */
export function readSettingsSeed(agentDir?: string): Record<string, unknown> {
  if (!agentDir) {
    sessionSettingsLog.debug("No agent dir for settings seeding; using empty settings");
    return {};
  }
  const settingsPath = join(agentDir, "settings.json");
  try {
    if (!existsSync(settingsPath)) {
      sessionSettingsLog.debug(`No settings.json in agent dir; using empty settings: path=${settingsPath}`);
      return {};
    }
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sessionSettingsLog.warn(`settings.json in agent dir is not a JSON object; ignoring: path=${settingsPath}`);
      return {};
    }
    sessionSettingsLog.info(`Seeded in-memory settings from agent dir: path=${settingsPath}`);
    return parsed as Record<string, unknown>;
  } catch (err) {
    sessionSettingsLog.warn(
      `Failed to read/parse settings.json in agent dir; using empty settings: path=${settingsPath}, ` +
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

/** Manifest-configured model snapshot for a `trustKeyScopedListing`-flagged
 * provider: the fields forwarded (mapped) into key-scoped listing responses. */
export interface ManifestModelSnapshot {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** Startup snapshot of a provider flagged `trustKeyScopedListing: true`:
 * the pinned baseUrl that granted trust (issue 913 security fix — the runtime
 * provider is loaded lazily and its baseUrl may differ from the manifest read
 * at runtime construction, so trust must compare against THIS value, not the
 * live provider) plus the provider's manifest-configured models. */
export interface TrustedProviderSnapshot {
  /** Normalized href of the manifest `baseUrl`, or undefined when the manifest
   * entry has no parseable URL — in which case the flag can never grant trust. */
  baseUrl?: string;
  models: ManifestModelSnapshot[];
}

/** Parse a flagged provider's `models[]` manifest entries into snapshots.
 * Invalid entries are skipped individually — a malformed sibling must not
 * silently drop the provider's whole flag — with a warn per skipped entry
 * (provider id + reason, never a raw entry dump). */
function readManifestModels(config: Record<string, unknown>, providerId: string): ManifestModelSnapshot[] {
  const raw = config.models;
  if (!Array.isArray(raw)) return [];
  const models: ManifestModelSnapshot[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      agentDirLog.warn("Skipping malformed manifest model entry: not an object", { providerId });
      continue;
    }
    const { id, name, contextWindow, maxTokens } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim() || typeof name !== "string") {
      agentDirLog.warn("Skipping manifest model entry with invalid id or name", { providerId, modelId: typeof id === "string" ? id : undefined });
      continue;
    }
    const snapshot: ManifestModelSnapshot = { id, name };
    if (isPositiveSafeInt(contextWindow)) snapshot.contextWindow = contextWindow;
    if (isPositiveSafeInt(maxTokens)) snapshot.maxTokens = maxTokens;
    models.push(snapshot);
  }
  return models;
}

/** Read provider IDs flagged `trustKeyScopedListing: true` from `<agentDir>/models.json`
 * (empty map when absent/unparseable), each mapped to a snapshot of that
 * provider's pinned `baseUrl` and manifest-configured `models[]`. Called once
 * per process (PiProviderRuntime constructor) — the same startup snapshot
 * discipline as readSettingsSeed. This admin-controlled manifest is the ONLY
 * source the key-scoped listing trust gate accepts; request- or session-level
 * input never contributes. Exported for tests. */
export function readTrustedKeyScopedProviders(agentDir?: string): Map<string, TrustedProviderSnapshot> {
  const trusted = new Map<string, TrustedProviderSnapshot>();
  if (!agentDir) {
    agentDirLog.debug("No agent dir for trustKeyScopedListing flags; none loaded");
    return trusted;
  }
  const modelsPath = join(agentDir, "models.json");
  try {
    if (!existsSync(modelsPath)) {
      agentDirLog.debug(`No models.json in agent dir; no trustKeyScopedListing flags: path=${modelsPath}`);
      return trusted;
    }
    // Parse exactly like pi's ModelConfig.load (issue 1133): models.json is JSONC —
    // comments, trailing commas and a BOM are legal to the runtime, so a bare
    // JSON.parse here would drop a manifest pi itself accepts. Same library the
    // orchestrator uses for its JSONC settings files.
    const content = readFileSync(modelsPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(stripJsonComments(content, { trailingCommas: true }));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      agentDirLog.warn(`models.json in agent dir is not a JSON object; no trustKeyScopedListing flags: path=${modelsPath}`);
      return trusted;
    }
    const providers = (parsed as { providers?: unknown }).providers;
    if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
      agentDirLog.warn(`models.json in agent dir has no providers object; no trustKeyScopedListing flags: path=${modelsPath}`);
      return trusted;
    }
    for (const [id, config] of Object.entries(providers)) {
      if (typeof config === "object" && config !== null &&
          (config as Record<string, unknown>).trustKeyScopedListing === true) {
        const record = config as Record<string, unknown>;
        let baseUrl: string | undefined;
        if (typeof record.baseUrl === "string") {
          try {
            baseUrl = new URL(record.baseUrl).href;
          } catch {
            agentDirLog.warn(`Flagged provider has an unparseable baseUrl; its flag can never grant listing trust: providerId=${id}`);
          }
        } else {
          agentDirLog.warn(`Flagged provider has no baseUrl; its flag can never grant listing trust: providerId=${id}`);
        }
        trusted.set(id, { baseUrl, models: readManifestModels(record, id) });
      }
    }
    agentDirLog.info(`Loaded trustKeyScopedListing flags from agent dir models.json: path=${modelsPath}, flaggedProviders=${trusted.size}, manifestModels=${trusted.size ? [...trusted.values()].reduce((sum, entry) => sum + entry.models.length, 0) : 0}`);
  } catch (err) {
    agentDirLog.warn(
      `Failed to read/parse models.json in agent dir; no trustKeyScopedListing flags honored: path=${modelsPath}, ` +
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return trusted;
}

/** Union a flagged provider's manifest-configured models into a successful live
 * key-scoped listing (issue 912 extension: gateways that list only a subset of
 * what the admin configured). Dedupe by id — deterministic rule: the
 * admin-configured manifest entry REPLACES the live entry on collision (explicit
 * configuration outranks an inferred listing entry, keeping its name and token
 * limits); manifest-only models are appended after the live entries in manifest
 * order. Response shape matches live entries: {provider,id,name,source} plus
 * optional capabilities using the SAME schema as live entries
 * (inputTokenLimit/outputTokenLimit — manifest contextWindow/maxTokens mapped
 * onto them), so consumers and create() read a single capability schema.
 * Provenance: every entry carries `source` — "listing" when the gateway listed
 * the id for this key (including manifest-wins collisions: the id IS verified
 * for the key, the manifest only enriched name/limits), "manifest" when the
 * entry is admin-declared only and NOT verified for this key. */
function mergeManifestModels(
  models: KeyScopedModel[],
  manifest: readonly ManifestModelSnapshot[] | undefined,
  providerId: string,
  safeProviderId: string,
): void {
  if (!manifest || manifest.length === 0) return;
  const liveCount = models.length;
  // Snapshot the gateway-listed ids BEFORE merging — indexById below also
  // accumulates manifest ids, so `source` must derive from this original set
  // (a duplicate manifest id the gateway never listed is NOT key-verified).
  const liveIds = new Set(models.map((model) => model.id));
  const indexById = new Map(models.map((model, index) => [model.id, index]));
  let replaced = 0;
  for (const entry of manifest) {
    // Collision keeps "listing": the gateway did list this id for this key, so
    // it stays verified even though the manifest supplied the entry's data.
    const source: "listing" | "manifest" = liveIds.has(entry.id) ? "listing" : "manifest";
    const model: KeyScopedModel = { provider: providerId, id: entry.id, name: entry.name, source };
    if (entry.contextWindow !== undefined || entry.maxTokens !== undefined) {
      const capabilities: Record<string, unknown> = {};
      if (entry.contextWindow !== undefined) capabilities.inputTokenLimit = entry.contextWindow;
      if (entry.maxTokens !== undefined) capabilities.outputTokenLimit = entry.maxTokens;
      model.capabilities = capabilities;
    }
    const index = indexById.get(entry.id);
    if (index === undefined) {
      indexById.set(entry.id, models.length);
      models.push(model);
    } else {
      models[index] = model;
      replaced++;
    }
  }
  agentDirLog.debug("Merged manifest models into key-scoped listing", { providerId: safeProviderId, liveCount, manifestCount: manifest.length, appended: models.length - liveCount, deduped: replaced });
}

/** Internal registrar session never receives prompts — system prompt is a placeholder for clarity in logs/dumps. */
const INTERNAL_REGISTRAR_SYSTEM_PROMPT =
  "You are the pi-sidecar's internal model registrar session. You exist only to keep the " +
  "Providers/Vertex/Subagent extensions loaded so their providers stay registered on the shared " +
  "ModelRuntime. You are never prompted.";

/** Default agent dir for the internal registrar runtime; independent of per-request agent_dir overrides. */
export const INTERNAL_AGENT_DIR = "/tmp/pi-sidecar-agent";

/**
 * Resolve the agent dir the internal registrar runtime reads models.json /
 * auth.json / settings.json from (and the per-session default agent dir).
 * Precedence: explicit option → PI_SIDECAR_AGENT_DIR env var (trimmed,
 * non-empty) → INTERNAL_AGENT_DIR default. The default is an ephemeral,
 * undocumented-as-config scratch dir — deployments that want to supply custom
 * providers/settings set the option or the env var to a persistent dir.
 * Exported for tests.
 */
export function resolveInternalAgentDir(explicit?: string): string {
  const fromEnv = process.env.PI_SIDECAR_AGENT_DIR?.trim();
  const resolved = explicit !== undefined ? explicit : (fromEnv || INTERNAL_AGENT_DIR);
  const source = explicit !== undefined ? "option" : fromEnv ? "env" : "default";
  agentDirLog.debug(`AGENT_DIR_RESOLVED: dir=${resolved}, source=${source}`);
  return resolved;
}

/**
 * Ambient-marker value on `apiKey`; string apiKeys cannot carry it (undefined).
 *
 * Marker mechanism (issue #919): an ambient-auth provider (e.g. ADC) opts out
 * of per-session API keys by registering object-form auth whose apiKey carries
 * `Symbol.for("pi-config.ambientLoginAuth") = true` — only possible via pi-ai
 * `createProvider` (native registration). Legacy `registerProvider(name, bag)`
 * registrations use string apiKeys (env-var refs) that cannot carry the marker;
 * those are classified by extension path in `snapshotLegacyAmbientProviders`
 * below. A NEW ambient-auth extension must either register via createProvider
 * with the marker, or load through one of the path-classified extension entries
 * (add its path there).
 */
function ambientMarkerValue(apiKey: unknown): unknown { // pragma: allowlist secret — parameter name, not a credential
  return typeof apiKey === "object" && apiKey !== null // pragma: allowlist secret — parameter name, not a credential
    ? Reflect.get(apiKey, Symbol.for("pi-config.ambientLoginAuth"))
    : undefined;
}

/**
 * Classify legacy string-keyed native provider registrations originating from
 * path-classified ambient extensions (e.g. Vertex ADC).
 */
export function snapshotLegacyAmbientProviders(
  registrations: LoadExtensionsResult["runtime"]["pendingNativeProviderRegistrations"],
  legacyAmbientProviders: WeakSet<Provider>,
): void {
  let legacyCount = 0;
  for (const { provider, extensionPath } of registrations) {
    if (extensionPath === VERTEX_EXTENSION &&
        provider.auth.apiKey && ambientMarkerValue(provider.auth.apiKey) === undefined) {
      legacyAmbientProviders.add(provider);
      legacyCount++;
    }
  }
  legacyAmbientProvidersLog.debug("Legacy ambient registrations classified", { registrationCount: registrations.length, legacyCount });
}

export type { AgentSessionRuntimeDiagnostic };

/** Minimal shape accepted by `collectServiceDiagnostics()` for Pi 1.6.x and 1.7.0+ compatibility. */
export interface ServiceDiagnosticsSource {
  diagnostics?: readonly unknown[];
  modelRuntime?: { getError?: () => string | undefined };
  resourceLoader?: {
    getExtensions?: () => { errors?: ReadonlyArray<{ path: string; error: string }> };
  };
}

/**
 * Scrub common credential patterns from diagnostic messages logged without a
 * per-session API key (for example startup models.json or extension errors).
 * Preserves schema field paths such as `providers.acme.apiKey: must be string`.
 */
export function redactDiagnosticSecrets(value: string): string {
  return value
    // URL userinfo (scheme://<user>:<pass>@host) -> scheme://[REDACTED]@host
    .replace(/((?:https?|wss?):\/\/)([^/\s@:]+:[^/\s@]+)@/gi, "$1[REDACTED]@")
    // Authorization / Bearer tokens
    .replace(/\b(Bearer\s+)(?!\[REDACTED\])[^\s'",;)}\]]+/gi, "$1[REDACTED]")
    // Quoted JSON credential fields (preserves "$ENV_VAR" references)
    .replace(
      /("[a-zA-Z0-9_-]{0,40}(?:api[_-]?key|authorization|x-api-key|x-goog-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password)"\s*:\s*)"(?!\$[A-Z0-9_]+")([^"]+)"/gi,
      '$1"[REDACTED]"',
    )
    // Header-style auth values: x-api-key: <val>, x-goog-api-key: <val>, authorization: <val>
    // Negative lookbehind preserves dotted schema paths like `providers.acme.headers.Authorization: must be string`.
    .replace(
      /(?<![.\w-])((?:x-api-key|x-goog-api-key|authorization)\s*:\s*)(?!\[REDACTED\]|Bearer\s+\[REDACTED\])[^\r\n'",;)}\]]+/gi,
      "$1[REDACTED]",
    )
    // Key=value secret assignments: api_key=..., token=..., secret=..., password=...
    .replace(
      /\b([a-zA-Z0-9_-]{0,40}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password)\s*=\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s&,;)}\]]+)/gi,
      "$1[REDACTED]",
    )
    // Well-known provider API key prefixes
    .replace(
      /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "[REDACTED]",
    );
}

/**
 * Collect startup diagnostics from `createAgentSessionServices()` defensively.
 *
 * - Works when `services.diagnostics` is absent or empty (older SDKs / stubs).
 * - Preserves Pi 1.7.0+ `services.diagnostics` warnings (including upstream #12523
 *   invalid `models.json` warnings) without duplicating them.
 * - Backfills `services.modelRuntime.getError()` as a warning on Pi 1.6.x where
 *   `createAgentSessionServices()` does not yet populate `models.json` diagnostics.
 * - Appends extension load errors and scrubs inline secrets from all messages.
 */
export function collectServiceDiagnostics(
  services: ServiceDiagnosticsSource,
): AgentSessionRuntimeDiagnostic[] {
  const serviceDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
  if (Array.isArray(services.diagnostics)) {
    for (const entry of services.diagnostics) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { message?: unknown }).message === "string" &&
        ((entry as { type?: unknown }).type === "error" ||
          (entry as { type?: unknown }).type === "warning" ||
          (entry as { type?: unknown }).type === "info")
      ) {
        serviceDiagnostics.push({
          type: (entry as AgentSessionRuntimeDiagnostic).type,
          message: redactDiagnostic((entry as AgentSessionRuntimeDiagnostic).message, redactDiagnosticSecrets),
        });
      }
    }
  }

  let backfilledModelsJsonWarning = false;
  const modelsJsonError =
    typeof services.modelRuntime?.getError === "function"
      ? services.modelRuntime.getError()
      : undefined;
  if (typeof modelsJsonError === "string" && modelsJsonError.trim().length > 0) {
    const modelsJsonMessage = redactDiagnostic(`models.json error: ${modelsJsonError}`, redactDiagnosticSecrets);
    const alreadyReported = serviceDiagnostics.some(
      (diag) => diag.type === "warning" && diag.message === modelsJsonMessage,
    );
    if (!alreadyReported) {
      serviceDiagnostics.push({
        type: "warning",
        message: modelsJsonMessage,
      });
      backfilledModelsJsonWarning = true;
    }
  }

  const rawExtensionErrors = services.resourceLoader?.getExtensions?.()?.errors;
  const extensionErrors: AgentSessionRuntimeDiagnostic[] = Array.isArray(rawExtensionErrors)
    ? rawExtensionErrors.map(({ path, error }) => ({
        type: "error" as const,
        message: redactDiagnostic(`Failed to load extension "${path}": ${error}`, redactDiagnosticSecrets),
      }))
    : [];

  const diagnostics = [...serviceDiagnostics, ...extensionErrors];
  internalRuntimeDiagnosticsLog.debug("Collected service diagnostics", {
    serviceCount: serviceDiagnostics.length,
    backfilledModelsJsonWarning,
    extensionErrorCount: extensionErrors.length,
    totalCount: diagnostics.length,
  });
  return diagnostics;
}

/**
 * Builds the CreateAgentSessionRuntimeFactory for the internal registrar
 * runtime (see PiProviderRuntime.ensureInternalRuntime()).
 *
 * `settingsSeed` is the startup snapshot of the deployment agent dir's
 * settings.json — the settings manager is built from it, never from the
 * factory's `agentDir` param. That param still goes to
 * createAgentSessionServices for models.json/auth.json/ResourceLoader loading.
 */
function createInternalRuntimeFactory(extensionPaths: string[], legacyAmbientProviders: WeakSet<Provider>, settingsSeed: Record<string, unknown>): CreateAgentSessionRuntimeFactory {
  internalRuntimeFactoryLog.debug("Internal runtime factory configured", { extensionCount: extensionPaths.length, settingsSeedKeys: Object.keys(settingsSeed).length });
  return async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
    const settingsManager = createSessionSettingsManager(settingsSeed);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: extensionPaths,
        // Called after extension load but before queued native providers are registered.
        // The queue records the actual registering extension, unlike names or env vars.
        extensionsOverride: (result: LoadExtensionsResult) => {
          internalRuntimeExtensionsLog.debug("Classifying pending native providers", { registrationCount: result.runtime.pendingNativeProviderRegistrations.length });
          snapshotLegacyAmbientProviders(result.runtime.pendingNativeProviderRegistrations, legacyAmbientProviders);
          return result;
        },
        systemPromptOverride: () => INTERNAL_REGISTRAR_SYSTEM_PROMPT,
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
      tools: [],
    });
    const diagnostics = collectServiceDiagnostics(services);
    return { ...created, services, diagnostics };
  };
}

/**
 * Drain unreported diagnostics from an AgentSessionRuntime and log each once.
 * Uses takeUnreportedDiagnostics() so repeat drains never duplicate prior entries.
 */
export function logUnreportedRuntimeDiagnostics(
  runtime: Pick<AgentSessionRuntime, "takeUnreportedDiagnostics">,
  redact: (value: string) => string = (value) => value,
): number {
  const diagnostics = runtime.takeUnreportedDiagnostics();
  internalRuntimeDiagnosticsLog.debug("Drained internal runtime diagnostics", { count: diagnostics.length });
  for (const diagnostic of diagnostics) {
    const log = diagnostic.type === "error" ? logger.error : diagnostic.type === "warning" ? logger.warn : logger.debug;
    const message = redactDiagnostic(diagnostic.message, (value) => redactDiagnosticSecrets(redact(value)));
    log(`[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=${diagnostic.type}, message=${message}`);
  }
  return diagnostics.length;
}

export const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** Methods SessionStore calls on a stored session. */
export type StoredSession = Pick<AgentSession, "prompt" | "subscribe" | "dispose" | "abort">;

/**
 * Marker for a model whose prices were fabricated because its source published
 * none. Defined via the global symbol registry so packages/pi-sidecar and
 * extensions/shared (which this package cannot import — separate tsconfig
 * rootDir) agree without a dependency; the definition lives in
 * extensions/shared/pricing-provenance.ts. Same pattern as
 * Symbol.for("pi-config.ambientLoginAuth").
 */
const PRICING_UNKNOWN = Symbol.for("pi-config.pricingUnknown");

/**
 * Counterpart marker for sources that published prices, zeros included. Defined
 * via the global symbol registry for the same reason as PRICING_UNKNOWN above.
 */
const PRICING_KNOWN = Symbol.for("pi-config.pricingKnown");

/**
 * Whether a model's prices are known, as opposed to merely numeric.
 *
 * Pi requires numeric prices, so a model whose source published none is
 * registered with zeros — and those zeros mean "unknown pricing", not "free".
 * Three sources supply such zeros, and all three must be withheld:
 *
 * - Models we fabricate (key-scoped listings, openai-compatible /v1/models
 *   records), marked PRICING_UNKNOWN.
 * - models.json definitions that omit `cost`: Pi's provider composer fills them
 *   with zeros (see pi's provider-composer `cost: definition.cost ?? {0,0,0,0}`)
 *   and hands us a model with no marker.
 * - Any other unmarked all-zero cost with no catalog entry behind it.
 *
 * An all-zero cost is authoritative in exactly two cases, and both require proof:
 *
 * 1. A source published it (PRICING_KNOWN) — models.dev or an OpenAI-compatible
 *    `/v1/models` record stating a zero price for a model pi-ai never shipped.
 * 2. The cost object *is* pi-ai's generated catalog entry for this model, which
 *    is how a genuinely free model (an OpenRouter `:free` variant) is
 *    recognized. Identity, not a provider+id match: an unpriced models.json
 *    override of a free catalog model gets its own zero-filled cost object from
 *    the provider composer, so sharing identifiers is not evidence of anything.
 */
export function hasKnownPricing(model: { id?: string; provider?: string; api?: string; baseUrl?: string; cost?: Record<string, number | undefined> } | undefined): boolean {
  const cost = model?.cost;
  if (!cost) {
    runtimeLog.debug("[sidecar] PRICING_KNOWN: known=false, priceMetadata=absent, provenance=none");
    return false;
  }
  if (Reflect.get(model, PRICING_UNKNOWN) === true) {
    runtimeLog.debug("[sidecar] PRICING_KNOWN: known=false, priceMetadata=present, provenance=fabricated");
    return false;
  }
  const prices = Object.values(cost).filter((value): value is number => typeof value === "number");
  if (prices.length === 0) {
    runtimeLog.debug("[sidecar] PRICING_KNOWN: known=false, priceMetadata=empty, provenance=none");
    return false;
  }
  if (prices.some((value) => value > 0)) {
    runtimeLog.debug("[sidecar] PRICING_KNOWN: known=true, priceMetadata=present, provenance=priced");
    return true;
  }
  // All zero: either a source published it, or it is the catalog's own entry.
  if (Reflect.get(model, PRICING_KNOWN) === true) {
    runtimeLog.debug("[sidecar] PRICING_KNOWN: known=true, priceMetadata=present, provenance=source-published-free");
    return true;
  }
  const catalogFree = isCatalogFreeModel(model);
  // Never log the model or its prices — only the resulting decision.
  runtimeLog.debug(
    `[sidecar] PRICING_KNOWN: known=${catalogFree}, priceMetadata=present, provenance=${catalogFree ? "catalog-free" : "unattributed-zero"}`,
  );
  return catalogFree;
}

/**
 * Whether the model is pi-ai's generated catalog entry for this identifier, and
 * that entry declares the model free. Local catalog lookup only — no network, no
 * credentials.
 *
 * The comparison checks the entry's identity surface (provider, id, api,
 * baseUrl), not only the identifier. An unpriced models.json override that
 * repoints a free catalog model at another endpoint or API is a different price
 * source, so its zero-filled cost must not inherit the catalog's free verdict;
 * `isCatalogFreeModel` returns false and the turn is reported as unknown spend.
 *
 * Reference identity is deliberately not used: pi-ai ships as two module
 * instances (root and pi-coding-agent/node_modules), so the runtime's models and
 * this package's catalog are distinct objects even for the same model.
 */
function isCatalogFreeModel(model: { id?: string; provider?: string; api?: string; baseUrl?: string; cost?: Record<string, number | undefined> }): boolean {
  if (!model?.id || !model.provider) {
    runtimeLog.debug("[sidecar] CATALOG_FREE: free=false, reason=unidentified");
    return false;
  }
  try {
    const catalog = getModel(model.provider as any, model.id);
    if (!catalog) {
      // Provider and model id are non-sensitive identifiers and the only way to trace
      // which zero-priced model fell back to unknown spend.
      runtimeLog.debug("[sidecar] CATALOG_FREE: free=false, reason=absent-from-catalog", { provider: model.provider, model: model.id });
      return false;
    }
    const prices = Object.values(catalog.cost ?? {});
    const free = prices.length > 0 && prices.every((value) => value === 0);
    const sameEndpoint = catalog.api === model.api && catalog.baseUrl === model.baseUrl;
    const verdict = free && sameEndpoint;
    runtimeLog.debug("[sidecar] CATALOG_FREE: ", { free: verdict, catalogFree: free, sameEndpoint, provider: model.provider, model: model.id });
    return verdict;
  } catch (err) {
    runtimeLog.warn("[sidecar] CATALOG_LOOKUP_FAILED: reason=lookup_error", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public runtime seam types
// ---------------------------------------------------------------------------

/**
 * Wire-format shape for custom tool configs received via the HTTP API.
 * Non-HTTP tools are passed through to the Pi SDK as-is and must already
 * conform to the SDK's ToolDefinition interface (including the SDK-style
 * `execute(toolCallId, params, signal, onUpdate, ctx)` signature).
 * HTTP-backed tools are automatically wrapped with the correct SDK signature.
 */
export interface CustomToolConfig {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  /** When present, the tool's execute function is backed by an HTTP request. */
  http?: Record<string, any>;
  /** Additional properties passed through to the Pi SDK ToolDefinition. */
  [key: string]: any;
}

export interface CreateSessionOptions {
  provider: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  agentDir?: string;
  apiKey?: string;
  tools?: string[];
  customTools?: CustomToolConfig[];
}

export interface ProviderStatus {
  provider: string;
  registered: boolean;
  modelCount: number;
  /** Whether POST /sessions accepts api_key for this provider, regardless of server credentials. */
  supportsSessionApiKey: boolean;
  authStatus: ReturnType<ModelRuntime["getProviderAuthStatus"]> | null;
  /** Always null or AuthCheck — never undefined (checkAuth's undefined is normalized via ?? null). */
  authCheck: NonNullable<Awaited<ReturnType<ModelRuntime["checkAuth"]>>> | null;
}

export interface DiscoveredProvider {
  provider: string;
  supportsSessionApiKey: boolean;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
}

export interface KeyScopedModel {
  provider: string;
  id: string;
  name: string;
  source: "listing" | "manifest";
  capabilities?: Record<string, unknown>;
}

export interface KeyScopedModelsResult {
  models: KeyScopedModel[];
  modelListingSupported: boolean;
}

export interface CreateRuntimeSessionInput {
  sessionId: string;
  options: CreateSessionOptions;
  redact: (value: string) => string;
}

export interface CreatedRuntimeSession {
  session: StoredSession;
  pricingKnown: boolean;
  customToolNames: string[];
}

/**
 * Narrow provider-runtime adapter seam injected into `SessionStore`.
 *
 * Owns startup snapshots, extension loading, Pi SDK runtime/registry lifecycle,
 * catalog & key-scoped model discovery, and session instantiation so
 * `SessionStore` can focus purely on active sessions, SSE streaming, redaction
 * holdback, abort handling, and transcripts.
 */
export interface ProviderRuntime {
  readonly ready: boolean;
  readonly discoveryError: string | null;
  getInternalDiagnostics?(): readonly AgentSessionRuntimeDiagnostic[];
  getProviders(): Promise<DiscoveredProvider[]>;
  getModels(): Promise<DiscoveredModel[]>;
  refreshModels(): Promise<DiscoveredModel[]>;
  getProviderStatus(provider: string): Promise<ProviderStatus>;
  getModelsForApiKey(providerId: string, apiKey: string): Promise<KeyScopedModelsResult>;
  createSession(input: CreateRuntimeSessionInput): Promise<CreatedRuntimeSession>;
  dispose(): Promise<void>;
}

/** Subset of `AgentSessionRuntime` owned by `PiProviderRuntime`. */
export type InternalRuntimeHandle = Pick<
  AgentSessionRuntime,
  "dispose" | "diagnostics" | "takeUnreportedDiagnostics"
> & {
  services: { modelRuntime: ModelRuntime };
};

export interface PiProviderRuntimeOptions {
  agentDir?: string;
  /**
   * Optional pre-initialized `ModelRuntime` (skips internal registrar bootstrap
   * and starts ready). Useful when testing real Pi SDK provider/key-scoped
   * behavior against a controlled `ModelRuntime` without mutating private fields.
   */
  modelRuntime?: ModelRuntime;
  /** Optional shared WeakSet for legacy ambient provider classifications. */
  legacyAmbientProviders?: WeakSet<Provider>;
  /**
   * Optional factory override for creating the internal `AgentSessionRuntime`
   * (defaults to the production Pi SDK registrar factory).
   */
  createInternalRuntime?: (params: {
    cwd: string;
    agentDir: string;
    extensionPaths: string[];
  }) => Promise<InternalRuntimeHandle>;
}

/**
 * Production Pi SDK implementation of `ProviderRuntime`.
 *
 * Owns:
 * - Deployment agent dir resolution + startup snapshots (`settingsSeed`,
 *   `trustedKeyScopedProviders`)
 * - Extension path resolution & caching (Vertex + Subagent)
 * - Lazy internal `AgentSessionRuntime` + shared `ModelRuntime` / `ModelRegistry`
 * - Catalog discovery, provider status, and HTTP API-key-scoped model discovery
 * - Per-session `ModelRuntime` credential proxy, HTTP tool wrapping, resource
 *   loader setup, and `createAgentSession()` instantiation
 */
export class PiProviderRuntime implements ProviderRuntime {
  /** Shared ModelRuntime (0.81+) — sourced from internalRuntime.services once created. */
  private modelRuntime: ModelRuntime | undefined;
  private modelRegistry: ModelRegistry | undefined;
  /** Legacy providers identified by the registrar's registration queue, not mutable configuration. */
  private readonly legacyAmbientProviders: WeakSet<Provider>;
  /**
   * Internal AgentSessionRuntime that owns the shared ModelRuntime and keeps
   * Vertex and Subagent extensions loaded for the sidecar process's lifetime.
   * Created once, lazily, and disposed only in dispose().
   *
   * User sessions created via createSession() never load Vertex (already
   * registered on the shared modelRuntime), and only load Subagent when
   * "subagent" is in the session's tools.
   */
  private internalRuntime: InternalRuntimeHandle | undefined;
  private runtimeInit: Promise<void> | undefined;
  private _ready = false;
  private _discoveryError: string | null = null;
  private _disposed = false;

  /**
   * In-flight refreshModels() so concurrent getModels()/create()/startup share
   * one discovery pass instead of racing two snapshots.
   */
  private refreshInFlight: Promise<DiscoveredModel[]> | undefined;

  /**
   * Agent dir the internal registrar runtime reads models.json/auth.json/
   * settings.json from, and the per-session default agent dir. Resolved once
   * at construction (see resolveInternalAgentDir); per-request agent_dir still
   * overrides the session ResourceLoader only.
   */
  private readonly agentDir: string;

  /**
   * Startup snapshot of `<this.agentDir>/settings.json` ({} when absent or
   * unparseable). Read exactly once, here in the constructor, and used for
   * every settings manager this runtime builds (internal registrar runtime and
   * every user session). Never re-read: sessions must not diverge after
   * settings.json edits or partial writes — deployments restart the sidecar to
   * apply settings changes. Per-request agent_dir never contributes settings.
   */
  private readonly settingsSeed: Record<string, unknown>;

  /**
   * Startup snapshot of provider IDs flagged `trustKeyScopedListing: true` in
   * `<this.agentDir>/models.json` (empty when absent or unparseable), each mapped
   * to that provider's manifest-configured `models[]` snapshots. Read exactly
   * once, here in the constructor — same snapshot discipline as settingsSeed.
   * This admin-controlled manifest is the only source the key-scoped listing
   * trust gate (getModelsForApiKey) accepts; request/session input never
   * contributes. Deployments restart the sidecar to apply flag changes.
   */
  private readonly trustedKeyScopedProviders: ReadonlyMap<string, TrustedProviderSnapshot>;

  private readonly createInternalRuntimeOverride?: PiProviderRuntimeOptions["createInternalRuntime"];

  /**
   * Post-startup `models.json` warning state updated by `runRefreshModels()`.
   * `undefined` = no post-startup refresh yet; `null` = latest refresh cleared
   * any `models.json` error; diagnostic object = latest refresh reported an error.
   */
  private refreshModelsJsonDiagnostic: AgentSessionRuntimeDiagnostic | null | undefined = undefined;

  constructor(options?: PiProviderRuntimeOptions) {
    this.agentDir = resolveInternalAgentDir(options?.agentDir);
    this.settingsSeed = readSettingsSeed(this.agentDir);
    this.trustedKeyScopedProviders = readTrustedKeyScopedProviders(this.agentDir);
    this.legacyAmbientProviders = options?.legacyAmbientProviders ?? new WeakSet<Provider>();
    this.createInternalRuntimeOverride = options?.createInternalRuntime;
    if (options?.modelRuntime) {
      this.modelRuntime = options.modelRuntime;
      this.modelRegistry = new ModelRegistry(options.modelRuntime);
      this._ready = true;
    }
    // Path and counts only — no settings contents, no credentials.
    runtimeLog.debug("PiProviderRuntime constructed", {
      agentDir: this.agentDir,
      settingsSeedKeys: Object.keys(this.settingsSeed).length,
      trustedKeyScopedProviders: this.trustedKeyScopedProviders.size,
      preconfiguredModelRuntime: Boolean(options?.modelRuntime),
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  get discoveryError(): string | null {
    return this._discoveryError;
  }

  /** Read-only view of retained diagnostics from the internal registrar runtime. */
  getInternalDiagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
    const startupDiagnostics = this.internalRuntime?.diagnostics ?? [];
    if (this.refreshModelsJsonDiagnostic === undefined) {
      return startupDiagnostics;
    }
    const nonModelsJsonDiagnostics = startupDiagnostics.filter(
      (diag) => !(diag.type === "warning" && diag.message.startsWith("models.json error:")),
    );
    return this.refreshModelsJsonDiagnostic
      ? [...nonModelsJsonDiagnostics, this.refreshModelsJsonDiagnostic]
      : nonModelsJsonDiagnostics;
  }

  /** Drain unreported diagnostics from the internal registrar runtime, logging each once. */
  drainUnreportedDiagnostics(redact?: (value: string) => string): number {
    if (!this.internalRuntime) return 0;
    return logUnreportedRuntimeDiagnostics(this.internalRuntime, redact);
  }

  private assertNotDisposed(action: string): void {
    if (this._disposed) {
      throw httpError(`SessionStore is shutting down; ${action} is no longer available`, 503);
    }
  }

  /**
   * Ensure the first discovery pass has finished (or failed with _ready set).
   * Startup kicks refreshModels() async after listen.
   *
   * If init failed before modelRuntime was assigned, throws a controlled 503
   * instead of letting callers crash on `this.modelRuntime!`.
   */
  private async ensureDiscoveryComplete(): Promise<void> {
    if (!this._ready) {
      try {
        await this.refreshModels();
      } catch {
        // refreshModels sets _ready even on failure; check runtime below.
      }
    }
    if (!this.modelRuntime || !this.modelRegistry) {
      throw httpError(
        "Model discovery failed; runtime unavailable. See GET /health.",
        503,
      );
    }
  }

  /**
   * Lazily create the internal AgentSessionRuntime (see field docstring above).
   * Idempotent — concurrent callers await the same in-flight creation.
   */
  private async ensureInternalRuntime(): Promise<void> {
    this.assertNotDisposed("ensureInternalRuntime");
    if (this.internalRuntime || this.modelRuntime) return;
    if (!this.runtimeInit) {
      this.runtimeInit = (async () => {
        const { paths: extensionPaths } = resolveExtensionPaths([
          { path: VERTEX_EXTENSION, label: "Vertex" },
          { path: SUBAGENT_EXTENSION, label: "Subagent", isSubagent: true },
        ]);
        logger.log(`[sidecar] INTERNAL_EXTENSIONS_LOADING: count=${extensionPaths.length}`);

        let runtime: InternalRuntimeHandle;
        if (this.createInternalRuntimeOverride) {
          runtime = await this.createInternalRuntimeOverride({
            cwd: "/tmp",
            agentDir: this.agentDir,
            extensionPaths,
          });
        } else {
          const sessionManager = SessionManager.inMemory();
          const createRuntime = createInternalRuntimeFactory(extensionPaths, this.legacyAmbientProviders, this.settingsSeed);

          runtime = await createAgentSessionRuntime(createRuntime, {
            cwd: "/tmp",
            agentDir: this.agentDir,
            sessionManager,
          });
        }
        // dispose() may have run while we were creating — never leave an
        // orphaned registrar runtime alive past shutdown.
        if (this._disposed) {
          try {
            await runtime.dispose();
            logger.warn(`[sidecar] INTERNAL_RUNTIME_ORPHAN_DISPOSED: created during shutdown`);
          } catch (err) {
            logger.warn(`[sidecar] INTERNAL_RUNTIME_ORPHAN_DISPOSE_FAILED:`, err);
          }
          return;
        }
        this.internalRuntime = runtime;
        this.modelRuntime = this.internalRuntime.services.modelRuntime;
        this.modelRegistry = new ModelRegistry(this.modelRuntime);
        this.drainUnreportedDiagnostics();
        logger.info(`[sidecar] INTERNAL_RUNTIME_CREATED: extensions=${extensionPaths.length}, agentDir=${this.agentDir}`);
      })();
    }
    await this.runtimeInit;
    // Init may have aborted because dispose() ran mid-create.
    this.assertNotDisposed("ensureInternalRuntime");
  }

  /** List registered runtime provider IDs without model discovery or auth checks. */
  async getProviders(): Promise<DiscoveredProvider[]> {
    this.assertNotDisposed("getProviders");
    await this.ensureInternalRuntime();
    const providers = this.modelRuntime!.getProviders().map(({ id }) => ({
      provider: id,
      supportsSessionApiKey: this.supportsSessionApiKey(id),
    }));
    providerDiscoveryLog.debug("Runtime providers listed", { count: providers.length });
    return providers;
  }

  /**
   * List models from all configured providers. Ensures the internal runtime is
   * initialized so builtins are never silently empty during startup races.
   */
  async getModels(): Promise<DiscoveredModel[]> {
    this.assertNotDisposed("getModels");
    await this.ensureDiscoveryComplete();

    const models = this.modelRegistry!.getAvailable()
      .filter((m) => !HEADLESS_EXCLUDED_PROVIDERS.has(m.provider))
      .map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
      }));

    logger.debug(`[sidecar] MODELS_LISTED: count=${models.length}`);
    return models;
  }

  /**
   * Discover models from all configured providers. Blocks until complete.
   * Called on startup — /health returns ok only after this finishes.
   */
  async refreshModels(): Promise<DiscoveredModel[]> {
    this.assertNotDisposed("refreshModels");
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.runRefreshModels().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async runRefreshModels(): Promise<DiscoveredModel[]> {
    logger.debug(`[sidecar] MODEL_DISCOVERY_START:`);
    try {
      const isFirstDiscovery = !this.internalRuntime && !this.modelRuntime;
      // First call: creates the internal runtime, which loads Vertex and
      // Subagent extensions once.
      await this.ensureInternalRuntime();

      if (!isFirstDiscovery) {
        const result = await this.modelRuntime!.refresh({ force: true, allowNetwork: false });
        for (const [providerId, err] of result.errors) {
          logger.warn(`[sidecar] MODEL_REFRESH_PROVIDER_FAILED: provider=${providerId}, error=${err.message}`);
        }
        const hasGetError = typeof this.modelRuntime?.getError === "function";
        const refreshModelsJsonError = hasGetError ? this.modelRuntime!.getError() : undefined;
        if (typeof refreshModelsJsonError === "string" && refreshModelsJsonError.trim().length > 0) {
          const message = redactDiagnostic(`models.json error: ${refreshModelsJsonError}`, redactDiagnosticSecrets);
          this.refreshModelsJsonDiagnostic = { type: "warning", message };
          internalRuntimeDiagnosticsLog.warn("models.json diagnostic detected during refresh", {
            type: "warning",
            message,
          });
        } else if (hasGetError) {
          this.refreshModelsJsonDiagnostic = null;
          internalRuntimeDiagnosticsLog.debug("Cleared refresh models.json diagnostic state");
        }
      }

      this._ready = true;
      this._discoveryError = null;
      const models = await this.getModels();
      logger.info(`[sidecar] MODEL_DISCOVERY_COMPLETE: count=${models.length}`);
      return models;
    } catch (err: any) {
      this._discoveryError = err?.message || "Unknown discovery error";
      this._ready = true; // Mark as ready but with error — don't block health forever
      logger.error(`[sidecar] MODEL_DISCOVERY_FAILED:`, err);
      throw err; // Rethrow so callers can handle (startup catches, POST /models/refresh returns 500)
    }
  }

  /** Shared by status and create; model snapshots do not indicate auth capability. */
  private supportsSessionApiKey(provider: string): boolean {
    const auth = this.modelRuntime!.getProvider(provider)?.auth?.apiKey;
    const native = this.modelRuntime!.getRegisteredNativeProvider(provider);
    const nativeApiKey = native?.auth?.apiKey;
    const supported = !HEADLESS_EXCLUDED_PROVIDERS.has(provider) && !!auth &&
      ambientMarkerValue(auth) !== true &&
      !(nativeApiKey && ambientMarkerValue(nativeApiKey) === true) &&
      !(native && this.legacyAmbientProviders.has(native));
    sessionKeyCapabilityLog.debug("Session key capability decided", {
      supported, hasAuth: !!auth, legacyAmbient: !!(native && this.legacyAmbientProviders.has(native)),
      headlessExcluded: HEADLESS_EXCLUDED_PROVIDERS.has(provider),
    });
    return supported;
  }

  /**
   * Auth/registration/model-count snapshot for one provider, for diagnostics
   * (GET /models/:provider/status).
   */
  async getProviderStatus(provider: string): Promise<ProviderStatus> {
    this.assertNotDisposed("getProviderStatus");
    await this.ensureDiscoveryComplete();

    const registeredProvider = this.modelRuntime!.getProvider(provider);
    const registered = !!registeredProvider;
    const supportsSessionApiKey = this.supportsSessionApiKey(provider);

    let modelCount: number;
    if (HEADLESS_EXCLUDED_PROVIDERS.has(provider)) {
      // Mirror getModels(): these providers need interactive browser OAuth and
      // are excluded from the catalog this process can ever actually serve, so
      // report 0 here too rather than the SDK's raw (unusable) model count.
      modelCount = 0;
    } else {
      modelCount = registeredProvider?.getModels().length ?? 0;
    }

    if (!registered) {
      providerStatusLog.debug("Provider status resolved", { provider, registered: false, modelCount, supportsSessionApiKey });
      return { provider, registered: false, modelCount, supportsSessionApiKey, authStatus: null, authCheck: null };
    }

    // Excluded providers are unusable headlessly (create() rejects them). Skip
    // checkAuth/getProviderAuthStatus to avoid OAuth side effects and noise.
    if (HEADLESS_EXCLUDED_PROVIDERS.has(provider)) {
      providerStatusLog.debug("Provider status skipped headless auth", { provider, registered: true, modelCount: 0, supportsSessionApiKey });
      return { provider, registered: true, modelCount: 0, supportsSessionApiKey, authStatus: null, authCheck: null };
    }

    let authCheck: ProviderStatus["authCheck"] = null;
    try {
      authCheck = (await this.modelRuntime!.checkAuth(provider)) ?? null;
    } catch (err) {
      // Auth exceptions may contain credentials: retain the traceback frames, not the message.
      providerStatusLog.warn("Provider auth check failed", { provider, errorType: err instanceof Error ? "Error" : typeof err,
        stackFrames: safeErrorFrames(err) });
    }

    let authStatus: ProviderStatus["authStatus"] = null;
    try {
      authStatus = this.modelRuntime!.getProviderAuthStatus(provider);
    } catch (err) {
      providerStatusLog.warn("Provider auth status failed", { provider, errorType: err instanceof Error ? "Error" : typeof err,
        stackFrames: safeErrorFrames(err) });
    }

    providerStatusLog.debug("Provider status resolved", { provider, registered, modelCount, supportsSessionApiKey, hasAuthCheck: !!authCheck, hasAuthStatus: !!authStatus });

    return { provider, registered, modelCount, supportsSessionApiKey, authStatus, authCheck };
  }

  /** Query the provider with this request's key, never the shared model registry. */
  async getModelsForApiKey(providerId: string, apiKey: string): Promise<KeyScopedModelsResult> {
    if (!isValidApiKey(apiKey) || typeof providerId !== "string" || !providerId.trim()) {
      throw httpError("Invalid provider or api_key", 400);
    }
    this.assertNotDisposed("getModelsForApiKey");
    await this.ensureInternalRuntime();
    const redact = createApiKeyRedactor(apiKey);
    if (!isKeyFree(providerId, redact)) throw httpError("Invalid provider or api_key", 400);
    const safeProviderId = redactDiagnostic(providerId, redact);
    if (!this.supportsSessionApiKey(providerId)) {
      keyModelDiscoveryLog.debug("Provider has no session API key capability", { providerId: safeProviderId, supported: false });
      throw httpError("Provider does not support session API keys", 400);
    }
    const provider = this.modelRuntime!.getProvider(providerId)!;
    // Only native endpoints and explicitly configured literal loopback OpenAI-compatible
    // gateways can receive request credentials.
    const kind = providerId === "anthropic" ? "anthropic" : providerId === "google" ? "google" : "openai";
    const catalog = provider.getModels();
    const openAiCompatible = catalog.length > 0 && catalog.every((model) =>
      model.api === "openai-completions" || model.api === "openai-responses");
    const canonical = builtinBaseUrls.get(providerId);
    // A canonical builtin's host is provider-owned, so listing there does not depend on the
    // catalog being uniformly OpenAI-shaped: OpenRouter also fronts Anthropic models, and the
    // uniformity check alone refused key-scoped listing for it entirely. The URL guard below
    // still pins the request to the exact canonical href before any key is sent, so relaxing
    // this gate does not weaken credential safety. Non-canonical providers (custom gateways,
    // loopback) keep the API-uniformity and per-model baseUrl checks unchanged.
    const canonicalBuiltin = canonical !== undefined && provider.baseUrl === canonical;
    const base = canonicalBuiltin
      ? canonical
      : (kind === "anthropic" || kind === "google")
        ? provider.baseUrl === canonical && catalog.length > 0 && catalog.every((model) => model.baseUrl === canonical) ? canonical : undefined
        : openAiCompatible && catalog.every((model) => model.baseUrl === provider.baseUrl)
          ? provider.baseUrl : undefined;
    if (typeof base !== "string" || !base) {
      keyModelDiscoveryLog.debug("Provider has no native model listing", { providerId: safeProviderId, modelListingSupported: false });
      return { models: [], modelListingSupported: false };
    }
    keyModelDiscoveryLog.debug("Resolved key-scoped listing base", { providerId: safeProviderId, canonicalBuiltin, manifestTrusted: this.trustedKeyScopedProviders.has(providerId), modelCount: catalog.length });
    let manifestTrusted = false;
    let url: URL;
    try {
      url = new URL(base);
      // Only provider-owned canonical hosts, literal loopback, or a custom provider
      // the admin explicitly flagged in the agent-dir models.json; DNS names for
      // unflagged custom gateways can rebind to private addresses after validation.
      const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
      const canonicalTrusted = canonical !== undefined && url.href === new URL(canonical).href;
      // Admin opt-in (startup manifest snapshot only): a custom (non-canonical)
      // provider flagged trustKeyScopedListing trusts exactly the baseUrl PINNED
      // in the startup manifest snapshot — the host the manifest's server
      // credential already went to at snapshot time. The runtime provider is
      // loaded lazily and may carry a baseUrl from a later models.json edit;
      // comparing against the snapshot (not the live provider.baseUrl, which
      // would be vacuously true) ensures an old flag can never authorize a new
      // host. Never for builtin IDs (an overridden builtin keeps its canonical
      // gate) and never a wider grant.
      const snapshot = this.trustedKeyScopedProviders.get(providerId);
      manifestTrusted = snapshot !== undefined && canonical === undefined && snapshot.baseUrl !== undefined &&
        url.href === snapshot.baseUrl && ["http:", "https:"].includes(url.protocol);
      if (manifestTrusted) {
        keyModelDiscoveryLog.debug("Key-scoped listing trust granted via pinned manifest baseUrl snapshot", { providerId: safeProviderId });
      } else if (snapshot !== undefined && canonical === undefined) {
        // Log only origin: the pinned URL can carry userinfo/query/hash/path tokens.
        keyModelDiscoveryLog.warn("Flagged provider no longer matches its startup trust snapshot; key-scoped listing refused", { providerId: safeProviderId, pinnedBaseUrl: sanitizeUrlForLog(snapshot.baseUrl) });
      }
      const trusted = canonicalTrusted || manifestTrusted;
      if ((!loopback && !trusted) || (canonical !== undefined && !trusted) || (loopback && kind !== "openai") ||
          (loopback && !["http:", "https:"].includes(url.protocol)) ||
          url.username || url.password || url.search || url.hash ||
          redact(url.href) !== url.href) {
        keyModelDiscoveryLog.debug("Provider listing endpoint not trusted", { providerId: safeProviderId, modelListingSupported: false });
        return { models: [], modelListingSupported: false };
      }
    } catch {
      keyModelDiscoveryLog.debug("Provider listing endpoint invalid", { providerId: safeProviderId, modelListingSupported: false });
      return { models: [], modelListingSupported: false };
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${kind === "anthropic" ? "/v1/models" : "/models"}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (kind === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (kind === "google") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const models: KeyScopedModel[] = [];
    const seenTokens = new Set<string>();
    const uniformCatalog = catalog.length > 0 && catalog.every((entry) => entry.api === catalog[0].api && entry.baseUrl === catalog[0].baseUrl);
    try {
      for (let page = 0; page < 10; page++) {
        const response = await fetch(url, {
          method: "GET", headers,
          redirect: "manual", signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          keyModelDiscoveryLog.error("Upstream rejected discovery credential", { status: response.status });
          throw httpError("API key rejected by provider", 401);
        }
        if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) throw httpError("Model discovery upstream failed", 502);
        const { bytes, hasBody } = await readBoundedResponseBytes(response, 1_048_576).catch(() => {
          throw httpError("Model discovery upstream failed", 502);
        });
        if (!hasBody) throw httpError("Model discovery upstream failed", 502);
        const payload: unknown = JSON.parse(utf8FatalDecoder.decode(bytes));
        const records = payload && typeof payload === "object"
          ? kind === "google" ? (payload as { models?: unknown }).models : (payload as { data?: unknown }).data
          : undefined;
        if (!Array.isArray(records)) throw httpError("Model discovery upstream failed", 502);
        for (const record of records) {
          if (!record || typeof record !== "object" || Array.isArray(record)) continue;
          const item = record as { id?: unknown; name?: unknown; displayName?: unknown; display_name?: unknown; capabilities?: unknown; supportedGenerationMethods?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown };
          const rawId = kind === "google" ? item.name : item.id;
          if (typeof rawId !== "string" || !rawId.trim() ||
              (kind === "google" && !rawId.startsWith("models/"))) continue;
          const id = kind === "google" ? rawId.slice("models/".length) : rawId;
          // Listing proves key visibility, not prompt support. Exclude only known non-chat families.
          if (kind === "google" ? !Array.isArray(item.supportedGenerationMethods) || !item.supportedGenerationMethods.includes("generateContent")
            : kind === "openai" && /^(?:(?:text|omni)-)?(?:embedding|moderation|image|audio|whisper|tts)(?:[-_/]|$)|^dall-e(?:[-_/]|$)|^gpt-(?:image|audio)(?:[-_/]|$)|^gpt-[\w.-]+-(?:tts|audio|image|transcribe)(?:[-_/]|$)/i.test(id)) continue;
          const name = kind === "google" ? item.displayName : kind === "anthropic" ? item.display_name : item.name;
          if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id) ||
              (name !== undefined && (typeof name !== "string" || name.length > 512 || /[\x00-\x1f\x7f]/.test(name)))) continue;
          const model: KeyScopedModel = { provider: providerId, id, name: name ?? id, source: "listing" };
          // Capabilities are included only when returned by this key-scoped upstream.
          if (kind === "google") {
            const capabilities: Record<string, unknown> = {};
            if (Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.every((v) => typeof v === "string")) capabilities.supportedGenerationMethods = item.supportedGenerationMethods;
            if (isPositiveSafeInt(item.inputTokenLimit)) capabilities.inputTokenLimit = item.inputTokenLimit;
            if (isPositiveSafeInt(item.outputTokenLimit)) capabilities.outputTokenLimit = item.outputTokenLimit;
            if (Object.keys(capabilities).length) model.capabilities = capabilities;
          }
          // Drop records that echo the key, including nested percent/JSON-escaped forms.
          // An unknown ID requires an unambiguous same-provider runtime template at create time.
          if ((uniformCatalog || this.modelRuntime!.getModel(providerId, id)) && isKeyFree(JSON.stringify(model), redact)) models.push(model);
        }
        const body = payload as { has_more?: unknown; last_id?: unknown; nextPageToken?: unknown };
        const token = kind === "anthropic" && body.has_more === true ? body.last_id
          : kind === "google" ? body.nextPageToken : undefined;
        if (kind === "anthropic" && body.has_more === true && !token) throw httpError("Model discovery upstream failed", 502);
        if (token === undefined || token === "") break;
        if (typeof token !== "string" || token.length > 2048 || seenTokens.has(token)) throw httpError("Model discovery upstream failed", 502);
        if (!isKeyFree(token, redact)) throw httpError("Model discovery upstream failed", 502);
        seenTokens.add(token);
        if (page === 9) throw httpError("Model discovery page limit exceeded", 502);
        url.searchParams.set(kind === "anthropic" ? "after_id" : "pageToken", token);
      }
      keyModelDiscoveryLog.debug("Key-scoped model discovery completed", { count: models.length, modelListingSupported: true });
      // Issue 912 extension: a flagged custom provider's response is the union of
      // the live listing and its manifest-configured models, so manually
      // configured models a gateway does not list still reach key-scoped callers.
      if (manifestTrusted) mergeManifestModels(models, this.trustedKeyScopedProviders.get(providerId)?.models, providerId, safeProviderId);
      return { models, modelListingSupported: true };
    } catch (err) {
      if (err && typeof err === "object" && "statusCode" in err) {
        keyModelDiscoveryLog.error("Key-scoped model discovery failed", { failure: "upstream", status: (err as HttpError).statusCode });
        throw err;
      }
      // Never log or return upstream exception text, which can include headers or URLs.
      keyModelDiscoveryLog.error("Key-scoped model discovery failed", { failure: "upstream" });
      throw httpError("Model discovery upstream failed", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Instantiate a Pi SDK `AgentSession` for a new sidecar session: resolves the
   * model (including key-scoped discovery fallback), isolates any per-session
   * API key behind a `ModelRuntime` proxy, wraps HTTP custom tools, loads the
   * Subagent extension only when requested, and returns the live session with
   * pricing provenance metadata.
   */
  async createSession({ sessionId, options, redact }: CreateRuntimeSessionInput): Promise<CreatedRuntimeSession> {
    this.assertNotDisposed("create");
    await this.ensureDiscoveryComplete();

    if (!options.model) {
      throw new Error(`Model is required. Use GET /models to list available models.`);
    }

    // Match getModels()/getProviderStatus(): these providers need interactive
    // browser OAuth and cannot work in this headless process — reject early
    // rather than letting callers bypass the catalog filter.
    if (HEADLESS_EXCLUDED_PROVIDERS.has(options.provider)) {
      throw httpError(
        `Provider '${options.provider}' requires interactive browser OAuth and cannot be used in this headless sidecar. Use GET /models to list available providers.`,
        400,
      );
    }

    await this.ensureInternalRuntime();

    const apiKey = options.apiKey;
    let model: any = this.modelRegistry!.find(options.provider, options.model)
      || this.modelRuntime!.getModel(options.provider, options.model)
      || getModel(options.provider as any, options.model)
      || undefined;
    if (!model && apiKey !== undefined && !isKeyFree(options.model, redact)) {
      throw httpError("Invalid model for session API key: [REDACTED]", 400);
    }
    if (!model && apiKey !== undefined && this.supportsSessionApiKey(options.provider)) {
      const listed = await this.getModelsForApiKey(options.provider, apiKey);
      const discovered = listed.models.find((candidate) => candidate.id === options.model);
      const templates = this.modelRuntime!.getProvider(options.provider)?.getModels() ?? [];
      const template = templates[0];
      if (discovered && template && templates.every((entry) => entry.api === template.api && entry.baseUrl === template.baseUrl)) {
        // Private to this session; never publish a key-scoped model to the shared runtime.
        const capabilities = discovered.capabilities;
        const positiveLimit = (value: unknown): number | undefined => {
          const valid = isPositiveSafeInt(value);
          sessionCreateLog.debug("Validating key-discovered model token limit", { session: sessionId, valid });
          return valid ? value : undefined;
        };
        // Issue 913: gateway listings (e.g. Acme) often omit token-limit
        // capabilities. Manifest-declared limits reach this path already
        // merged into the discovered entry's capabilities under the SAME
        // inputTokenLimit/outputTokenLimit keys (see mergeManifestModels),
        // so they are read directly from the entry; the snapshot lookup
        // below stays only as a fallback for entries that somehow lack limits.
        const manifestEntry = this.trustedKeyScopedProviders.get(options.provider)?.models.find((entry) => entry.id === discovered.id);
        const liveContextWindow = positiveLimit(capabilities?.inputTokenLimit);
        const liveMaxTokens = positiveLimit(capabilities?.outputTokenLimit);
        const contextWindow = liveContextWindow ?? manifestEntry?.contextWindow;
        const maxTokens = liveMaxTokens ?? manifestEntry?.maxTokens;
        if (manifestEntry && (!liveContextWindow || !liveMaxTokens) && contextWindow && maxTokens) {
          sessionCreateLog.debug("Key-discovered model limits sourced from the manifest snapshot", { session: sessionId, providerId: options.provider });
        }
        if (!contextWindow || !maxTokens) {
          // Unknown limits are a hard failure by design — never fabricate defaults.
          sessionCreateLog.error("Key-discovered model has no reliable token limits anywhere; refusing session creation", { session: sessionId, providerId: options.provider });
          throw httpError(
            "Model metadata missing reliable input/output token limits for unknown model. " +
            "Declare the model in the agent-dir models.json with contextWindow and maxTokens " +
            "to use it with a session API key.", 400);
        }
        model = {
          id: discovered.id, name: discovered.name, provider: options.provider,
          api: template.api, baseUrl: template.baseUrl,
          reasoning: false, input: ["text"],
          // Pi requires numeric prices and limits; zero means unknown pricing here, not free.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
        } satisfies Model<typeof template.api>;
        // Provenance, not the value: these zeros are fabricated, so a driver
        // reporting $0 must not be recorded as a genuinely free call.
        (model as Record<symbol, unknown>)[PRICING_UNKNOWN] = true;
        sessionCreateLog.debug("Session model resolved from key-scoped listing", { session: sessionId });
      }
    }
    if (!model) {
      throw httpError(
        `Model '${options.model}' not found for provider '${options.provider}'. Use GET /models to list available models.`, 400,
      );
    }

    if (apiKey !== undefined && !this.supportsSessionApiKey(options.provider)) {
      throw httpError("Selected provider does not support session API key authentication", 400);
    }
    // The original key is retained only by this session's runtime facade and redactor.
    sessionCreateLog.debug(`[sidecar] Model resolved: session=${sessionId}`);

    // Keep request credentials on this session's facade, not the shared registrar.
    // ModelRuntime's complete* methods call stream* on `this`, so intercept all
    // request entry points rather than relying on internal self-calls through the proxy.
    const modelRuntime = apiKey === undefined ? this.modelRuntime! : new Proxy(this.modelRuntime!, {
      get: (target, property) => {
        if (property === "getAvailableSnapshot") {
          return () => {
            const available = target.getAvailableSnapshot();
            return available.some((m) => m.provider === options.provider && m.id === model.id)
              ? available
              : [...available, model];
          };
        }
        if (property === "getAvailable") {
          return async (providerId?: string, availabilityOptions?: Parameters<ModelRuntime["getAvailable"]>[1]) => {
            availabilityOptions?.signal?.throwIfAborted();
            if (providerId && providerId !== options.provider) return target.getAvailable(providerId, availabilityOptions);
            // Never refresh the shared snapshot for this session's private key.
            const available = providerId
              ? target.getAvailableSnapshot().filter((m) => m.provider === providerId)
              : target.getAvailableSnapshot();
            return available.some((m) => m.provider === options.provider && m.id === model.id)
              ? available
              : [...available, model];
          };
        }
        if (property === "hasConfiguredAuth") {
          return (provider: string) => provider === options.provider || target.hasConfiguredAuth(provider);
        }
        if (property === "checkAuth") {
          return (provider: string, authOptions?: Parameters<ModelRuntime["checkAuth"]>[1]) =>
            provider === options.provider
              ? authOptions?.signal?.aborted
                ? Promise.reject(authOptions.signal.reason)
                : Promise.resolve({ type: "api_key" as const, source: "session" })
              : target.checkAuth(provider, authOptions);
        }
        if (property === "getAuth") {
          return (selected: string | { provider: string }, overrides?: Record<string, any>) => {
            const provider = typeof selected === "string" ? selected : selected.provider;
            return (target.getAuth as any)(selected, provider === options.provider ? { ...overrides, apiKey } : overrides);
          };
        }
        if (SESSION_API_KEY_RUNTIME_METHODS.has(property)) {
          return (selected: { provider: string }, ...args: any[]) => {
            if (selected.provider === options.provider) {
              args[1] = { ...args[1], apiKey };
            }
            return (target[property as keyof ModelRuntime] as (...arguments_: any[]) => any).call(target, selected, ...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const tools = options.tools ?? [...DEFAULT_TOOLS];
    const needsSubagent = tools.includes("subagent");
    // User sessions deliberately never load Vertex (google-vertex-claude is
    // already registered on the shared this.modelRuntime). Subagent only
    // registers the `subagent` tool, so omit it unless requested in `tools`.
    let extensionPaths: string[] = [];
    if (needsSubagent) {
      const { paths, subagentPathFound } = resolveSubagentExtensionOnce();
      // Fast-fail when the subagent extension file is missing before we build a loader.
      // Actual load success is verified after reload() below.
      if (!subagentPathFound) {
        throw httpError(
          "Tool 'subagent' was requested but the subagent extension could not be loaded. Check logs for details.",
          400,
        );
      }
      extensionPaths = paths;
    }
    sessionCreateLog.debug(`[sidecar] EXTENSIONS_LOADING: count=${extensionPaths.length}`);

    // Build custom tools from config — result is cast to any[] for Pi SDK ToolDefinition compatibility
    const customTools: any[] = (options.customTools || []).map((tool) => {
      if (!tool.name || typeof tool.name !== "string") {
        sessionCreateLog.warn(`[sidecar] Custom tool missing required 'name' field, skipping`);
        return null;
      }
      if (tool.http) {
        const httpConfig = normalizeHttpToolConfig(tool.http);
        const httpExecutor = createHttpToolExecutor(httpConfig);
        sessionCreateLog.debug(`[sidecar] Creating HTTP executor for custom tool: name=${redactDiagnostic(tool.name, redact)}, method=${httpConfig.method}`);
        const { http: _http, execute: _exec, ...rest } = tool;
        return {
          ...rest,
          label: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || {},
          execute: async (
            _toolCallId: string,
            params: Record<string, any>,
            signal: AbortSignal | undefined,
          ) => {
            const text = await httpExecutor(params, signal);
            return {
              content: [{ type: "text" as const, text }],
              details: {},
            };
          },
        };
      }
      return tool;
    }).filter((t): t is NonNullable<typeof t> => t != null);

    // Include custom tool names in the allowed tools list so the SDK
    // doesn't filter them out via allowedToolNames.
    const customToolNames = customTools.map((t: any) => t.name as string);
    const allToolNames = [...tools, ...customToolNames];
    sessionCreateLog.debug(`[sidecar] Tools configured: builtin=${tools.length}, custom=${customTools.length}`);

    // The Pi SDK's DefaultResourceLoader automatically discovers project-level resources
    // from {cwd}/.pi/ — including skills, prompts, extensions, and themes.
    // It also loads AGENTS.md from {cwd}/ root as project agent instructions.
    // Callers control resource loading by setting `cwd` to a directory containing these files.
    // agent_dir here is per-session ResourceLoader state only (user-level skills/prompts/
    // agents/extensions) plus, when unset, the configured internal agent dir. An explicit
    // agent_dir does not reconfigure the shared internal registrar / ModelRuntime and does
    // NOT contribute session settings — those always come from the startup snapshot of the
    // deployment agent dir (this.settingsSeed; see AGENTS.md §6).
    const agentDir = options.agentDir ?? this.agentDir;
    if (options.agentDir !== undefined) {
      sessionCreateLog.debug(`[sidecar] SESSION_AGENT_DIR: session=${sessionId}, custom=true, dir=${agentDir}`);
    }
    const settingsManager = createSessionSettingsManager(this.settingsSeed);
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: extensionPaths,
      systemPromptOverride: () => options.systemPrompt,
    });
    await loader.reload();

    if (tools.includes("subagent")) {
      const extResult = loader.getExtensions();
      const subagentLoaded = extResult.extensions.some(
        (ext) =>
          ext.tools.has("subagent") ||
          ext.path === SUBAGENT_EXTENSION ||
          ext.resolvedPath === SUBAGENT_EXTENSION,
      );
      if (!subagentLoaded) {
        const loadError = extResult.errors.find(
          (e) =>
            e.path === SUBAGENT_EXTENSION ||
            e.path.includes("subagent") ||
            (SUBAGENT_EXTENSION !== "" && e.path.endsWith("examples/extensions/subagent/index.ts")),
        );
        sessionCreateLog.error(`[sidecar] SUBAGENT_LOAD_FAILED: session=${sessionId}, error=${redactDiagnostic(loadError?.error ?? "extension_not_in_loader_result", redact)}`);
        throw httpError(
          "Tool 'subagent' was requested but the subagent extension could not be loaded. Check logs for details.",
          400,
        );
      }
    }

    sessionCreateLog.debug(`[sidecar] Session setup: id=${sessionId}, extensions=${extensionPaths.length}, tools=${customTools.length} custom`);

    const { session } = await createAgentSession({
      cwd: options.cwd,
      model,
      thinkingLevel: "off",
      tools: allToolNames as string[],
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      modelRuntime,
    });

    // Re-check after awaits: dispose() may have run while we were creating.
    // Discard the orphan session instead of leaking it past shutdown.
    if (this._disposed) {
      try {
        session.dispose();
      } catch (err) {
        sessionCreateLog.warn(`[sidecar] SESSION_ORPHAN_DISPOSE_FAILED: session=${sessionId}, error=${redactDiagnostic(err instanceof Error ? err.message : String(err), redact)}`);
      }
      throw httpError("Sidecar is shutting down", 503);
    }

    return {
      session,
      pricingKnown: hasKnownPricing(model),
      customToolNames,
    };
  }

  /**
   * Dispose the internal registrar runtime after all user sessions are gone.
   * Sets `_disposed = true` immediately, awaits any in-flight `runtimeInit`,
   * then tears down `internalRuntime` and clears all SDK refs. Idempotent.
   */
  async dispose(): Promise<void> {
    this._disposed = true;

    // Await in-flight ensureInternalRuntime() so a runtime that finishes after
    // `_disposed` is set is still assigned (or orphan-disposed) before we tear
    // down — otherwise we could return while createAgentSessionRuntime is still
    // running and leak the registrar forever.
    if (this.runtimeInit) {
      try {
        await this.runtimeInit;
      } catch (err) {
        logger.warn(`[sidecar] RUNTIME_INIT_AWAIT_ON_DISPOSE_FAILED: reason=await_error`, err);
      }
    }

    if (this.internalRuntime) {
      try {
        await this.internalRuntime.dispose();
        logger.info(`[sidecar] INTERNAL_RUNTIME_DISPOSED: ok=true`);
      } catch (err) {
        // Best-effort: clear refs even if dispose throws so shutdown can finish.
        logger.error(`[sidecar] INTERNAL_RUNTIME_DISPOSE_FAILED:`, err);
      }
      this.internalRuntime = undefined;
    }
    this.modelRuntime = undefined;
    this.modelRegistry = undefined;
    this.runtimeInit = undefined;
    this.refreshModelsJsonDiagnostic = undefined;
  }
}
