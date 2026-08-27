import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { createLogger } from "./logger.js";

const log = createLogger("openai-compatible-discovery");

export const OPENAI_COMPATIBLE_DISCOVERY_TTL_MS = 5 * 60 * 1000;

export interface ResolvedOpenAiCompatibleConnection {
  baseUrl?: string;
  apiKey?: string;
  headers?: ProviderHeaders;
}
export interface OpenAiCompatibleModelsRequest {
  /** Discovery-only /v1/models endpoint. Never use as a provider stream URL. */
  url: string;
  /** Resolved source endpoint for materialized provider streams. */
  streamBaseUrl: string;
  headers: Record<string, string>;
}
export interface OpenAiCompatibleModelRecord {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  input?: unknown;
  cost?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
}

/** Pi's models.json defaults for omitted static-model metadata. */
const PI_STATIC_MODEL_DEFAULTS = {
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
} as const;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * This is a Pi compatibility declaration, not discovery filtering or a claim
 * that the source endpoint accepts images. The /v1/models payload does not
 * reliably advertise capabilities, so unknown models must remain selectable.
 */
function materializeInput(value: unknown): ("text" | "image")[] {
  if (Array.isArray(value) && value.every((item) => item === "text" || item === "image"))
    return [...value] as ("text" | "image")[];
  return ["text", "image"];
}

function materializeCost(value: unknown): Model<Api>["cost"] {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    input: finiteNumber(source.input, PI_STATIC_MODEL_DEFAULTS.cost.input),
    output: finiteNumber(source.output, PI_STATIC_MODEL_DEFAULTS.cost.output),
    cacheRead: finiteNumber(source.cacheRead, PI_STATIC_MODEL_DEFAULTS.cost.cacheRead),
    cacheWrite: finiteNumber(source.cacheWrite, PI_STATIC_MODEL_DEFAULTS.cost.cacheWrite),
  };
}
export interface CachedOpenAiCompatibleDiscovery<T> {
  models: readonly T[];
  /** A successful refresh produced this cache entry, even if it found no models. */
  hasSnapshot: boolean;
  stale: boolean;
}
export interface EligibleOpenAiCompatibleProvider {
  id: string;
  headers?: Record<string, string>;
}

/** Session transcript text for one successfully registered configured provider. */
export function formatOpenAiCompatibleDiscoverySummary(
  providerId: string,
  discoveredModelCount: number,
): string {
  log.debug("formatting discovery summary", { providerId, discoveredModelCount });
  return `Providers: ${providerId} (${discoveredModelCount})`;
}

/** Match pi's getModelsPath(): PI_CODING_AGENT_DIR, then ~/.pi/agent/models.json. */
export function resolveOpenAiCompatibleModelsPath(
  agentDir?: string | null,
): string {
  const configuredAgentDir =
    typeof agentDir === "string" ? agentDir.trim() : "";
  const envAgentDir =
    typeof process.env.PI_CODING_AGENT_DIR === "string"
      ? process.env.PI_CODING_AGENT_DIR.trim()
      : "";
  return join(
    configuredAgentDir || envAgentDir || join(homedir(), ".pi", "agent"),
    "models.json",
  );
}

/** Pi accepts a BOM, // comments, and trailing commas in models.json. */
function parsePiModelsJson(content: string): unknown {
  const withoutBom =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const withoutComments = withoutBom
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
      match[0] === '"' ? match : "",
    )
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail) => tail ?? (match[0] === '"' ? match : ""),
    );
  return JSON.parse(withoutComments);
}

export type OpenAiCompatibleModelsConfigStatus =
  "eligible-providers" | "no-eligible-providers" | "unreadable" | "malformed";

export interface EligibleOpenAiCompatibleProviderConfigsResult {
  status: OpenAiCompatibleModelsConfigStatus;
  providers: EligibleOpenAiCompatibleProvider[];
}

/**
 * Read the extension-owned opt-in bit and only schema-compatible raw headers.
 * Statuses deliberately exclude paths, configuration values, and parser errors.
 */
export function findEligibleOpenAiCompatibleProviderConfigsResult(
  options: { modelsPath?: string; agentDir?: string | null } = {},
): EligibleOpenAiCompatibleProviderConfigsResult {
  let content: string;
  try {
    content = readFileSync(
      options.modelsPath ?? resolveOpenAiCompatibleModelsPath(options.agentDir),
      "utf8",
    );
  } catch {
    return { status: "unreadable", providers: [] };
  }

  let parsed: unknown;
  try {
    parsed = parsePiModelsJson(content);
  } catch {
    return { status: "malformed", providers: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { status: "malformed", providers: [] };
  const providers = (parsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    return { status: "no-eligible-providers", providers: [] };
  const eligible = Object.entries(providers).flatMap(([id, config]) => {
    if (!config || typeof config !== "object" || Array.isArray(config))
      return [];
    const provider = config as Record<string, unknown>;
    if (
      provider.api !== "openai-completions" ||
      provider.discoverModels !== true
    )
      return [];
    const headers = provider.headers;
    if (
      headers !== undefined &&
      (!headers ||
        typeof headers !== "object" ||
        Array.isArray(headers) ||
        Object.values(headers).some((value) => typeof value !== "string"))
    )
      return [];
    return [{ id, headers: headers as Record<string, string> | undefined }];
  });
  return {
    status:
      eligible.length > 0 ? "eligible-providers" : "no-eligible-providers",
    providers: eligible,
  };
}

export function findEligibleOpenAiCompatibleProviderConfigs(
  options: { modelsPath?: string; agentDir?: string | null } = {},
): EligibleOpenAiCompatibleProvider[] {
  return findEligibleOpenAiCompatibleProviderConfigsResult(options).providers;
}

export function findEligibleOpenAiCompatibleProviders(
  options: { modelsPath?: string; agentDir?: string | null } = {},
): string[] {
  return findEligibleOpenAiCompatibleProviderConfigs(options).map(
    (provider) => provider.id,
  );
}

function piBashShellConfig(shell: string): PiShellConfig {
  const normalized = shell.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
    ? { shell, args: ["-s"], commandTransport: "stdin" }
    : { shell, args: ["-c"] };
}

/** Mirrors Pi's getShellConfig fallback order when its public resolver is unavailable. */
function getPiShellConfig(): PiShellConfig {
  if (process.platform !== "win32") {
    if (existsSync("/bin/bash")) return piBashShellConfig("/bin/bash");
    try {
      const result = spawnSync("which", ["bash"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.status === 0 && result.stdout) {
        const shell = String(result.stdout).trim().split(/\r?\n/)[0];
        if (shell) return piBashShellConfig(shell);
      }
    } catch {}
    return { shell: "sh", args: ["-c"] };
  }
  const paths = [
    process.env.ProgramFiles &&
      `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env["ProgramFiles(x86)"] &&
      `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`,
  ].filter((path): path is string => Boolean(path));
  for (const shell of paths)
    if (existsSync(shell)) return piBashShellConfig(shell);
  try {
    const result = spawnSync("where", ["bash.exe"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const shell = result.stdout
      ? String(result.stdout).trim().split(/\r?\n/)[0]
      : undefined;
    if (result.status === 0 && shell && existsSync(shell))
      return piBashShellConfig(shell);
  } catch {}
  throw new Error("No bash shell found");
}

type PiShellConfig = {
  shell: string;
  args: readonly string[];
  commandTransport?: "argv" | "stdin";
};
export interface OpenAiCompatibleHeaderResolutionOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
  getShellConfig?: () => PiShellConfig;
  spawnSync?: (
    shell: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => { error?: { code?: string }; status?: number | null; stdout?: string };
  execSync?: (command: string, options: Record<string, unknown>) => string;
}

async function resolvePiConfigCommand(
  command: string,
  options: OpenAiCompatibleHeaderResolutionOptions,
): Promise<string | undefined> {
  const executeDefault = () => {
    try {
      return (
        (options.execSync ?? execSync)(command, {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim() || undefined
      );
    } catch {
      return undefined;
    }
  };
  if ((options.platform ?? process.platform) !== "win32")
    return executeDefault();
  try {
    const shellConfig = options.getShellConfig
      ? options.getShellConfig()
      : await import("@earendil-works/pi-coding-agent")
          .then(({ getShellConfig }) => getShellConfig())
          .catch(() => getPiShellConfig());
    const { shell, args, commandTransport } = shellConfig;
    const commandFromStdin = commandTransport === "stdin";
    const result = (options.spawnSync ?? spawnSync)(
      shell,
      commandFromStdin ? args : [...args, command],
      {
        encoding: "utf8",
        input: commandFromStdin ? command : undefined,
        timeout: 10_000,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      },
    );
    const error = result.error;
    if (error && "code" in error && error.code === "ENOENT")
      return executeDefault();
    if (error || result.status !== 0) return undefined;
    return result.stdout
      ? String(result.stdout).trim() || undefined
      : undefined;
  } catch {
    return executeDefault();
  }
}

function resolvePiConfigTemplate(
  value: string,
  env: Record<string, string> | undefined,
): string | undefined {
  return value.replace(
    /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      if (match === "$$") return "$";
      if (match === "$!") return "!";
      const envValue = env?.[braced ?? bare] || process.env[braced ?? bare];
      if (envValue === undefined)
        throw new Error("unresolved configured header");
      return envValue;
    },
  );
}

/** Match Pi's uncached literal, environment-template, escape, and command header resolution. */
export async function resolveStaticOpenAiCompatibleHeaders(
  headers: Record<string, string> | undefined,
  options: OpenAiCompatibleHeaderResolutionOptions = {},
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const result = value.startsWith("!")
      ? await resolvePiConfigCommand(value.slice(1), options)
      : resolvePiConfigTemplate(value, options.env);
    if (result === undefined) throw new Error("unresolved configured header");
    resolved[name] = result;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function buildOpenAiCompatibleModelsRequest(
  connection: ResolvedOpenAiCompatibleConnection,
): OpenAiCompatibleModelsRequest {
  if (!connection.baseUrl)
    throw new Error("OpenAI-compatible provider has no resolved base URL");
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    throw new Error(
      "OpenAI-compatible provider has an invalid resolved base URL",
    );
  }
  url.hash = "";
  // The source URL can carry required routing query parameters. Capture it
  // before deriving the discovery-only endpoint so models never stream to
  // /v1/models. URL serialization also drops the fragment safely.
  const streamBaseUrl = url.toString();
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/v1$/i.test(basePath)
    ? `${basePath}/models`
    : `${basePath}/v1/models`;
  const modelsUrl = url.toString();
  const headers = Object.fromEntries(
    Object.entries(connection.headers ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  // Pi passes apiKey to pi-ai's OpenAI client. That client synthesizes a Bearer
  // header unless configured headers already provide authorization. Reproduce
  // that request behavior for this raw GET without inspecting provider config.
  if (
    connection.apiKey &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
  ) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  }
  return { url: modelsUrl, streamBaseUrl, headers };
}

/** Remove resolved credentials from diagnostics before they leave the request path. */
export function redactOpenAiCompatibleDiagnostic(
  message: string,
  connection: ResolvedOpenAiCompatibleConnection,
): string {
  let redacted = message;
  const headerValues = Object.values(connection.headers ?? {}).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  // Transports often quote just the credential portion of an authentication
  // header in errors (for example, "Basic <credential>"). Redact those
  // portions as well as the complete configured header value.
  const headerTokens = headerValues.flatMap((value) =>
    value.split(/[\s,;=]+/).filter(Boolean),
  );
  const secrets = [connection.apiKey, ...headerValues, ...headerTokens]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets)
    redacted = redacted.split(secret).join("[redacted]");
  // Fetch errors commonly echo URLs. Query values and fragments can be just as
  // sensitive as headers, so remove both wholesale rather than guessing keys.
  return redacted.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      if (url.username || url.password) {
        url.username = "[redacted]";
        url.password = "";
      }
      if (url.search) url.search = "?[redacted]";
      if (url.hash) url.hash = "#[redacted]";
      return url.toString();
    } catch {
      return rawUrl
        .replace(/\/\/[^/?#@\s]+@/, "//[redacted]@")
        .replace(/\?[^#\s]*/, "?[redacted]")
        .replace(/#[^\s]*/, "#[redacted]");
    }
  });
}

/** A stable SHA-256 key that scopes cache entries without retaining credentials. */
export function openAiCompatibleConnectionFingerprint(
  connection: ResolvedOpenAiCompatibleConnection,
): string {
  const headers = Object.entries(connection.headers ?? {})
    .filter(([, value]) => value !== null)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl: connection.baseUrl ?? "",
        apiKey: connection.apiKey ?? "",
        headers,
      }),
    )
    .digest("hex");
}

/**
 * Expose IDs exactly as the configured proxy reported them. A source record's
 * string name is presentation-only; no external catalog enriches this data.
 */
export function materializeOpenAiCompatibleModels(
  records: readonly OpenAiCompatibleModelRecord[],
  baseUrl: string,
  providerId: string,
): Model<Api>[] {
  const models: Model<Api>[] = [];
  const seenIds = new Set<string>();
  for (const record of records) {
    if (typeof record.id !== "string" || seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    models.push({
      id: record.id,
      name: typeof record.name === "string" ? record.name : record.id,
      api: "openai-completions",
      provider: providerId,
      baseUrl,
      reasoning: typeof record.reasoning === "boolean"
        ? record.reasoning
        : PI_STATIC_MODEL_DEFAULTS.reasoning,
      input: materializeInput(record.input),
      cost: materializeCost(record.cost),
      contextWindow: positiveFiniteNumber(record.contextWindow, PI_STATIC_MODEL_DEFAULTS.contextWindow),
      maxTokens: positiveFiniteNumber(record.maxTokens, PI_STATIC_MODEL_DEFAULTS.maxTokens),
    });
  }
  return models;
}

/** In-memory, bounded last-known-good cache. Failed results never replace it. */
export class OpenAiCompatibleDiscoveryCache<T> {
  private readonly entries = new Map<
    string,
    {
      result: readonly T[];
      hasSnapshot: boolean;
      updatedAt: number;
      refreshing?: Promise<CachedOpenAiCompatibleDiscovery<T>>;
    }
  >();
  constructor(
    private readonly options: {
      ttlMs?: number;
      maxScopes?: number;
    } = {},
  ) {}

  clear(): void {
    this.entries.clear();
  }

  async get(
    refresh: () => Promise<readonly T[]>,
    options: { forceRefresh?: boolean; nowMs?: number; cacheKey?: string } = {},
  ): Promise<CachedOpenAiCompatibleDiscovery<T>> {
    const nowMs = options.nowMs ?? Date.now();
    const cacheKey = options.cacheKey ?? "default";
    const ttlMs = this.options.ttlMs ?? OPENAI_COMPATIBLE_DISCOVERY_TTL_MS;
    let entry = this.entries.get(cacheKey);
    if (!entry) {
      const maxScopes = this.options.maxScopes ?? 32;
      if (this.entries.size >= maxScopes)
        this.entries.delete(this.entries.keys().next().value!);
      entry = { result: [], hasSnapshot: false, updatedAt: 0 };
      this.entries.set(cacheKey, entry);
    }
    if (
      !options.forceRefresh &&
      entry.updatedAt > 0 &&
      nowMs - entry.updatedAt <= ttlMs
    ) {
      return {
        models: entry.result,
        hasSnapshot: entry.hasSnapshot,
        stale: false,
      };
    }
    if (entry.refreshing) return entry.refreshing;

    entry.refreshing = (async () => {
      try {
        const next = await refresh();
        // The configured provider decides the catalog. The response byte limit
        // protects memory without dropping valid model IDs.
        entry!.result = next;
        entry!.hasSnapshot = true;
        entry!.updatedAt = nowMs;
        return { models: entry!.result, hasSnapshot: true, stale: false };
      } catch {
        return {
          models: entry!.result,
          hasSnapshot: entry!.hasSnapshot,
          stale: entry!.hasSnapshot,
        };
      } finally {
        entry!.refreshing = undefined;
      }
    })();
    return entry.refreshing;
  }
}
