/**
 * Settings TUI helpers — pure functions extracted for testability.
 * No pi-coding-agent or pi-tui dependencies.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join as joinPath, resolve, sep } from "node:path";
import stripJsonComments from "strip-json-comments";
import {
  type SettingsKeyDef,
  SETTINGS_KEYS,
  getSetting,
  getSettingsPath,
  getGlobalSettingsPath,
} from "./project-settings.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("settings_tui");

/** Sentinel value displayed for empty strings in the TUI. Centralized to prevent divergence. */
export const EMPTY_VALUE_SENTINEL = "(empty)";

const LOG_PREFIX = "[settings-tui]";
const loggedErrors = new Set<string>();
function logWarn(msg: string): void {
  // Deduplicate: only log each unique message once per session to avoid spam
  if (loggedErrors.has(msg)) return;
  loggedErrors.add(msg);
  try {
    const logDir = joinPath(homedir(), ".pi", "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = joinPath(logDir, "settings-tui.log");
    appendFileSync(logPath, `${new Date().toISOString()} ${LOG_PREFIX} ${msg}\n`);
  } catch {}
}

const loggedDebug = new Set<string>();
function logDebug(msg: string): void {
  // Deduplicate per message — these sit on parse paths that run often
  if (loggedDebug.has(msg)) return;
  loggedDebug.add(msg);
  try {
    const logDir = joinPath(homedir(), ".pi", "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = joinPath(logDir, "settings-tui.log");
    appendFileSync(logPath, `${new Date().toISOString()} ${LOG_PREFIX} DEBUG ${msg}\n`);
  } catch {}
}

// ── Category grouping ───────────────────────────────────────────────

export interface CategoryDef {
  label: string;
  keys: string[];
}

// Build CATEGORIES dynamically from schema `group` field.
// Preserves insertion order from settings-keys.json — groups appear
// in the order their first key is declared.
export const CATEGORIES: CategoryDef[] = (() => {
  const groupMap = new Map<string, string[]>();
  for (const [key, def] of Object.entries(SETTINGS_KEYS)) {
    const group = (def as any).group || "Other";
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(key);
  }
  return [...groupMap.entries()].map(([label, keys]) => ({ label, keys }));
})();

// ── Source detection ─────────────────────────────────────────────────

export type SettingSource = "P" | "G" | "E" | "D";

export function detectSource(key: string, def: SettingsKeyDef, cwd: string): SettingSource {
  // Check project settings file
  const projectPath = getSettingsPath(cwd);
  if (existsSync(projectPath)) {
    try {
      const raw = JSON.parse(stripJsonComments(readFileSync(projectPath, "utf-8")));
      if (typeof raw === "object" && raw !== null && key in raw) return "P";
    } catch (e: any) { logWarn(`parse error in ${projectPath}: ${e?.message?.slice(0, 100)}`); }
  }

  // Check global settings file (honors setGlobalSettingsPath for tests)
  const globalPath = getGlobalSettingsPath();
  if (existsSync(globalPath)) {
    try {
      const raw = JSON.parse(stripJsonComments(readFileSync(globalPath, "utf-8")));
      if (typeof raw === "object" && raw !== null && key in raw) return "G";
    } catch (e: any) { logWarn(`parse error in ${globalPath}: ${e?.message?.slice(0, 100)}`); }
  }

  // Check env var
  if (def.env && process.env[def.env] !== undefined && process.env[def.env] !== "") return "E";

  return "D";
}

// ── Value formatting ────────────────────────────────────────────────

export function formatValue(key: string, value: unknown, def: SettingsKeyDef): string {
  if (value === undefined || value === null) return String(def.default);

  // Mask secret-like keys
  const SECRET_PATTERNS = /token|secret|password|auth/i;
  const looksSecret = SECRET_PATTERNS.test(key) || (typeof def.env === "string" && SECRET_PATTERNS.test(def.env));
  if (def.type === "string" && looksSecret && typeof value === "string" && value !== "") {
    return value.length > 4 ? "••••" + value.slice(-4) : "••••••••";
  }

  switch (def.type) {
    case "bool":
    case "bool_enable":
      return value ? "true" : "false";
    case "bool_or_string":
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    case "int":
    case "port":
    case "number":
      return String(value);
    case "string":
      return value === "" ? EMPTY_VALUE_SENTINEL : String(value);
    case "agent_list":
      if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : EMPTY_VALUE_SENTINEL;
      return String(value);
    case "string_list":
      if (Array.isArray(value)) return value.length > 0 ? `${value.length} pattern(s)` : EMPTY_VALUE_SENTINEL;
      return String(value);
    case "agent_overrides":
      if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value);
        return entries.length > 0 ? `${entries.length} override(s)` : "(none)";
      }
      return "(none)";
    default:
      return String(value);
  }
}

// ── Parse raw value for saving ──────────────────────────────────────

export function parseRawValue(key: string, rawValue: string, def: SettingsKeyDef): unknown {
  switch (def.type) {
    case "bool":
    case "bool_enable":
      return rawValue === "true";

    case "bool_or_string":
      if (rawValue === "true") return true;
      if (rawValue === "false") return false;
      return rawValue;

    case "int":
    case "port": {
      if (rawValue.trim() === "") return undefined;
      const n = Number(rawValue);
      return Number.isFinite(n) && Number.isInteger(n) ? n : def.default;
    }

    case "number": {
      if (rawValue.trim() === "") return undefined;
      const n = Number(rawValue);
      return Number.isFinite(n) ? n : def.default;
    }

    case "string":
      return rawValue === EMPTY_VALUE_SENTINEL ? "" : rawValue;

    case "agent_list":
      if (!rawValue || rawValue === EMPTY_VALUE_SENTINEL) return [];
      return rawValue.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    case "string_list": {
      // StringListSubmenu commits JSON; accept a hand-typed single pattern too
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed)) {
          const list = parsed.filter((e): e is string => typeof e === "string" && e.length > 0);
          logDebug(`string_list parsed ${list.length} entrie(s) for ${key}`);
          return list;
        }
      } catch {
        logDebug(`string_list raw value for ${key} is not JSON — treating as a single pattern`);
      }
      return rawValue.trim() !== "" ? [rawValue.trim()] : [];
    }

    default:
      return rawValue;
  }
}

// ── Scope-aware file read/write ─────────────────────────────────────

export function getFilePathForScope(scope: "project" | "global", cwd: string): string {
  if (scope === "project") {
    return getSettingsPath(cwd);
  }
  return getGlobalSettingsPath();
}

export function readSettingsFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw;
  } catch (e: any) { logWarn(`parse error in ${filePath}: ${e?.message?.slice(0, 100)}`); }
  return null;
}

/** Thrown instead of writing when the target file cannot be parsed. A settings file that a
 *  human can still repair by hand must never be replaced by generated content. */
export class SettingsFileCorruptError extends Error {
  constructor(readonly filePath: string) {
    super(`refusing to overwrite unparseable settings file: ${filePath}`);
    this.name = "SettingsFileCorruptError";
    log.error("settings_write_refused_corrupt", { filePath });
  }
}

/** `realpath` of the nearest path that exists, so a symlinked parent cannot hide the target. */
function nearestRealPath(target: string): string {
  const absolute = resolve(target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? joinPath(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** The cwd whose settings govern this file: the project root for a project file, and never a
 *  project override for a global one. A removed cwd must not block a save. */
function settingCwdFor(filePath: string): string | null {
  const parent = dirname(filePath);
  if (basename(parent) === ".pi") {
    const root = dirname(parent);
    if (root === homedir()) return null; // global file: no project scope applies
    return root;
  }
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/** Backup retention for this file: project setting where a project owns it, env/default for
 *  a global file — one project can never change another's retention. */
function backupCountFor(filePath: string): number {
  const def = SETTINGS_KEYS.settings_backup_count;
  const fallback = Number(def?.default ?? 5);
  const min = Number(def?.min ?? 0);
  const max = Number(def?.max ?? 20);
  // An out-of-range or non-integer value must not decide retention: `-1` would prune every
  // backup and write none, and a huge value would rotate far past the documented limit.
  const accept = (value: number): number | null =>
    Number.isInteger(value) && value >= min && value <= max ? value : null;

  // Validate the env value FIRST, for its diagnostic: `getSetting` substitutes the default
  // before the range check can see it, so a malformed env var would otherwise be logged only
  // on a global save and silently swallowed on a project one.
  const raw = process.env.PI_SETTINGS_BACKUP_COUNT;
  const envCount = raw !== undefined && raw.trim() !== "" ? accept(Number(raw)) : null;
  if (raw !== undefined && raw.trim() !== "" && envCount === null) {
    log.warn("settings_backup_count_invalid", { raw, min, max, fallback });
  }

  const cwd = settingCwdFor(filePath);
  if (cwd !== null) {
    const resolved = accept(Number(getSetting(cwd, "settings_backup_count")));
    if (resolved !== null) return resolved;
  }
  return envCount ?? fallback;
}

/** Drop slots beyond the configured count, so lowering retention removes old copies. */
function pruneExtraBackups(filePath: string, count: number): void {
  const prefix = `${basename(filePath)}.bak.`;
  let entries: string[] = [];
  try {
    entries = readdirSync(dirname(filePath));
  } catch (e: any) {
    log.warn("settings_backup_prune_scan_failed", { filePath, error: e?.message });
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const slot = Number(name.slice(prefix.length));
    if (!Number.isFinite(slot) || slot <= count) continue;
    try {
      unlinkSync(joinPath(dirname(filePath), name));
    } catch (e: any) {
      log.warn("settings_backup_prune_failed", { filePath, slot: name, error: e?.message });
    }
  }
}

/** Thrown when the previous version could not be preserved, so nothing is written. */
export class SettingsBackupError extends Error {
  constructor(readonly filePath: string, readonly cause?: unknown) {
    super(`refusing to write settings without a backup: ${filePath}`);
    this.name = "SettingsBackupError";
  }
}

/** Depth of the interactive editing session (`/pi-config-settings`). While it is open the file
 *  is snapshotted ONCE, on the first change: a user who adjusts five values must not rotate the
 *  pre-visit state out of existence. Writes outside the TUI are discrete actions and keep their
 *  own backup. */
let editSessionDepth = 0;
const backedUpInSession = new Set<string>();
/** Files this visit CREATED: their pre-visit state is "absent", so backing up the first partial
 *  version would misrepresent it. */
const createdInSession = new Set<string>();
/** Visit snapshots waiting to be promoted into the numbered chain when the visit closes. */
const visitSnapshots = new Set<string>();

/** A visit keeps its own copy, so an external save during the visit (which rotates the numbered
 *  chain) cannot destroy the state the user opened the TUI with. The process id is part of the
 *  name: two TUI processes editing one file must not overwrite each other's restore point. */
function visitSnapshotPath(filePath: string): string {
  return `${filePath}.bak.visit-${process.pid}`;
}

/** Promote one visit snapshot into the numbered chain (`.bak.1`), shifting older copies. */
function promoteSnapshot(snapshotPath: string): void {
  const filePath = snapshotPath.replace(/\.bak\.visit-\d+$/, "");
  if (!existsSync(snapshotPath)) return;
  const count = backupCountFor(filePath);
  if (count <= 0) {
    unlinkSync(snapshotPath);
    return;
  }
  const oldest = settingsBackupPath(filePath, count);
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let slot = count - 1; slot >= 1; slot--) {
    const from = settingsBackupPath(filePath, slot);
    if (existsSync(from)) renameSync(from, settingsBackupPath(filePath, slot + 1));
  }
  renameSync(snapshotPath, settingsBackupPath(filePath, 1));
}

/** Snapshots left by a process that is gone are promoted instead of being overwritten by the next
 *  visit — a crash must cost nothing. A snapshot owned by a LIVE process is left alone. */
function reapStaleVisitSnapshots(filePath: string): void {
  const dir = dirname(filePath);
  const marker = `${basename(filePath)}.bak.visit-`;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(marker)) continue;
    const pid = Number(name.slice(marker.length));
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // owner still alive
    } catch {
      /* dead: fall through and promote its snapshot */
    }
    try {
      promoteSnapshot(joinPath(dir, name));
      log.info("settings_visit_snapshot_recovered", { filePath, pid });
    } catch (e: any) {
      log.warn("settings_visit_snapshot_recover_failed", { filePath, pid, error: e?.message });
    }
  }
}

/** Move each visit snapshot into `.bak.1` (shifting the chain), once, when the visit closes. */
function promoteVisitSnapshots(): void {
  const failed = new Set<string>();
  for (const snapshot of [...visitSnapshots]) {
    try {
      promoteSnapshot(snapshot);
    } catch (e: any) {
      // Kept in the set so a retry can still promote it; if the process ends first, the next
      // visit reaps it by pid.
      failed.add(snapshot);
      log.warn("settings_visit_snapshot_promote_failed", { snapshot, error: e?.message });
    }
  }
  visitSnapshots.clear();
  for (const snapshot of failed) visitSnapshots.add(snapshot);
}

export function beginSettingsEditSession(): void {
  editSessionDepth++;
}

export function endSettingsEditSession(): void {
  editSessionDepth = Math.max(0, editSessionDepth - 1);
  if (editSessionDepth === 0) {
    promoteVisitSnapshots();
    backedUpInSession.clear();
    createdInSession.clear();
  }
}

/** True when this write should rotate a backup. Only the settings TUI asks for dedupe; a browser
 *  save or an allowlist approval arriving mid-visit is a separate action and keeps its own
 *  restore point. */
function shouldBackUp(filePath: string, dedupe: boolean): boolean {
  if (!dedupe || editSessionDepth === 0) return true;
  if (createdInSession.has(filePath)) return false;
  return !backedUpInSession.has(filePath);
}

/** Path of the newest previous-version copy kept next to a settings file. */
export function settingsBackupPath(filePath: string, slot = 1): string {
  return `${filePath}.bak.${slot}`;
}

/** Keep `count` previous versions: shift `.bak.N-1` → `.bak.N`, then current → `.bak.1`.
 *  A count of 0 disables backups. Failures never block the write — they only log. */
function rotateSettingsBackups(filePath: string, count: number): void {
  if (count <= 0) return;
  try {
    const oldest = settingsBackupPath(filePath, count);
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let slot = count - 1; slot >= 1; slot--) {
      const from = settingsBackupPath(filePath, slot);
      if (existsSync(from)) renameSync(from, settingsBackupPath(filePath, slot + 1));
    }
    copyFileSync(filePath, settingsBackupPath(filePath, 1));
  } catch (e: any) {
    // A write without its backup breaks the one guarantee this function exists for: if the
    // new content is wrong there is nothing to fall back to.
    log.error("settings_backup_failed", { filePath, error: e?.message });
    throw new SettingsBackupError(filePath, e);
  }
}

export function writeSettingsFile(
  filePath: string,
  data: Record<string, unknown>,
  options: { dedupeBackup?: boolean } = {},
): void {
  // Write directly to target file. Per issue spec: "comments are lost on write — acceptable
  // since the example.jsonc is the reference."
  const dir = dirname(filePath);

  // Refuse BEFORE touching the filesystem: creating the parent of a rejected path would
  // change a location the write is not allowed to reach.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    // Test processes may only write under the OS temp tree (same safety net the global
    // settings path has): a test once wrote a project's real settings file. Compare the REAL
    // paths — a lexical check passes for a fixture whose `.pi` links to a real project.
    const real = nearestRealPath(filePath);
    const tmpRoot = realpathSync(tmpdir());
    if (real !== tmpRoot && !real.startsWith(tmpRoot + sep)) {
      throw new Error(`test process refused to write settings outside the temp tree: ${real}`);
    }
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existedBefore = existsSync(filePath);
  if (!existedBefore && options.dedupeBackup === true && editSessionDepth > 0) {
    // Created during this visit: nothing to restore to, and the first partial version is not the
    // pre-visit state, so later writes in the same visit must not snapshot it.
    createdInSession.add(filePath);
  }

  if (existedBefore) {
    // A corrupt file is recoverable by hand; a cleared one is not. Refuse rather than
    // overwrite — this is exactly how a project's settings were once emptied.
    if (readSettingsFile(filePath) === null) throw new SettingsFileCorruptError(filePath);
    // Keep the pre-change bytes — `settings_backup_count` of them, newest at `.bak.1`. Inside the
    // settings TUI that happens once per visit, so editing several values keeps the state the user
    // started from. Recorded only after a successful rotation, so a failed one is retried.
    const count = backupCountFor(filePath);
    // Pruning runs on EVERY write: lowering the retention during a visit must drop the slots
    // above the new limit, and inside a visit only the rotation itself is deduped.
    pruneExtraBackups(filePath, count);
    if (options.dedupeBackup === true && editSessionDepth > 0) {
      // Inside a visit the snapshot is the restore point; the chain is only touched at visit end.
      if (shouldBackUp(filePath, true) && count > 0) {
        try {
          reapStaleVisitSnapshots(filePath);
          copyFileSync(filePath, visitSnapshotPath(filePath));
          backedUpInSession.add(filePath);
          visitSnapshots.add(visitSnapshotPath(filePath));
        } catch (e: any) {
          log.error("settings_backup_failed", { filePath, error: e?.message });
          throw new SettingsBackupError(filePath, e);
        }
      }
    } else {
      rotateSettingsBackups(filePath, count);
    }
  }
  const content = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, filePath);
  } catch (e: any) {
    // Clean up temp file on failure
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

// ── Secret submit guard (extracted for testability) ────────────────

/** Check if a secret input should be treated as "no change" (cancel). */
export function isSecretNoChange(val: string | undefined, scopeHasValue: boolean): boolean {
  if (scopeHasValue) return false; // value exists in scope — user is editing, not creating
  // Treat undefined, empty, whitespace-only, and the literal "(empty)" as no-change.
  // "(empty)" is the display placeholder that parseRawValue converts to "".
  return val === undefined || val?.trim() === "" || val?.trim() === EMPTY_VALUE_SENTINEL;
}

/** Resolve the prefill value for a secret key from the current scope's file only. */
export function resolveSecretPrefill(
  key: string,
  editScope: "project" | "global",
  cwd: string,
): { scopeValue: string | null; prefill: string; hint: string } {
  const scopeFile = getFilePathForScope(editScope, cwd);
  const scopeData = readSettingsFile(scopeFile);
  const scopeValue = scopeData && typeof scopeData[key] === "string" ? scopeData[key] as string : null;
  // Never prefill with the raw secret — always start empty to avoid exposing it on screen.
  // The user must type a new value; empty submit is handled by isSecretNoChange.
  const prefill = "";
  const hint = scopeValue !== null
    ? "Value set in this scope — enter new value or empty to clear"
    : "Enter new value (not set in this scope)";
  return { scopeValue, prefill, hint };
}

// ── Provider-filtered model items ───────────────────────────────

export type ModelSelectItem = {
  value: string;
  label: string;
  description?: string;
  /** Registry input modalities when present (vision ≠ image generation). */
  input?: string[];
  /** Registry output modalities when present (`image` = image-generation capable). */
  output?: string[];
};

/** True when a model id looks like a Google/Gemini image-generation model. */
export function isImageGenModelId(id: string): boolean {
  const lower = id.toLowerCase();
  const result =
    lower.includes("imagen") ||
    lower.includes("image-generation") ||
    /(?:^|[-_./])image(?:[-_./]|$)/.test(lower);
  log.debug("isImageGenModelId", { id, result });
  return result;
}

/** Image-gen picker: prefer `output` includes `image`; else id pattern. Not `input` (vision). */
export function isImageCapablePickerItem(item: ModelSelectItem): boolean {
  if (Array.isArray(item.output) && item.output.includes("image")) {
    log.debug("isImageCapablePickerItem", { id: item.value, via: "output" });
    return true;
  }
  return isImageGenModelId(item.value);
}

export type ModelPickerPairedSettings = {
  agent_provider?: string;
  internal_operations_provider?: string;
};

/** Filter model SelectItems by provider. Returns all models if provider is empty/undefined. */
export function filterModelsByProvider(
  allModels: ModelSelectItem[],
  provider?: string,
): ModelSelectItem[] {
  if (!provider) return allModels;
  return allModels.filter((m) => m.description === provider);
}

/** Registry provider hardwired for image_model picker (no image_provider setting). */
export const IMAGE_MODEL_PROVIDER = "google";

/**
 * Registry provider used to filter the model picker for a settings key.
 * image_model is hardwired to IMAGE_MODEL_PROVIDER (no image_provider setting).
 */
export function resolveModelPickerProvider(
  key: string,
  paired: ModelPickerPairedSettings = {},
): string | undefined {
  if (key === "image_model") {
    log.debug("resolveModelPickerProvider", { key, provider: IMAGE_MODEL_PROVIDER });
    return IMAGE_MODEL_PROVIDER;
  }
  if (key === "agent_model") {
    const p = paired.agent_provider?.trim();
    log.debug("resolveModelPickerProvider", { key, provider: p || undefined });
    return p || undefined;
  }
  if (key === "internal_operations_model") {
    const p = paired.internal_operations_provider?.trim();
    log.debug("resolveModelPickerProvider", { key, provider: p || undefined });
    return p || undefined;
  }
  log.debug("resolveModelPickerProvider", { key, provider: undefined });
  return undefined;
}

/**
 * Models shown in the settings TUI picker for a key.
 * image_model: IMAGE_MODEL_PROVIDER + image-capable only — never falls back to all providers (empty list if none).
 * agent_model / internal_operations_model: fall back to all models when filter is empty.
 */
export function resolveModelPickerItems(
  key: string,
  allModels: ModelSelectItem[],
  provider?: string,
): ModelSelectItem[] {
  // image_model is always google-filtered — ignore caller provider (even truthy non-google)
  const effectiveProvider = key === "image_model" ? IMAGE_MODEL_PROVIDER : provider;
  const filtered = filterModelsByProvider(allModels, effectiveProvider);
  if (key === "image_model") {
    const imageCapable = filtered.filter(isImageCapablePickerItem);
    log.debug("resolveModelPickerItems image_model", {
      googleCount: filtered.length,
      imageCapableCount: imageCapable.length,
    });
    return imageCapable;
  }
  const result = filtered.length > 0 ? filtered : allModels;
  log.debug("resolveModelPickerItems", { key, provider: effectiveProvider, count: result.length });
  return result;
}

/**
 * Decide picker vs free-text for a model settings key.
 * Call at submenu-open time (not build time) so paired provider changes are fresh.
 * image_model with an empty google list → free-text input (never show all providers).
 */
export type ModelKeySubmenu =
  | { mode: "picker"; models: ModelSelectItem[]; provider?: string }
  | { mode: "input"; provider?: string };

export function resolveModelKeySubmenu(
  key: string,
  allModels: ModelSelectItem[],
  paired: ModelPickerPairedSettings = {},
): ModelKeySubmenu {
  const provider = resolveModelPickerProvider(key, paired);
  const models = resolveModelPickerItems(key, allModels, provider);
  if (key === "image_model" && models.length === 0) {
    log.debug("resolveModelKeySubmenu", { key, mode: "input", provider });
    return { mode: "input", provider };
  }
  log.debug("resolveModelKeySubmenu", { key, mode: "picker", count: models.length, provider });
  return { mode: "picker", models, provider };
}

// ── Source glyph (colored) ──────────────────────────────────────

export function sourceGlyph(source: string, theme: { fg: (color: "success" | "accent" | "warning" | "dim", text: string) => string }): string {
  switch (source) {
    case "P": return theme.fg("success", "P");
    case "G": return theme.fg("accent", "G");
    case "E": return theme.fg("warning", "E");
    case "D": return theme.fg("dim", "D");
    default:  return theme.fg("dim", "?");
  }
}

// ── Registration helper (testable without pi-coding-agent) ──────────

/**
 * Core registration logic extracted for testability.
 * Accepts a minimal pi-like object with registerCommand.
 */
export function registerSettingsTuiCommand(
  pi: { registerCommand: (name: string, opts: { description: string; handler: (...args: any[]) => any }) => void },
  handler: (args: string, ctx: any) => Promise<void>,
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerCommand("pi-config-settings", {
    description: "Interactive settings editor for pi-config",
    handler,
  });
}
