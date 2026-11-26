/**
 * Pure placeholder substitution and conditional assembly for rules/*.md
 * and agent system-prompt text.
 *
 * Kept in its own module (no heavy imports) so it can be unit tested without
 * pulling in the full orchestrator dependency chain (e.g. rules.ts → async-agents.ts
 * → @earendil-works/pi-tui, which is a runtime-only dependency not present in
 * the test install). Callers pass a resolve function for settings lookups.
 */

import * as path from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("rules");

export function substituteRulePlaceholders(text: string, values: { reviewLoopMaxCycles: number }): string {
  return text.replaceAll("{{REVIEW_LOOP_MAX_CYCLES}}", String(values.reviewLoopMaxCycles));
}

const SETTINGS_PATTERN = /\{\{SETTINGS(?::([^}]+))?\}\}/g;

/**
 * Replace `{{SETTINGS:key1,key2,...}}` with JSON of resolved setting values.
 * `{{SETTINGS}}` (no colon) resolves every key in `allKeys`.
 */
export function substituteSettingsPlaceholders(
  text: string,
  resolve: (key: string) => unknown,
  allKeys: string[],
): string {
  const allKeysSet = new Set(allKeys);
  SETTINGS_PATTERN.lastIndex = 0;
  return text.replace(SETTINGS_PATTERN, (_match, keysGroup: string | undefined) => {
    const keys = keysGroup !== undefined
      ? keysGroup.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
      : allKeys;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (!allKeysSet.has(key)) {
        continue;
      }
      result[key] = resolve(key);
    }
    return JSON.stringify(result);
  });
}

/** Truthiness for settings-gated rule blocks. */
export function isSettingTruthy(value: unknown): boolean {
  if (value === false || value === null || value === undefined || value === "" || value === 0) {
    log.debug("isSettingTruthy", { result: false, kind: value === "" ? "empty-string" : String(value) });
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    log.debug("isSettingTruthy", { result: false, kind: "empty-array" });
    return false;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value as object).length === 0) {
    log.debug("isSettingTruthy", { result: false, kind: "empty-object" });
    return false;
  }
  log.debug("isSettingTruthy", { result: true, kind: Array.isArray(value) ? "array" : typeof value });
  return true;
}

/** Parse comparison / truthy condition text after `IF:` or `IFNOT:`. */
export function parseConditionExpr(expr: string): {
  key: string;
  op: "truthy" | "eq" | "neq";
  literal?: unknown;
} | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    log.debug("parseConditionExpr empty");
    return null;
  }
  const cmp = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=)\s*(.*)$/);
  if (cmp) {
    const parsed = {
      key: cmp[1],
      op: (cmp[2] === "==" ? "eq" : "neq") as "eq" | "neq",
      literal: parseConditionLiteral(cmp[3].trim()),
    };
    log.debug("parseConditionExpr", parsed);
    return parsed;
  }
  const keyOnly = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  if (keyOnly) {
    const parsed = { key: keyOnly[1], op: "truthy" as const };
    log.debug("parseConditionExpr", parsed);
    return parsed;
  }
  log.debug("parseConditionExpr malformed", trimmed);
  return null;
}

/** Parse `true`/`false`/`null`/number/string literals used in `key==value` conditions. */
export function parseConditionLiteral(raw: string): unknown {
  let result: unknown = raw;
  if (raw === "true") result = true;
  else if (raw === "false") result = false;
  else if (raw === "null") result = null;
  else if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    result = raw.slice(1, -1);
  } else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    result = Number(raw);
  }
  log.debug("parseConditionLiteral", { raw, resultType: typeof result });
  return result;
}

export type ConditionalEvalOpts = {
  knownKeys?: readonly string[] | ReadonlySet<string>;
  /** Feature predicates consulted for truthy `{{IF:key}}` when key is not a setting. */
  featurePredicates?: Record<string, () => boolean>;
  onWarn?: (msg: string) => void;
};

type OpenKind = "if" | "ifnot";

type OpenMarker = {
  kind: OpenKind;
  cond: string;
  index: number;
  end: number;
};

const MARKER_RE = /\{\{(IFNOT:([^}]+)|IF:([^}]+)|\/IFNOT|\/IF)\}\}/g;

function toKnownKeySet(knownKeys?: readonly string[] | ReadonlySet<string>): ReadonlySet<string> | undefined {
  if (!knownKeys) return undefined;
  return knownKeys instanceof Set ? knownKeys : new Set(knownKeys);
}

/**
 * Find the matching closer for `open`, tracking a stack of open kinds.
 * A mismatched closer at any depth does not pop — unbalanced → null.
 */
function findMatchingClose(
  text: string,
  open: OpenMarker,
): { index: number; end: number } | null {
  const stack: OpenKind[] = [open.kind];
  MARKER_RE.lastIndex = open.end;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const full = m[0];
    if (full.startsWith("{{IF:")) {
      stack.push("if");
      continue;
    }
    if (full.startsWith("{{IFNOT:")) {
      stack.push("ifnot");
      continue;
    }
    if (full === "{{/IF}}" || full === "{{/IFNOT}}") {
      const expectedKind: OpenKind = full === "{{/IF}}" ? "if" : "ifnot";
      const top = stack[stack.length - 1];
      if (top !== expectedKind) {
        // Mismatched closer — do not pop; treat as unbalanced for this open.
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return { index: m.index, end: m.index + full.length };
      }
    }
  }
  return null;
}

function conditionHolds(
  condRaw: string,
  invert: boolean,
  resolve: (key: string) => unknown,
  opts?: ConditionalEvalOpts,
  knownKeySet?: ReadonlySet<string>,
): boolean {
  const parsed = parseConditionExpr(condRaw);
  if (!parsed) {
    opts?.onWarn?.(`malformed conditional condition: ${condRaw}`);
    return false;
  }
  const { key, op, literal } = parsed;

  // Truthy op: feature predicates win when the key is registered as a feature
  // (does not require knownKeys — features are not settings keys).
  if (op === "truthy" && opts?.featurePredicates && key in opts.featurePredicates) {
    let holds = false;
    try {
      holds = opts.featurePredicates[key]() === true;
    } catch (e: any) {
      opts.onWarn?.(`feature predicate ${key} threw: ${e?.message ?? String(e)}`);
      holds = false;
    }
    return invert ? !holds : holds;
  }

  let value: unknown = undefined;
  if (knownKeySet && !knownKeySet.has(key)) {
    opts?.onWarn?.(`unknown setting key in conditional: ${key}`);
    // Fail closed: unknown keys never keep the block, including {{IFNOT:typo}}.
    log.warn("conditionHolds fail-closed unknown key", { key, invert, op });
    return false;
  } else {
    value = resolve(key);
  }
  let holds: boolean;
  if (op === "truthy") {
    holds = isSettingTruthy(value);
  } else if (op === "eq") {
    holds = value === literal;
  } else {
    holds = value !== literal;
  }
  return invert ? !holds : holds;
}

/**
 * Collapse blank lines between consecutive markdown table rows so
 * removed/kept IF markers do not break table adjacency (`|...|` rows).
 */
export function collapseBlankLinesBetweenTableRows(text: string): string {
  // Two or more newlines between lines that both start with `|` → single newline
  return text.replace(/(\|[^\n]*)\n(?:[ \t]*\n)+(?=\|)/g, "$1\n");
}

/**
 * Evaluate conditional blocks (`{{IF:...}}` / `{{IFNOT:...}}`) before
 * substituting `{{SETTINGS:...}}` placeholders in an agent system prompt.
 */
export function resolveAgentSystemPrompt(
  text: string,
  resolve: (key: string) => unknown,
  knownKeys: string[],
  onWarn?: (msg: string) => void,
): string {
  const evaluated = evaluateConditionalBlocks(text, resolve, { knownKeys, onWarn });
  return substituteSettingsPlaceholders(evaluated, resolve, knownKeys);
}

/**
 * Evaluate `{{IF:key}}...{{/IF}}` / `{{IFNOT:key}}...{{/IFNOT}}` blocks
 * (including `key==value` / `key!=value`). Nesting supported.
 * Malformed/unbalanced markers: leave text as-is and warn — never throw.
 */
export function evaluateConditionalBlocks(
  text: string,
  resolve: (key: string) => unknown,
  opts?: ConditionalEvalOpts,
): string {
  try {
    const knownKeySet = toKnownKeySet(opts?.knownKeys);
    const processed = processRegion(text, resolve, opts, knownKeySet);
    return collapseBlankLinesBetweenTableRows(processed);
  } catch (e: any) {
    opts?.onWarn?.(`conditional evaluation failed: ${e?.message ?? String(e)}`);
    return text;
  }
}

function processRegion(
  region: string,
  resolve: (key: string) => unknown,
  opts?: ConditionalEvalOpts,
  knownKeySet?: ReadonlySet<string>,
): string {
  let result = "";
  let i = 0;
  while (i < region.length) {
    MARKER_RE.lastIndex = i;
    const m = MARKER_RE.exec(region);
    if (!m) {
      result += region.slice(i);
      break;
    }
    const full = m[0];
    if (full === "{{/IF}}" || full === "{{/IFNOT}}") {
      opts?.onWarn?.(`unbalanced conditional marker: ${full}`);
      result += region.slice(i, m.index + full.length);
      i = m.index + full.length;
      continue;
    }
    const open: OpenMarker = full.startsWith("{{IFNOT:")
      ? { kind: "ifnot", cond: m[2], index: m.index, end: m.index + full.length }
      : { kind: "if", cond: m[3], index: m.index, end: m.index + full.length };

    result += region.slice(i, open.index);
    const close = findMatchingClose(region, open);
    if (!close) {
      opts?.onWarn?.(`unbalanced conditional block starting at {{${open.kind === "if" ? "IF" : "IFNOT"}:${open.cond}}}`);
      // Leave from open marker to end as-is (do not throw)
      result += region.slice(open.index);
      break;
    }
    const body = region.slice(open.end, close.index);
    const keep = conditionHolds(open.cond, open.kind === "ifnot", resolve, opts, knownKeySet);
    if (keep) {
      result += processRegion(body, resolve, opts, knownKeySet);
    }
    i = close.end;
  }
  return result;
}

/**
 * Parse a simple YAML-ish frontmatter block (`---` / `key: value` or block lists / `---`).
 * No attrs → body = raw.
 */
export function parseRuleFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { attrs: {}, body: raw };
  }
  const attrs: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  let currentListKey: string | null = null;
  let currentListItems: string[] = [];

  const flushList = (): void => {
    if (currentListKey !== null) {
      // Preserve blank scalar values (`requires:` with no items) as "" so
      // frontmatter gates keep treating them as absent rather than `"[]"`.
      attrs[currentListKey] = currentListItems.length > 0 ? JSON.stringify(currentListItems) : "";
      currentListKey = null;
      currentListItems = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (currentListKey !== null && /^-\s+/.test(trimmed)) {
      const item = stripYamlQuotes(trimmed.replace(/^-\s+/, "").trim());
      if (item) currentListItems.push(item);
      continue;
    }

    flushList();
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!key) continue;
    if (value === "") {
      currentListKey = key;
      currentListItems = [];
    } else {
      attrs[key] = value;
    }
  }
  flushList();
  return { attrs, body: match[2] };
}

function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && i + 1 < input.length) {
        current += input[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "{") {
      braceDepth += 1;
      current += ch;
    } else if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      current += ch;
    } else if (ch === "[") {
      bracketDepth += 1;
      current += ch;
    } else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
      current += ch;
    } else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function parseYamlStringList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
          .filter((s) => s.length > 0);
      }
    } catch {
      // Fallback for YAML-style unquoted or single-quoted inline lists like [**/*.{ts,tsx}, 'Dockerfile*']
    }
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner)
      .map((part) => stripYamlQuotes(part.trim()).trim())
      .filter((s) => s.length > 0);
  }
  const scalar = stripYamlQuotes(trimmed).trim();
  return scalar ? [scalar] : [];
}

function parseYamlBool(raw: string | undefined, key: string, onWarn?: (msg: string) => void): boolean | undefined {
  if (raw === undefined) return undefined;
  const norm = stripYamlQuotes(raw.trim()).trim().toLowerCase();
  if (norm === "true") return true;
  if (norm === "false") return false;
  onWarn?.(`invalid boolean frontmatter ${key}: ${raw}`);
  return undefined;
}

export interface RuleScope {
  enabled: boolean;
  alwaysApply: boolean;
  globs: string[];
  tools: string[];
}

/**
 * Parse lazy-rule scoping metadata (`enabled`, `alwaysApply`, `globs`, `tools`)
 * from frontmatter attributes (issue #1415).
 *
 * Defaults:
 * - `enabled`: `true`
 * - `alwaysApply`: `true` when neither `globs` nor `tools` is specified (100%
 *   backwards-compatible); `false` when `globs` or `tools` is non-empty unless
 *   explicitly set to `true`.
 */
export function parseRuleScope(
  attrs: Record<string, string>,
  onWarn?: (msg: string) => void,
): RuleScope {
  const enabled = parseYamlBool(attrs.enabled, "enabled", onWarn) ?? true;
  const globs = parseYamlStringList(attrs.globs);
  const tools = parseYamlStringList(attrs.tools);
  const explicitAlways = parseYamlBool(attrs.alwaysApply, "alwaysApply", onWarn);
  const alwaysApply = explicitAlways ?? (globs.length === 0 && tools.length === 0);
  return { enabled, alwaysApply, globs, tools };
}

export interface LazyRule {
  fileName: string;
  globs: string[];
  tools: string[];
  body: string;
}

/**
 * Match a file path against a rule glob pattern (POSIX-normalized).
 * Patterns without `/` match against both the normalized path and its basename
 * so `Dockerfile*` matches both `Dockerfile` and `docker/Dockerfile.prod`.
 */
export function matchRuleGlob(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPattern = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normPath || !normPattern) return false;
  try {
    if (path.posix.matchesGlob(normPath, normPattern)) return true;
    if (!normPattern.includes("/")) {
      return path.posix.matchesGlob(path.posix.basename(normPath), normPattern);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Check whether a lazy scoped rule matches the current invocation context.
 * - `tools`-only: matches when `toolName` is in `rule.tools`.
 * - `globs`-only: matches when any candidate path matches `rule.globs`.
 * - Both `tools` and `globs`: requires BOTH to match (AND).
 */
export function matchLazyRule(
  rule: Pick<LazyRule, "globs" | "tools">,
  ctx: { toolName?: string; paths?: string[] },
): boolean {
  const hasTools = rule.tools.length > 0;
  const hasGlobs = rule.globs.length > 0;
  if (!hasTools && !hasGlobs) return false;
  if (hasTools && (!ctx.toolName || !rule.tools.includes(ctx.toolName))) return false;
  if (hasGlobs) {
    const paths = ctx.paths ?? [];
    if (paths.length === 0) return false;
    const hit = paths.some((p) => rule.globs.some((g) => matchRuleGlob(p, g)));
    if (!hit) return false;
  }
  return true;
}

const KNOWN_EXTENSIONLESS_FILENAMES = /^(?:Dockerfile|Containerfile|Makefile|Jenkinsfile|Procfile|Vagrantfile|Gemfile|Rakefile)(?:[._-][A-Za-z0-9._-]+)?$/;

/**
 * Extract candidate file paths/names from free-form text (user prompt or bash command).
 */
export function extractPathsFromText(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const tokens = text.split(/\s+/);
  for (const rawToken of tokens) {
    const cleaned = rawToken
      .replace(/^[`"'([{<]+/, "")
      .replace(/[`"'\])}>,:;!?]+$/, "")
      .trim();
    if (!cleaned || cleaned.includes("://")) continue;
    // Skip flags like --foo.bar or -x
    if (cleaned.startsWith("-")) continue;
    const looksLikePath =
      cleaned.includes("/") ||
      /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12}$/.test(cleaned) ||
      KNOWN_EXTENSIONLESS_FILENAMES.test(cleaned);
    if (looksLikePath) {
      found.add(cleaned.replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return [...found];
}

function normalizeCandidatePath(rawPath: string, cwd: string): string[] {
  const trimmed = rawPath.trim();
  if (!trimmed) return [];
  const results = new Set<string>();
  const posixRaw = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posixRaw) results.add(posixRaw);
  if (path.isAbsolute(trimmed)) {
    const rel = path.relative(cwd, trimmed).replace(/\\/g, "/");
    if (rel && !rel.startsWith("../") && rel !== "..") {
      results.add(rel);
    }
  }
  return [...results];
}

/**
 * Extract normalized candidate file paths from a tool invocation's input arguments.
 */
export function extractPathsFromToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string,
): string[] {
  if (!input || typeof input !== "object") return [];
  const found = new Set<string>();
  for (const key of ["path", "file", "filePath", "target"]) {
    const val = input[key];
    if (typeof val === "string") {
      for (const p of normalizeCandidatePath(val, cwd)) found.add(p);
    }
  }
  if (Array.isArray(input.paths)) {
    for (const item of input.paths) {
      if (typeof item === "string") {
        for (const p of normalizeCandidatePath(item, cwd)) found.add(p);
      }
    }
  }
  if (toolName === "bash" && typeof input.command === "string") {
    for (const token of extractPathsFromText(input.command)) {
      for (const p of normalizeCandidatePath(token, cwd)) found.add(p);
    }
  }
  return [...found];
}

export type FrontmatterGateOpts = {
  resolveSetting: (key: string) => unknown;
  featurePredicates: Record<string, () => boolean>;
  knownKeys?: readonly string[] | ReadonlySet<string>;
  onWarn?: (msg: string) => void;
};

/**
 * Whole-file gate from frontmatter `enabled`, `requires_setting`, and `requires` (AND).
 */
export function rulePassesFrontmatterGate(
  attrs: Record<string, string>,
  opts: FrontmatterGateOpts,
): boolean {
  const enabled = parseYamlBool(attrs.enabled, "enabled", opts.onWarn);
  if (enabled === false) return false;

  const requiresSetting = attrs.requires_setting?.trim();
  const requires = attrs.requires?.trim();
  if (!requiresSetting && !requires) return true;

  if (requiresSetting) {
    const knownKeySet = toKnownKeySet(opts.knownKeys);
    if (knownKeySet && !knownKeySet.has(requiresSetting)) {
      opts.onWarn?.(`unknown requires_setting key: ${requiresSetting}`);
      return false;
    }
    if (!isSettingTruthy(opts.resolveSetting(requiresSetting))) {
      return false;
    }
  }

  if (requires) {
    const pred = opts.featurePredicates[requires];
    if (!pred) {
      opts.onWarn?.(`unknown feature predicate: ${requires}`);
      return false;
    }
    try {
      if (pred() !== true) {
        return false;
      }
    } catch (e: any) {
      opts.onWarn?.(`feature predicate ${requires} threw: ${e?.message ?? String(e)}`);
      return false;
    }
  }

  return true;
}

export type AssembleRuleTextOpts = {
  resolve: (key: string) => unknown;
  knownKeys: readonly string[] | ReadonlySet<string>;
  featurePredicates: Record<string, () => boolean>;
  reviewLoopMaxCycles: number;
  onWarn?: (msg: string) => void;
  onSkip?: (info: { attrs: Record<string, string>; index: number }) => void;
  onInclude?: (info: { attrs: Record<string, string>; index: number }) => void;
  onLazy?: (info: { attrs: Record<string, string>; index: number; scope: RuleScope }) => void;
};

/**
 * Pure split rule assembly (issue #1415): evaluates frontmatter gates,
 * scoping (`alwaysApply`, `globs`, `tools`, `enabled`), conditionals, and
 * placeholders per file, returning:
 * - `baseText`: joined always-apply rules for the stable system prompt prefix
 * - `lazyRules`: scoped rules injected on-demand per session
 */
export function assembleRulesSplit(
  files: ReadonlyArray<{ fileName: string; raw: string }>,
  opts: AssembleRuleTextOpts,
): { baseText: string; lazyRules: LazyRule[] } {
  const baseBodies: string[] = [];
  const lazyRules: LazyRule[] = [];
  const knownKeySet = toKnownKeySet(opts.knownKeys);
  const condOpts: ConditionalEvalOpts = {
    knownKeys: knownKeySet,
    featurePredicates: opts.featurePredicates,
    onWarn: opts.onWarn,
  };
  for (let index = 0; index < files.length; index++) {
    const { fileName, raw } = files[index];
    const { attrs, body } = parseRuleFrontmatter(raw);
    if (!rulePassesFrontmatterGate(attrs, {
      resolveSetting: opts.resolve,
      featurePredicates: opts.featurePredicates,
      knownKeys: knownKeySet,
      onWarn: opts.onWarn,
    })) {
      opts.onSkip?.({ attrs, index });
      continue;
    }
    const scope = parseRuleScope(attrs, opts.onWarn);
    const evaluated = substituteRulePlaceholders(
      collapseBlankLinesBetweenTableRows(evaluateConditionalBlocks(body, opts.resolve, condOpts)),
      { reviewLoopMaxCycles: opts.reviewLoopMaxCycles },
    );
    if (scope.alwaysApply) {
      opts.onInclude?.({ attrs, index });
      baseBodies.push(evaluated);
    } else if (scope.globs.length > 0 || scope.tools.length > 0) {
      opts.onLazy?.({ attrs, index, scope });
      lazyRules.push({
        fileName,
        globs: scope.globs,
        tools: scope.tools,
        body: evaluated.trim(),
      });
    } else {
      opts.onWarn?.(
        `rule "${fileName}" sets alwaysApply: false with no globs or tools; skipping because it can never match`,
      );
      opts.onSkip?.({ attrs, index });
    }
  }
  const joined = baseBodies.join("\n\n");
  const collapsed = collapseBlankLinesBetweenTableRows(joined);
  return {
    baseText: substituteRulePlaceholders(collapsed, { reviewLoopMaxCycles: opts.reviewLoopMaxCycles }),
    lazyRules,
  };
}

/**
 * Pure rule assembly: per-file frontmatter gate → per-file conditionals →
 * join → placeholder substitution.
 *
 * Conditionals run per body so an open `{{IF}}` in one file cannot close in
 * another and strip intervening package rules.
 */
export function assembleRuleText(contents: string[], opts: AssembleRuleTextOpts): string {
  const files = contents.map((raw, index) => ({ fileName: `rule-${index}.md`, raw }));
  return assembleRulesSplit(files, opts).baseText;
}
