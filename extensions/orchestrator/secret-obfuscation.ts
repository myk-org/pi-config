/**
 * Reversible secret obfuscation for LLM context and tool calls (issue #1413).
 *
 * Opt-in via `secret_obfuscation` (`PI_SECRET_OBFUSCATION`, default `false`).
 * When enabled:
 * - Collects secrets at session startup from:
 *   1. Env vars matching secret name patterns (`KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH`, len >= 8)
 *   2. Passwords embedded in URL credentials across all env vars (len >= 8)
 *   3. Optional `.pi/secrets.jsonc` (project) and `~/.pi/agent/secrets.jsonc` (global)
 *      supporting `obfuscate` (reversible) and `replace` (one-way) entries
 * - Scans provider-bound `context` messages and `tool_result` outputs with collected
 *   secrets + built-in credential regexes (Anthropic, OpenAI, GitHub, GitLab, AWS,
 *   Google, Slack, npm, Stripe, JWT, Bearer, PEM private keys, URL passwords),
 *   replacing matches with deterministic placeholders (`$$<LABEL>_<HASH>$$`).
 * - Never mutates static system prompts (keeps prompt caches intact).
 * - Reversibly restores placeholders in model-authored `tool_call` arguments right
 *   before execution (never restoring one-way `replace` substitutions).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import stripJsonComments from "strip-json-comments";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createLogger, type Logger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";

const defaultLog = createLogger("secret-obfuscation");

/** Minimum character length required in reversible obfuscate mode to avoid redacting ordinary short words. */
export const MIN_SECRET_LENGTH = 8;

const SECRET_ENV_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH/i;

/** Well-known local socket/path env vars whose names match AUTH/KEY but are not credentials. */
const IGNORED_ENV_NAMES = new Set([
  "SSH_AUTH_SOCK",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "KEYMAP",
  "LESSKEY",
]);

const PLACEHOLDER_TOKEN_RE = /\$\$[A-Z0-9]+_[a-f0-9]{10,64}\$\$/g;
const PLACEHOLDER_EXACT_RE = /^\$\$[A-Z0-9]+_[a-f0-9]{10,64}\$\$$/;
const URL_CREDENTIAL_EXTRACT_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]{8,})@[^\s"'`<>]+/g;

interface BuiltinRegexRule {
  label: string;
  regex: RegExp;
  /** When set, only this capture group is replaced (e.g. Bearer token or URL password). */
  secretGroup?: number;
}

const BUILTIN_CREDENTIAL_RULES: readonly BuiltinRegexRule[] = [
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

export interface SecretConfigEntry {
  /** Exact literal secret string to match. */
  value?: string;
  /** Regular expression pattern source to match. */
  pattern?: string;
  /** Optional RegExp flags (e.g. `"i"`); `"g"` is always added automatically. */
  flags?: string;
  /** Label used in `$$<LABEL>_<HASH>$$` placeholders (obfuscate mode). */
  label?: string;
  /** `"obfuscate"` (default, reversible) or `"replace"` (one-way, never restored). */
  mode?: "obfuscate" | "replace";
  /** Replacement text for `"replace"` mode (default `"[REDACTED]"`). */
  replacement?: string;
}

export interface SecretVaultOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Optional explicit config entries (in addition to `.pi/secrets.jsonc` / `~/.pi/agent/secrets.jsonc`). */
  entries?: SecretConfigEntry[];
  /** Set `false` to skip reading `.pi/secrets.jsonc` and `~/.pi/agent/secrets.jsonc` from disk. */
  loadConfigFiles?: boolean;
  log?: Logger;
}

interface CompiledReplaceLiteral {
  value: string;
  replacement: string;
}

interface CompiledReplaceRegex {
  regex: RegExp;
  replacement: string;
}

interface CompiledObfuscateRegex {
  label: string;
  regex: RegExp;
}

function normalizeLabel(raw: string | undefined, fallback = "SECRET"): string {
  const cleaned = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 24);
  return cleaned || fallback;
}

function compileGlobalRegex(pattern: string, flags?: string): RegExp | null {
  try {
    const allowed = new Set(["i", "m", "s", "u"]);
    const filtered = [...new Set((flags ?? "").split("").filter((f) => allowed.has(f)))];
    filtered.push("g");
    return new RegExp(pattern, filtered.join(""));
  } catch {
    return null;
  }
}

function isPlaceholderToken(value: string): boolean {
  return PLACEHOLDER_EXACT_RE.test(value);
}

/** Parse `.pi/secrets.jsonc` or `~/.pi/agent/secrets.jsonc`. Fail-soft on missing/malformed files. */
export function loadSecretsConfigFile(filePath: string, log: Logger = defaultLog): SecretConfigEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : null;
    if (!list) {
      log.warn("secrets_config_invalid_shape", { filePath });
      return [];
    }
    const entries: SecretConfigEntry[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const mode = obj.mode === "replace" ? "replace" : "obfuscate";
      const entry: SecretConfigEntry = { mode };
      if (typeof obj.value === "string" && obj.value.length > 0) entry.value = obj.value;
      if (typeof obj.pattern === "string" && obj.pattern.length > 0) entry.pattern = obj.pattern;
      if (typeof obj.flags === "string") entry.flags = obj.flags;
      if (typeof obj.label === "string") entry.label = obj.label;
      if (typeof obj.replacement === "string") entry.replacement = obj.replacement;
      if (entry.value !== undefined || entry.pattern !== undefined) {
        entries.push(entry);
      }
    }
    return entries;
  } catch (err) {
    log.warn("secrets_config_parse_failed", { filePath }, err);
    return [];
  }
}

/**
 * In-memory deterministic secret vault for a session.
 *
 * Maps secrets -> deterministic placeholders (`$$<LABEL>_<HASH>$$`) for outbound
 * provider traffic and placeholders -> original secrets for inbound `tool_call`
 * restoration. One-way `replace` rules are never stored in the reverse map.
 */
export class SecretVault {
  private readonly secretToPlaceholder = new Map<string, string>();
  private readonly placeholderToSecret = new Map<string, string>();
  private readonly replaceLiterals: CompiledReplaceLiteral[] = [];
  private readonly replaceRegexes: CompiledReplaceRegex[] = [];
  private readonly oneWayReplacements = new Set<string>(["[REDACTED]"]);
  private readonly obfuscateRegexes: CompiledObfuscateRegex[] = [];
  private sortedLiterals: string[] = [];
  private literalsDirty = false;
  private readonly log: Logger;

  constructor(options: SecretVaultOptions = {}) {
    this.log = options.log ?? defaultLog;
    const env = options.env ?? process.env;
    const cwd = options.cwd;
    const home = options.homeDir ?? homedir();

    // 1. Collect explicit & config-file entries first so one-way `replace` rules
    //    take precedence over reversible env collection if the same secret overlaps.
    const configEntries: SecretConfigEntry[] = [];
    if (options.loadConfigFiles !== false) {
      const globalPath = join(home, ".pi", "agent", "secrets.jsonc");
      configEntries.push(...loadSecretsConfigFile(globalPath, this.log));
      if (cwd) {
        const projectPath = join(cwd, ".pi", "secrets.jsonc");
        configEntries.push(...loadSecretsConfigFile(projectPath, this.log));
      }
    }
    if (options.entries) {
      configEntries.push(...options.entries);
    }

    const oneWayValues = new Set<string>();
    for (const entry of configEntries) {
      const mode = entry.mode ?? "obfuscate";
      if (mode === "replace") {
        const replacement = entry.replacement ?? "[REDACTED]";
        if (replacement) this.oneWayReplacements.add(replacement);
        if (entry.value && entry.value.length > 0) {
          this.replaceLiterals.push({ value: entry.value, replacement });
          oneWayValues.add(entry.value);
        }
        if (entry.pattern && entry.pattern.length > 0) {
          const compiled = compileGlobalRegex(entry.pattern, entry.flags);
          if (compiled) {
            this.replaceRegexes.push({ regex: compiled, replacement });
          } else {
            this.log.warn("secrets_config_invalid_regex", { label: entry.label ?? "replace" });
          }
        }
        continue;
      }

      // Reversible obfuscate mode
      const label = normalizeLabel(entry.label, "CUSTOM");
      if (entry.value) {
        if (entry.value.length >= MIN_SECRET_LENGTH && !oneWayValues.has(entry.value)) {
          this.registerSecret(entry.value, label);
        } else {
          this.log.debug("secrets_config_short_value_skipped", { label, minLength: MIN_SECRET_LENGTH });
        }
      }
      if (entry.pattern) {
        const compiled = compileGlobalRegex(entry.pattern, entry.flags);
        if (compiled) {
          this.obfuscateRegexes.push({ label, regex: compiled });
        } else {
          this.log.warn("secrets_config_invalid_regex", { label });
        }
      }
    }

    // Sort one-way literal replacements longest-first to avoid partial substring clobbering.
    this.replaceLiterals.sort((a, b) => b.value.length - a.value.length);

    // 2. Collect secrets from environment variables.
    let envSecretCount = 0;
    let urlPasswordCount = 0;
    for (const [name, value] of Object.entries(env)) {
      if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
      if (IGNORED_ENV_NAMES.has(name)) continue;

      if (SECRET_ENV_NAME_RE.test(name) && !oneWayValues.has(value)) {
        if (this.registerSecret(value, normalizeLabel(name, "ENV"))) {
          envSecretCount++;
        }
      }

      // Extract passwords embedded in URL credentials across ANY env var.
      URL_CREDENTIAL_EXTRACT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_CREDENTIAL_EXTRACT_RE.exec(value)) !== null) {
        const password = m[1];
        if (password && password.length >= MIN_SECRET_LENGTH && !oneWayValues.has(password)) {
          if (this.registerSecret(password, normalizeLabel(name, "URLPASS"))) {
            urlPasswordCount++;
          }
        }
      }
    }

    this.log.info("secret_vault_initialized", {
      envSecrets: envSecretCount,
      urlPasswords: urlPasswordCount,
      reversibleTotal: this.secretToPlaceholder.size,
      replaceLiterals: this.replaceLiterals.length,
      replaceRegexes: this.replaceRegexes.length,
      customObfuscateRegexes: this.obfuscateRegexes.length,
    });
  }

  /** Number of registered reversible secrets (for telemetry & tests). */
  get reversibleCount(): number {
    return this.secretToPlaceholder.size;
  }

  /** Register a secret and return its deterministic placeholder (or existing placeholder). */
  registerSecret(secret: string, label = "SECRET"): string | null {
    if (
      secret.length < MIN_SECRET_LENGTH ||
      isPlaceholderToken(secret) ||
      this.oneWayReplacements.has(secret)
    ) {
      return null;
    }
    const existing = this.secretToPlaceholder.get(secret);
    if (existing) return existing;

    const cleanLabel = normalizeLabel(label);
    const fullHash = createHash("sha256").update(secret).digest("hex");
    let hashLen = 10;
    let placeholder = `$$${cleanLabel}_${fullHash.slice(0, hashLen)}$$`;
    while (
      this.placeholderToSecret.has(placeholder) &&
      this.placeholderToSecret.get(placeholder) !== secret &&
      hashLen < fullHash.length
    ) {
      hashLen += 4;
      placeholder = `$$${cleanLabel}_${fullHash.slice(0, hashLen)}$$`;
    }

    this.secretToPlaceholder.set(secret, placeholder);
    this.placeholderToSecret.set(placeholder, secret);
    this.literalsDirty = true;
    return placeholder;
  }

  /** Look up the placeholder for a registered secret (if any). */
  getPlaceholder(secret: string): string | undefined {
    return this.secretToPlaceholder.get(secret);
  }

  /** Look up the original secret for a placeholder (undefined for one-way or unknown tokens). */
  getSecret(placeholder: string): string | undefined {
    return this.placeholderToSecret.get(placeholder);
  }

  private getSortedLiterals(): string[] {
    if (this.literalsDirty) {
      this.sortedLiterals = [...this.secretToPlaceholder.keys()].sort((a, b) => b.length - a.length);
      this.literalsDirty = false;
    }
    return this.sortedLiterals;
  }

  /** Obfuscate secrets in `text`, applying one-way replacements first, then reversible secrets + regexes. */
  obfuscateText(text: string): string {
    if (!text) return text;
    let result = text;

    // 1. One-way `replace` literals (longest-first; never added to reverse map).
    for (const rule of this.replaceLiterals) {
      if (result.includes(rule.value)) {
        result = result.split(rule.value).join(rule.replacement);
      }
    }

    // 2. One-way `replace` regexes (never added to reverse map; replacer fn prevents `$` expansion).
    for (const rule of this.replaceRegexes) {
      rule.regex.lastIndex = 0;
      result = result.replace(rule.regex, () => rule.replacement);
    }

    // 3. Known literal reversible secrets (longest-first).
    const literals = this.getSortedLiterals();
    for (const secret of literals) {
      if (result.includes(secret)) {
        const placeholder = this.secretToPlaceholder.get(secret)!;
        result = result.split(secret).join(placeholder);
      }
    }

    // 4. Built-in credential regexes (dynamically register newly seen secrets).
    for (const rule of BUILTIN_CREDENTIAL_RULES) {
      rule.regex.lastIndex = 0;
      if (rule.secretGroup === 2) {
        result = result.replace(rule.regex, (full, prefix: string, secret: string, suffix?: string) => {
          if (!secret || secret.length < MIN_SECRET_LENGTH || isPlaceholderToken(secret)) {
            return full;
          }
          const placeholder = this.registerSecret(secret, rule.label);
          if (!placeholder) return full;
          return `${prefix}${placeholder}${typeof suffix === "string" ? suffix : ""}`;
        });
      } else {
        result = result.replace(rule.regex, (match: string) => {
          if (!match || match.length < MIN_SECRET_LENGTH || isPlaceholderToken(match)) {
            return match;
          }
          return this.registerSecret(match, rule.label) ?? match;
        });
      }
    }

    // 5. Custom reversible regexes from secrets.jsonc.
    for (const rule of this.obfuscateRegexes) {
      rule.regex.lastIndex = 0;
      result = result.replace(rule.regex, (match: string) => {
        if (!match || match.length < MIN_SECRET_LENGTH || isPlaceholderToken(match)) {
          return match;
        }
        return this.registerSecret(match, rule.label) ?? match;
      });
    }

    return result;
  }

  /** Reversibly restore placeholders in `text`. One-way replacements and unknown tokens stay untouched. */
  restoreText(text: string): string {
    if (!text || !text.includes("$$") || this.placeholderToSecret.size === 0) return text;
    PLACEHOLDER_TOKEN_RE.lastIndex = 0;
    return text.replace(PLACEHOLDER_TOKEN_RE, (token) => this.placeholderToSecret.get(token) ?? token);
  }

  /** Copy-on-write recursive obfuscation for arbitrary JSON-like values (e.g. structuredContent, toolCall args). */
  obfuscateValue<T>(value: T): { value: T; changed: boolean } {
    if (typeof value === "string") {
      const next = this.obfuscateText(value);
      return next === value ? { value, changed: false } : { value: next as unknown as T, changed: true };
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const res = this.obfuscateValue(item);
        if (res.changed) changed = true;
        return res.value;
      });
      return changed ? { value: out as unknown as T, changed: true } : { value, changed: false };
    }
    if (value && typeof value === "object") {
      let changed = false;
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        const res = this.obfuscateValue(v);
        if (res.changed) changed = true;
        out[k] = res.value;
      }
      return changed ? { value: out as T, changed: true } : { value, changed: false };
    }
    return { value, changed: false };
  }

  /**
   * Mutate a tool_call `event.input` object in place to restore reversible placeholders
   * before tool execution. Never restores one-way `replace` values.
   */
  restoreToolInput(input: unknown, seen = new WeakSet<object>()): boolean {
    if (!input || typeof input !== "object" || this.placeholderToSecret.size === 0) return false;
    if (seen.has(input)) return false;
    seen.add(input);

    let changed = false;
    if (Array.isArray(input)) {
      for (let i = 0; i < input.length; i++) {
        const el = input[i];
        if (typeof el === "string") {
          const restored = this.restoreText(el);
          if (restored !== el) {
            input[i] = restored;
            changed = true;
          }
        } else if (el && typeof el === "object") {
          if (this.restoreToolInput(el, seen)) changed = true;
        }
      }
      return changed;
    }

    const record = input as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (typeof val === "string") {
        const restored = this.restoreText(val);
        if (restored !== val) {
          record[key] = restored;
          changed = true;
        }
      } else if (val && typeof val === "object") {
        if (this.restoreToolInput(val, seen)) changed = true;
      }
    }
    return changed;
  }

  /** Copy-on-write obfuscation of tool_result content blocks and optional structuredContent. */
  obfuscateToolResult(
    content: readonly (TextContent | ImageContent)[],
    structuredContent?: unknown,
  ): {
    content: (TextContent | ImageContent)[];
    structuredContent: unknown;
    changed: boolean;
  } {
    let changed = false;
    const nextContent = content.map((block) => {
      if (block && block.type === "text" && typeof block.text === "string") {
        const obfuscated = this.obfuscateText(block.text);
        if (obfuscated !== block.text) {
          changed = true;
          return { ...block, text: obfuscated };
        }
      }
      return block;
    });

    let nextStructured = structuredContent;
    if (structuredContent !== undefined) {
      const res = this.obfuscateValue(structuredContent);
      if (res.changed) {
        changed = true;
        nextStructured = res.value;
      }
    }

    return {
      content: changed ? nextContent : (content as (TextContent | ImageContent)[]),
      structuredContent: nextStructured,
      changed,
    };
  }

  /**
   * Copy-on-write obfuscation of provider-bound conversation messages.
   * Explicitly skips any `system` message so static system prompts are NEVER mutated.
   */
  obfuscateMessages(messages: readonly AgentMessage[]): {
    messages: AgentMessage[];
    changed: boolean;
  } {
    let changed = false;
    const nextMessages = messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      const anyMsg = msg as Record<string, unknown>;

      // Never mutate static system prompts (preserves prompt cache stability).
      if (anyMsg.role === "system") return msg;

      let msgChanged = false;
      let nextContent = anyMsg.content;

      if (typeof anyMsg.content === "string") {
        const obf = this.obfuscateText(anyMsg.content);
        if (obf !== anyMsg.content) {
          nextContent = obf;
          msgChanged = true;
        }
      } else if (Array.isArray(anyMsg.content)) {
        let blocksChanged = false;
        const mappedBlocks = anyMsg.content.map((block: any) => {
          if (!block || typeof block !== "object") return block;
          if (block.type === "text" && typeof block.text === "string") {
            const obf = this.obfuscateText(block.text);
            if (obf !== block.text) {
              blocksChanged = true;
              return { ...block, text: obf };
            }
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            const obf = this.obfuscateText(block.thinking);
            if (obf !== block.thinking) {
              blocksChanged = true;
              return { ...block, thinking: obf };
            }
          } else if (block.type === "toolCall" && block.arguments !== undefined) {
            const res = this.obfuscateValue(block.arguments);
            if (res.changed) {
              blocksChanged = true;
              return { ...block, arguments: res.value };
            }
          }
          return block;
        });
        if (blocksChanged) {
          nextContent = mappedBlocks;
          msgChanged = true;
        }
      }

      let nextStructured = anyMsg.structuredContent;
      if (anyMsg.structuredContent !== undefined) {
        const res = this.obfuscateValue(anyMsg.structuredContent);
        if (res.changed) {
          nextStructured = res.value;
          msgChanged = true;
        }
      }

      // bashExecution messages may store `command` / `output` directly.
      let nextCommand = anyMsg.command;
      if (typeof anyMsg.command === "string") {
        const obf = this.obfuscateText(anyMsg.command);
        if (obf !== anyMsg.command) {
          nextCommand = obf;
          msgChanged = true;
        }
      }
      let nextOutput = anyMsg.output;
      if (typeof anyMsg.output === "string") {
        const obf = this.obfuscateText(anyMsg.output);
        if (obf !== anyMsg.output) {
          nextOutput = obf;
          msgChanged = true;
        }
      }

      if (!msgChanged) return msg;
      changed = true;
      const cloned: Record<string, unknown> = { ...anyMsg };
      if (nextContent !== anyMsg.content) cloned.content = nextContent;
      if (nextStructured !== anyMsg.structuredContent) cloned.structuredContent = nextStructured;
      if (nextCommand !== anyMsg.command) cloned.command = nextCommand;
      if (nextOutput !== anyMsg.output) cloned.output = nextOutput;
      return cloned as unknown as AgentMessage;
    });

    return {
      messages: changed ? nextMessages : (messages as AgentMessage[]),
      changed,
    };
  }
}

export function createSecretVault(options: SecretVaultOptions = {}): SecretVault {
  return new SecretVault(options);
}

export interface RegisterSecretObfuscationOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  log?: Logger;
}

/**
 * Register reversible secret obfuscation hooks on the Pi extension API:
 * - `session_start`: collect secrets when `secret_obfuscation` is enabled
 * - `tool_call`: restore placeholders in `event.input` before enforcement/execution
 * - `tool_result`: obfuscate tool outputs before persistence/spill/LLM delivery
 * - `context`: obfuscate provider-bound conversation messages (never system prompts)
 */
export function registerSecretObfuscation(
  pi: ExtensionAPI,
  options: RegisterSecretObfuscationOptions = {},
): { getVault: () => SecretVault | null } {
  const log = options.log ?? defaultLog;
  let vault: SecretVault | null = null;
  let vaultCwd: string | null = null;

  function ensureVault(cwd: string): SecretVault | null {
    if (!getSetting(cwd, "secret_obfuscation")) {
      return null;
    }
    if (!vault || vaultCwd !== cwd) {
      vault = new SecretVault({
        cwd,
        env: options.env,
        homeDir: options.homeDir,
        log,
      });
      vaultCwd = cwd;
    }
    return vault;
  }

  pi.on("session_start", (_event, ctx) => {
    vault = null;
    vaultCwd = null;
    if (getSetting(ctx.cwd, "secret_obfuscation")) {
      vault = new SecretVault({
        cwd: ctx.cwd,
        env: options.env,
        homeDir: options.homeDir,
        log,
      });
      vaultCwd = ctx.cwd;
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const activeVault = ensureVault(ctx.cwd);
    if (!activeVault) return undefined;
    const restored = activeVault.restoreToolInput((event as { input?: unknown }).input);
    if (restored) {
      log.debug("secret_obfuscation_tool_call_restored", {
        toolName: (event as { toolName?: string }).toolName ?? "unknown",
      });
    }
    return undefined;
  });

  pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
    const activeVault = ensureVault(ctx.cwd);
    if (!activeVault) return undefined;
    const content = Array.isArray(event.content) ? event.content : [];
    const res = activeVault.obfuscateToolResult(content, event.structuredContent);
    if (!res.changed) return undefined;
    log.debug("secret_obfuscation_tool_result_redacted", {
      toolName: event.toolName,
      reversibleTotal: activeVault.reversibleCount,
    });
    const out: ToolResultEventResult = { content: res.content };
    if (res.structuredContent !== undefined) {
      out.structuredContent = res.structuredContent as ToolResultEventResult["structuredContent"];
    }
    return out;
  });

  pi.on("context", (event, ctx) => {
    const activeVault = ensureVault(ctx.cwd);
    if (!activeVault) return undefined;
    const res = activeVault.obfuscateMessages(event.messages);
    if (!res.changed) return undefined;
    log.debug("secret_obfuscation_context_redacted", {
      messageCount: res.messages.length,
      reversibleTotal: activeVault.reversibleCount,
    });
    return { messages: res.messages };
  });

  return { getVault: () => vault };
}
