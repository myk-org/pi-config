/**
 * models.dev catalog cache + CLI/ACPX model metadata fill.
 *
 * Native pi providers are untouched. Only cli-* / acpx-* registration
 * looks up missing contextWindow / maxTokens / cost / input.
 * Reasoning comes from the discovered id (`-high`, `[effort=xhigh]`), not
 * from models.dev `reasoning`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "./logger.js";
import type { BuildRuntimeModelOptions } from "./create-runtime-provider.js";

const log = createLogger("models-dev");

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  modalities?: { input?: string[]; output?: string[] };
}

export interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface ModelsDevHit {
  provider: string;
  modelId: string;
  entry: ModelsDevModel;
}

export function modelsDevCachePath(home: string = homedir()): string {
  return join(home, ".pi", "pi-config", "models.dev.json");
}

function isCatalog(value: unknown): value is ModelsDevCatalog {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCache(path: string): ModelsDevCatalog | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isCatalog(parsed)) {
      log.warn("models.dev cache is not an object", path);
      return null;
    }
    log.debug("models.dev cache read", path);
    return parsed;
  } catch (err) {
    log.warn("models.dev cache read failed", path, err);
    return null;
  }
}

function cacheAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function writeCache(path: string, catalog: ModelsDevCatalog): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  log.debug("models.dev cache write tmp", tmp);
  try {
    writeFileSync(tmp, `${JSON.stringify(catalog)}\n`, "utf8");
    renameSync(tmp, path);
    log.info("models.dev cache written", path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // rename consumed tmp, or write never created it
    }
  }
}

async function fetchCatalog(
  fetchImpl: typeof fetch,
): Promise<ModelsDevCatalog | null> {
  log.debug("models.dev fetch", MODELS_DEV_URL);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const res = await fetchImpl(MODELS_DEV_URL, { signal: ac.signal });
    if (!res.ok) {
      log.warn("models.dev fetch HTTP", res.status);
      return null;
    }
    const parsed: unknown = await res.json();
    if (!isCatalog(parsed)) {
      log.warn("models.dev response is not an object");
      return null;
    }
    log.info("models.dev fetch ok", Object.keys(parsed).length, "providers");
    return parsed;
  } catch (err) {
    log.warn("models.dev fetch error", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface LoadModelsDevCatalogOptions {
  cachePath?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  ttlMs?: number;
}

/** Load models.dev api.json from disk cache, refreshing when older than 1 day. */
export async function loadModelsDevCatalog(
  opts: LoadModelsDevCatalogOptions = {},
): Promise<ModelsDevCatalog | null> {
  const cachePath = opts.cachePath ?? modelsDevCachePath();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? MODELS_DEV_TTL_MS;

  const age = cacheAgeMs(cachePath, nowMs);
  const cached = age !== null ? readCache(cachePath) : null;
  if (cached && age !== null && age <= ttlMs) {
    log.debug("models.dev cache fresh", Math.round(age / 1000), "s");
    return cached;
  }

  const fetched = await fetchCatalog(fetchImpl);
  if (fetched) {
    try {
      writeCache(cachePath, fetched);
    } catch (err) {
      log.warn("models.dev cache write failed", cachePath, err);
    }
    return fetched;
  }

  if (cached) {
    log.warn("models.dev refresh failed; using stale cache", cachePath);
    return cached;
  }
  log.warn("models.dev unavailable and no cache");
  return null;
}

const AGENT_PROVIDER_PREF: Record<string, readonly string[]> = {
  cursor: ["xai", "openai", "anthropic", "google"],
  claude: ["anthropic"],
  gemini: ["google"],
};

function stripBrackets(id: string): string {
  const i = id.indexOf("[");
  return i >= 0 ? id.slice(0, i) : id;
}

const SESSION_THINKING_LEVELS = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "max",
  "off",
] as const;

export type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number];

function isSessionThinkingLevel(value: string): value is SessionThinkingLevel {
  return (SESSION_THINKING_LEVELS as readonly string[]).includes(value);
}

function stripEffortSuffix(id: string): string {
  return id.replace(/-(?:xhigh|high|medium|low|minimal|max|off)$/i, "");
}

/** Thinking level encoded in a CLI/ACPX discovered id. */
export function thinkingLevelFromDiscoveredId(
  discoveredId: string,
): SessionThinkingLevel | undefined {
  const bracket = /\[([^\]]*)\]/.exec(discoveredId);
  if (bracket) {
    const effort = /(?:^|,)\s*effort=([^,\]]+)/i.exec(bracket[1]);
    const fromEffort = effort?.[1]?.trim().toLowerCase();
    if (fromEffort && isSessionThinkingLevel(fromEffort)) return fromEffort;
    const thinking = /(?:^|,)\s*thinking=([^,\]]+)/i.exec(bracket[1]);
    const fromThinking = thinking?.[1]?.trim().toLowerCase();
    if (fromThinking && isSessionThinkingLevel(fromThinking)) return fromThinking;
  }
  const noBr = stripBrackets(discoveredId);
  const suffix = /-(xhigh|high|medium|low|minimal|max|off)$/i.exec(noBr);
  const fromSuffix = suffix?.[1]?.toLowerCase();
  if (fromSuffix && isSessionThinkingLevel(fromSuffix)) return fromSuffix;
  return undefined;
}

export function discoveredIdFromRuntimeModelId(modelId: string): string {
  const i = modelId.indexOf(":");
  return i >= 0 ? modelId.slice(i + 1) : modelId;
}

export function isCliOrAcpxProvider(provider: string): boolean {
  return provider.startsWith("cli-") || provider.startsWith("acpx-");
}

/**
 * Set pi session thinking from a CLI/ACPX model id (`-high`, `[effort=xhigh]`).
 * Native providers are skipped. Returns the parsed level, or undefined if none.
 */
export function applyThinkingLevelFromModel(
  model: { id?: string; provider?: string } | undefined,
  setThinkingLevel: (level: SessionThinkingLevel) => void,
  getThinkingLevel?: () => string,
): SessionThinkingLevel | undefined {
  if (!model?.id || typeof model.provider !== "string") return undefined;
  if (!isCliOrAcpxProvider(model.provider)) {
    log.debug("thinking skip native provider", model.provider, model.id);
    return undefined;
  }
  const discovered = discoveredIdFromRuntimeModelId(model.id);
  const level = thinkingLevelFromDiscoveredId(discovered);
  if (!level) {
    log.debug("thinking none in id", model.provider, discovered);
    return undefined;
  }
  const current = getThinkingLevel?.();
  if (current === level) {
    log.debug("thinking already", level, model.provider, discovered);
    return level;
  }
  log.info("thinking from id", discovered, "->", level);
  setThinkingLevel(level);
  return level;
}

function claudeReorder(id: string): string | undefined {
  const m = /^(claude)-(\d+(?:\.\d+)*)-(opus|sonnet|haiku)(?:-.*)?$/i.exec(id);
  if (!m) return undefined;
  return `${m[1].toLowerCase()}-${m[3].toLowerCase()}-${m[2]}`;
}

/** Candidate catalog keys for a discovered CLI/ACPX model id. */
export function modelsDevLookupKeys(agent: string, discoveredId: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  };
  add(discoveredId);
  const noBr = stripBrackets(discoveredId);
  add(noBr);
  add(stripEffortSuffix(noBr));
  if (agent === "cursor" && noBr.toLowerCase().startsWith("cursor-")) {
    const rest = noBr.slice("cursor-".length);
    add(rest);
    add(stripEffortSuffix(rest));
  }
  const reordered = claudeReorder(stripEffortSuffix(noBr));
  if (reordered) add(reordered);
  const reorderedRaw = claudeReorder(noBr);
  if (reorderedRaw) add(reorderedRaw);
  for (const v of [...out]) {
    if (v.includes(".")) add(v.replace(/\./g, "-"));
  }
  return out;
}

function providerOrder(agent: string, catalog: ModelsDevCatalog): string[] {
  const preferred = AGENT_PROVIDER_PREF[agent] ?? [];
  const first = preferred.filter((p) => Object.hasOwn(catalog, p));
  const rest = Object.keys(catalog).filter((p) => !first.includes(p));
  return [...first, ...rest];
}

type ProviderModelIndex = Map<string, { modelId: string; entry: ModelsDevModel }>;
type CatalogLookupIndex = Map<string, ProviderModelIndex>;

const catalogIndexCache = new WeakMap<ModelsDevCatalog, CatalogLookupIndex>();

function catalogLookupIndex(catalog: ModelsDevCatalog): CatalogLookupIndex {
  const cached = catalogIndexCache.get(catalog);
  if (cached) {
    log.debug("models.dev catalog index reuse", cached.size, "providers");
    return cached;
  }
  const index: CatalogLookupIndex = new Map();
  for (const [provider, block] of Object.entries(catalog)) {
    const models = block?.models;
    if (!models) continue;
    const byKey: ProviderModelIndex = new Map();
    for (const [modelId, entry] of Object.entries(models)) {
      const hit = { modelId, entry };
      const idKey = modelId.toLowerCase();
      if (!byKey.has(idKey)) byKey.set(idKey, hit);
      const alt = entry.id?.toLowerCase();
      if (alt && !byKey.has(alt)) byKey.set(alt, hit);
    }
    index.set(provider, byKey);
  }
  catalogIndexCache.set(catalog, index);
  log.debug("models.dev catalog index built", index.size, "providers");
  return index;
}

export function lookupModelsDevModel(
  catalog: ModelsDevCatalog | null | undefined,
  agent: string,
  discoveredId: string,
): ModelsDevHit | undefined {
  if (!catalog) return undefined;
  const keys = modelsDevLookupKeys(agent, discoveredId);
  const index = catalogLookupIndex(catalog);
  for (const provider of providerOrder(agent, catalog)) {
    const byKey = index.get(provider);
    if (!byKey) continue;
    for (const key of keys) {
      const hit = byKey.get(key);
      if (hit) {
        log.debug("models.dev hit", agent, discoveredId, "->", provider, hit.modelId);
        return { provider, modelId: hit.modelId, entry: hit.entry };
      }
    }
  }
  log.debug("models.dev miss", agent, discoveredId);
  return undefined;
}

export function parseBracketContextTokens(discoveredId: string): number | undefined {
  const bracket = /\[([^\]]*)\]/.exec(discoveredId);
  if (!bracket) return undefined;
  const ctx = /(?:^|,)\s*context=([^,\]]+)/i.exec(bracket[1]);
  if (!ctx) return undefined;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(ctx[1].trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k") return Math.round(n * 1000);
  if (unit === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

function catalogInputModalities(
  entry: ModelsDevModel,
): ("text" | "image")[] | undefined {
  const raw = entry.modalities?.input;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const allowed = raw.filter((x): x is "text" | "image" => x === "text" || x === "image");
  return allowed.length > 0 ? allowed : undefined;
}

/** Fill only unset CLI/ACPX model fields from models.dev (and ACPX context=). */
export function fillRuntimeModelFromCatalog(
  opts: BuildRuntimeModelOptions,
  catalog: ModelsDevCatalog | null | undefined,
  agent: string,
  discoveredId: string,
): BuildRuntimeModelOptions {
  const hit = lookupModelsDevModel(catalog, agent, discoveredId);
  const entry = hit?.entry;
  const next: BuildRuntimeModelOptions = { ...opts };

  if (next.contextWindow == null) {
    const fromBracket = parseBracketContextTokens(discoveredId);
    if (fromBracket !== undefined) {
      next.contextWindow = fromBracket;
      log.debug("context from id bracket", discoveredId, fromBracket);
    } else if (typeof entry?.limit?.context === "number") {
      next.contextWindow = entry.limit.context;
    }
  }

  if (next.maxTokens == null && typeof entry?.limit?.output === "number") {
    next.maxTokens = entry.limit.output;
  }

  const thinking = thinkingLevelFromDiscoveredId(discoveredId);
  if (next.reasoning == null && thinking !== undefined) {
    next.reasoning = thinking !== "off";
    log.debug("reasoning from id", discoveredId, thinking, next.reasoning);
  }
  if (next.thinkingLevelMap == null && (thinking === "xhigh" || thinking === "max")) {
    next.thinkingLevelMap = { [thinking]: thinking };
  }

  if (next.cost == null && entry?.cost) {
    next.cost = {
      input: entry.cost.input ?? 0,
      output: entry.cost.output ?? 0,
      cacheRead: entry.cost.cache_read ?? 0,
      cacheWrite: entry.cost.cache_write ?? 0,
    };
  }

  if (next.input == null) {
    const modalities = entry ? catalogInputModalities(entry) : undefined;
    if (modalities) next.input = modalities;
  }

  return next;
}
