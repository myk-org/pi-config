/**
 * Pure placeholder substitution and conditional assembly for rules/*.md
 * and agent system-prompt text.
 *
 * Kept in its own module (no heavy imports) so it can be unit tested without
 * pulling in the full orchestrator dependency chain (e.g. rules.ts → async-agents.ts
 * → @earendil-works/pi-tui, which is a runtime-only dependency not present in
 * the test install). Callers pass a resolve function for settings lookups.
 */

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
  return text.replace(new RegExp(SETTINGS_PATTERN.source, "g"), (_match, keysGroup: string | undefined) => {
    const keys = keysGroup !== undefined
      ? keysGroup.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
      : allKeys;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (!allKeys.includes(key)) {
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
  knownKeys?: string[];
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

function markerRe(): RegExp {
  return new RegExp(MARKER_RE.source, "g");
}

function findNextOpen(text: string, from: number): OpenMarker | null {
  const re = markerRe();
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    if (full.startsWith("{{IFNOT:")) {
      return { kind: "ifnot", cond: m[2], index: m.index, end: m.index + full.length };
    }
    if (full.startsWith("{{IF:")) {
      return { kind: "if", cond: m[3], index: m.index, end: m.index + full.length };
    }
    // stray close — leave for later scan
  }
  return null;
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
  const re = markerRe();
  re.lastIndex = open.end;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
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
  if (opts?.knownKeys && !opts.knownKeys.includes(key)) {
    opts.onWarn?.(`unknown setting key in conditional: ${key}`);
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
    const processed = processRegion(text, resolve, opts);
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
): string {
  let result = "";
  let i = 0;
  while (i < region.length) {
    // Warn on stray closes before the next open
    const peekRe = markerRe();
    peekRe.lastIndex = i;
    const peek = peekRe.exec(region);
    if (peek && (peek[0] === "{{/IF}}" || peek[0] === "{{/IFNOT}}")) {
      const open = findNextOpen(region, i);
      if (!open || open.index > peek.index) {
        opts?.onWarn?.(`unbalanced conditional marker: ${peek[0]}`);
        result += region.slice(i, peek.index + peek[0].length);
        i = peek.index + peek[0].length;
        continue;
      }
    }

    const open = findNextOpen(region, i);
    if (!open) {
      result += region.slice(i);
      break;
    }
    result += region.slice(i, open.index);
    const close = findMatchingClose(region, open);
    if (!close) {
      opts?.onWarn?.(`unbalanced conditional block starting at {{${open.kind === "if" ? "IF" : "IFNOT"}:${open.cond}}}`);
      // Leave from open marker to end as-is (do not throw)
      result += region.slice(open.index);
      break;
    }
    const body = region.slice(open.end, close.index);
    const keep = conditionHolds(open.cond, open.kind === "ifnot", resolve, opts);
    if (keep) {
      result += processRegion(body, resolve, opts);
    }
    i = close.end;
  }
  return result;
}

/**
 * Parse a simple YAML-ish frontmatter block (`---` / `key: value` / `---`).
 * No attrs → body = raw.
 */
export function parseRuleFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { attrs: {}, body: raw };
  }
  const attrs: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key) attrs[key] = value;
  }
  return { attrs, body: match[2] };
}

export type FrontmatterGateOpts = {
  resolveSetting: (key: string) => unknown;
  featurePredicates: Record<string, () => boolean>;
  knownKeys?: string[];
  onWarn?: (msg: string) => void;
};

/**
 * Whole-file gate from frontmatter `requires_setting` / `requires` (AND if both present).
 */
export function rulePassesFrontmatterGate(
  attrs: Record<string, string>,
  opts: FrontmatterGateOpts,
): boolean {
  const requiresSetting = attrs.requires_setting?.trim();
  const requires = attrs.requires?.trim();
  if (!requiresSetting && !requires) return true;

  if (requiresSetting) {
    if (opts.knownKeys && !opts.knownKeys.includes(requiresSetting)) {
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
  knownKeys: string[];
  featurePredicates: Record<string, () => boolean>;
  reviewLoopMaxCycles: number;
  onWarn?: (msg: string) => void;
  onSkip?: (info: { attrs: Record<string, string>; index: number }) => void;
  onInclude?: (info: { attrs: Record<string, string>; index: number }) => void;
};

/**
 * Pure rule assembly: per-file frontmatter gate → per-file conditionals →
 * join → placeholder substitution.
 *
 * Conditionals run per body so an open `{{IF}}` in one file cannot close in
 * another and strip intervening package rules.
 */
export function assembleRuleText(contents: string[], opts: AssembleRuleTextOpts): string {
  const bodies: string[] = [];
  const condOpts: ConditionalEvalOpts = {
    knownKeys: opts.knownKeys,
    featurePredicates: opts.featurePredicates,
    onWarn: opts.onWarn,
  };
  for (let index = 0; index < contents.length; index++) {
    const raw = contents[index];
    const { attrs, body } = parseRuleFrontmatter(raw);
    if (!rulePassesFrontmatterGate(attrs, {
      resolveSetting: opts.resolve,
      featurePredicates: opts.featurePredicates,
      knownKeys: opts.knownKeys,
      onWarn: opts.onWarn,
    })) {
      opts.onSkip?.({ attrs, index });
      continue;
    }
    opts.onInclude?.({ attrs, index });
    // Evaluate conditionals per file before join (no cross-file IF matching).
    bodies.push(evaluateConditionalBlocks(body, opts.resolve, condOpts));
  }
  const joined = bodies.join("\n\n");
  // Safety net: collapse table-row blank lines across join boundaries too.
  const collapsed = collapseBlankLinesBetweenTableRows(joined);
  return substituteRulePlaceholders(collapsed, { reviewLoopMaxCycles: opts.reviewLoopMaxCycles });
}
