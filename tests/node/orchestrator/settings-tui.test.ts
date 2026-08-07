import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectSource,
  formatValue,
  parseRawValue,
  readSettingsFile,
  writeSettingsFile,
  getFilePathForScope,
  CATEGORIES,
  registerSettingsTuiCommand,
  isSecretNoChange,
  resolveSecretPrefill,
  sourceGlyph,
  filterModelsByProvider,
  EMPTY_VALUE_SENTINEL,
} from "../../../extensions/orchestrator/settings-tui-helpers.js";
import {
  SETTINGS_KEYS,
  setGlobalSettingsPath,
  clearSettingsCache,
} from "../../../extensions/orchestrator/project-settings.js";

// ── detectSource ────────────────────────────────────────────────────

describe("detectSource", () => {
  let tempDir: string;
  let piDir: string;
  let globalDir: string;
  let globalSettingsPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "settings-tui-test-"));
    // Create a fake git repo so resolveRepoRoot works
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    piDir = join(tempDir, ".pi");
    mkdirSync(piDir, { recursive: true });
    globalDir = mkdtempSync(join(tmpdir(), "settings-tui-global-"));
    globalSettingsPath = join(globalDir, "pi-config-settings.json");
    setGlobalSettingsPath(globalSettingsPath);
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    // Clean up env vars we may have set
    delete process.env.PI_DCO;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("returns D when no file and no env", () => {
    const result = detectSource("dco", SETTINGS_KEYS.dco, tempDir);
    assert.equal(result, "D");
  });

  it("returns P when key exists in project settings", () => {
    writeFileSync(join(piDir, "pi-config-settings.json"), JSON.stringify({ dco: true }));
    const result = detectSource("dco", SETTINGS_KEYS.dco, tempDir);
    assert.equal(result, "P");
  });

  it("returns G when key exists in global settings only", () => {
    writeFileSync(globalSettingsPath, JSON.stringify({ dco: true }));
    const result = detectSource("dco", SETTINGS_KEYS.dco, tempDir);
    assert.equal(result, "G");
  });

  it("returns E when key set via env var only", () => {
    process.env.PI_DCO = "true";
    const result = detectSource("dco", SETTINGS_KEYS.dco, tempDir);
    assert.equal(result, "E");
  });

  it("returns P when key exists in both project and global", () => {
    writeFileSync(join(piDir, "pi-config-settings.json"), JSON.stringify({ dco: false }));
    writeFileSync(globalSettingsPath, JSON.stringify({ dco: true }));
    const result = detectSource("dco", SETTINGS_KEYS.dco, tempDir);
    assert.equal(result, "P");
  });

  it("returns P over E when both project file and env exist", () => {
    writeFileSync(join(piDir, "pi-config-settings.json"), JSON.stringify({ dco: true }));
    process.env.PI_DCO = "false";
    const result = detectSource("dco", SETTINGS_KEYS.dco, tempDir);
    assert.equal(result, "P");
  });
});

// ── formatValue ─────────────────────────────────────────────────────

describe("formatValue", () => {
  it("formats bool true", () => {
    assert.equal(formatValue("dco", true, SETTINGS_KEYS.dco), "true");
  });

  it("formats bool false", () => {
    assert.equal(formatValue("dco", false, SETTINGS_KEYS.dco), "false");
  });

  it("formats bool_enable", () => {
    assert.equal(formatValue("pidash_enable", true, SETTINGS_KEYS.pidash_enable), "true");
    assert.equal(formatValue("pidash_enable", false, SETTINGS_KEYS.pidash_enable), "false");
  });

  it("formats bool_or_string with boolean", () => {
    assert.equal(formatValue("commit_trailer", true, SETTINGS_KEYS.commit_trailer), "true");
    assert.equal(formatValue("commit_trailer", false, SETTINGS_KEYS.commit_trailer), "false");
  });

  it("formats bool_or_string with string", () => {
    assert.equal(formatValue("commit_trailer", "my-trailer", SETTINGS_KEYS.commit_trailer), "my-trailer");
  });

  it("formats int", () => {
    assert.equal(formatValue("review_loop_max_cycles", 5, SETTINGS_KEYS.review_loop_max_cycles), "5");
  });

  it("formats port", () => {
    assert.equal(formatValue("pidash_port", 19190, SETTINGS_KEYS.pidash_port), "19190");
  });

  it("formats number", () => {
    assert.equal(formatValue("dream_interval_hours", 3, SETTINGS_KEYS.dream_interval_hours), "3");
  });

  it("formats empty string as (empty)", () => {
    assert.equal(formatValue("image_model", "", SETTINGS_KEYS.image_model), EMPTY_VALUE_SENTINEL);
  });

  it("formats non-empty string", () => {
    assert.equal(formatValue("image_model", "gemini-2.0-flash", SETTINGS_KEYS.image_model), "gemini-2.0-flash");
  });

  it("formats agent_list with entries", () => {
    assert.equal(formatValue("acpx_agents", ["claude", "gemini"], SETTINGS_KEYS.acpx_agents), "claude, gemini");
  });

  it("formats empty agent_list", () => {
    assert.equal(formatValue("acpx_agents", [], SETTINGS_KEYS.acpx_agents), EMPTY_VALUE_SENTINEL);
  });

  it("formats agent_overrides with entries", () => {
    const overrides = { worker: { provider: "litellm" } };
    assert.equal(formatValue("agent_overrides", overrides, SETTINGS_KEYS.agent_overrides), "1 override(s)");
  });

  it("formats empty agent_overrides", () => {
    assert.equal(formatValue("agent_overrides", {}, SETTINGS_KEYS.agent_overrides), "(none)");
  });

  it("formats null/undefined as default", () => {
    assert.equal(formatValue("dco", undefined, SETTINGS_KEYS.dco), "false");
    assert.equal(formatValue("dco", null, SETTINGS_KEYS.dco), "false");
  });

  it("masks secret-like string keys", () => {
    const tokenDef = { type: "string", default: "", env: "PI_COMS_NET_AUTH_TOKEN" } as any;
    assert.equal(formatValue("coms_net_auth_token", "my-super-secret-token", tokenDef), "••••oken");
  });

  it("masks short secret values fully", () => {
    const tokenDef = { type: "string", default: "", env: "PI_COMS_NET_AUTH_TOKEN" } as any;
    assert.equal(formatValue("coms_net_auth_token", "abc", tokenDef), "••••••••");
  });

  it("does not mask empty secret values", () => {
    const tokenDef = { type: "string", default: "", env: "PI_COMS_NET_AUTH_TOKEN" } as any;
    assert.equal(formatValue("coms_net_auth_token", "", tokenDef), EMPTY_VALUE_SENTINEL);
  });

  it("does not mask non-secret string keys", () => {
    assert.equal(formatValue("image_model", "gemini-2.0-flash", SETTINGS_KEYS.image_model), "gemini-2.0-flash");
  });

  it("reads secret value from scope file that contains it", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "settings-secret-scope-"));
    const settingsPath = join(projectDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ coms_net_auth_token: "real-token-value" }));

    const data = readSettingsFile(settingsPath);
    assert.ok(data !== null);
    assert.equal(data!["coms_net_auth_token"], "real-token-value");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns no secret from scope file that does not contain it", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "settings-secret-scope-"));
    const otherPath = join(projectDir, "other.json");
    const otherData = readSettingsFile(otherPath);
    assert.deepEqual(otherData, {});
    assert.equal(otherData!["coms_net_auth_token"], undefined);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("isSecretNoChange treats whitespace-only as no-change when scope has no value", () => {
    // When scope does NOT have the value, empty/whitespace = no change
    assert.equal(isSecretNoChange(undefined, false), true);
    assert.equal(isSecretNoChange("", false), true);
    assert.equal(isSecretNoChange(" ", false), true);
    assert.equal(isSecretNoChange("\t", false), true);
    assert.equal(isSecretNoChange(" \t\n ", false), true);
    assert.equal(isSecretNoChange(EMPTY_VALUE_SENTINEL, false), true);
    // Real input = change
    assert.equal(isSecretNoChange("real-token", false), false);
    assert.equal(isSecretNoChange(" token ", false), false);
  });

  it("isSecretNoChange allows all input when scope has existing value", () => {
    // When scope HAS the value, user is editing — even empty is a valid change (clear)
    assert.equal(isSecretNoChange(undefined, true), false);
    assert.equal(isSecretNoChange("", true), false);
    assert.equal(isSecretNoChange(" ", true), false);
    assert.equal(isSecretNoChange("new-token", true), false);
  });
});

// ── parseRawValue ───────────────────────────────────────────────────

describe("parseRawValue", () => {
  it("parses bool true", () => {
    assert.equal(parseRawValue("dco", "true", SETTINGS_KEYS.dco), true);
  });

  it("parses bool false", () => {
    assert.equal(parseRawValue("dco", "false", SETTINGS_KEYS.dco), false);
  });

  it("parses bool_enable", () => {
    assert.equal(parseRawValue("pidash_enable", "true", SETTINGS_KEYS.pidash_enable), true);
    assert.equal(parseRawValue("pidash_enable", "false", SETTINGS_KEYS.pidash_enable), false);
  });

  it("parses bool_or_string true/false", () => {
    assert.equal(parseRawValue("commit_trailer", "true", SETTINGS_KEYS.commit_trailer), true);
    assert.equal(parseRawValue("commit_trailer", "false", SETTINGS_KEYS.commit_trailer), false);
  });

  it("parses bool_or_string custom value", () => {
    assert.equal(parseRawValue("commit_trailer", "my-trailer", SETTINGS_KEYS.commit_trailer), "my-trailer");
  });

  it("parses int", () => {
    assert.equal(parseRawValue("review_loop_max_cycles", "5", SETTINGS_KEYS.review_loop_max_cycles), 5);
  });

  it("parses port", () => {
    assert.equal(parseRawValue("pidash_port", "8080", SETTINGS_KEYS.pidash_port), 8080);
  });

  it("parses number", () => {
    assert.equal(parseRawValue("dream_interval_hours", "4.5", SETTINGS_KEYS.dream_interval_hours), 4.5);
  });

  it("parses string", () => {
    assert.equal(parseRawValue("image_model", "gemini-2.0-flash", SETTINGS_KEYS.image_model), "gemini-2.0-flash");
  });

  it("parses empty string to empty", () => {
    assert.equal(parseRawValue("image_model", EMPTY_VALUE_SENTINEL, SETTINGS_KEYS.image_model), "");
  });

  it("parses agent_list comma-separated", () => {
    assert.deepEqual(parseRawValue("acpx_agents", "claude, gemini", SETTINGS_KEYS.acpx_agents), ["claude", "gemini"]);
  });

  it("parses empty agent_list", () => {
    assert.deepEqual(parseRawValue("acpx_agents", "", SETTINGS_KEYS.acpx_agents), []);
    assert.deepEqual(parseRawValue("acpx_agents", EMPTY_VALUE_SENTINEL, SETTINGS_KEYS.acpx_agents), []);
  });

  it("round-trips bool values", () => {
    const def = SETTINGS_KEYS.dco;
    const formatted = formatValue("dco", true, def);
    assert.equal(parseRawValue("dco", formatted, def), true);
  });

  it("round-trips int values", () => {
    const def = SETTINGS_KEYS.review_loop_max_cycles;
    const formatted = formatValue("review_loop_max_cycles", 7, def);
    assert.equal(parseRawValue("review_loop_max_cycles", formatted, def), 7);
  });

  it("round-trips string values", () => {
    const def = SETTINGS_KEYS.image_model;
    const formatted = formatValue("image_model", "gemini-2.0-flash", def);
    assert.equal(parseRawValue("image_model", formatted, def), "gemini-2.0-flash");
  });

  it("round-trips empty string", () => {
    const def = SETTINGS_KEYS.image_model;
    const formatted = formatValue("image_model", "", def);
    assert.equal(parseRawValue("image_model", formatted, def), "");
  });

  it("returns undefined for empty int", () => {
    assert.equal(parseRawValue("review_loop_max_cycles", "", SETTINGS_KEYS.review_loop_max_cycles), undefined);
  });

  it("returns undefined for empty port", () => {
    assert.equal(parseRawValue("pidash_port", "", SETTINGS_KEYS.pidash_port), undefined);
  });
});

// ── CATEGORIES coverage ─────────────────────────────────────────────────────

describe("CATEGORIES coverage (drift detection against settings-keys.json)", () => {
  it("covers all settings keys", () => {
    const categorizedKeys = new Set(CATEGORIES.flatMap((c) => c.keys));
    for (const key of Object.keys(SETTINGS_KEYS)) {
      assert.ok(categorizedKeys.has(key), `settings key "${key}" is not in any category`);
    }
  });

  it("has no duplicate keys across categories", () => {
    const seen = new Set<string>();
    for (const category of CATEGORIES) {
      for (const key of category.keys) {
        assert.ok(!seen.has(key), `key "${key}" appears in multiple categories`);
        seen.add(key);
      }
    }
  });

  it("only references valid settings keys", () => {
    for (const category of CATEGORIES) {
      for (const key of category.keys) {
        assert.ok(key in SETTINGS_KEYS, `category "${category.label}" references unknown key "${key}"`);
      }
    }
  });

  it("detectSource returns valid source types for all keys", () => {
    const validSources = new Set(["P", "G", "E", "D"]);
    // With no files and no env, every key should return "D"
    for (const key of Object.keys(SETTINGS_KEYS)) {
      const tempDir2 = mkdtempSync(join(tmpdir(), "settings-drift-"));
      mkdirSync(join(tempDir2, ".git"), { recursive: true });
      mkdirSync(join(tempDir2, ".pi"), { recursive: true });
      const source = detectSource(key, SETTINGS_KEYS[key], tempDir2);
      assert.ok(validSources.has(source), `detectSource for "${key}" returned invalid source "${source}"`);
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });
});

// ── readSettingsFile / writeSettingsFile ─────────────────────────────

describe("readSettingsFile / writeSettingsFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "settings-tui-rw-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads existing JSON file", () => {
    const filePath = join(tempDir, "settings.json");
    writeFileSync(filePath, JSON.stringify({ dco: true, pidash_port: 9999 }));
    const result = readSettingsFile(filePath);
    assert.deepEqual(result, { dco: true, pidash_port: 9999 });
  });

  it("returns empty object for non-existent file", () => {
    const result = readSettingsFile(join(tempDir, "nope.json"));
    assert.deepEqual(result, {});
  });

  it("returns null for invalid JSON", () => {
    const filePath = join(tempDir, "bad.json");
    writeFileSync(filePath, "not json at all");
    const result = readSettingsFile(filePath);
    assert.equal(result, null);
  });

  it("returns null for array JSON", () => {
    const filePath = join(tempDir, "array.json");
    writeFileSync(filePath, "[1,2,3]");
    const result = readSettingsFile(filePath);
    assert.equal(result, null);
  });

  it("writes JSON file with formatting", () => {
    const filePath = join(tempDir, "out.json");
    writeSettingsFile(filePath, { dco: true, pidash_port: 8080 });
    const content = readFileSync(filePath, "utf-8");
    assert.ok(content.includes('"dco": true'), "should contain formatted dco");
    assert.ok(content.includes('"pidash_port": 8080'), "should contain formatted port");
    assert.ok(content.endsWith("\n"), "should end with newline");
  });

  it("creates parent directories", () => {
    const filePath = join(tempDir, "sub", "dir", "settings.json");
    writeSettingsFile(filePath, { use_worktrees: true });
    const result = readSettingsFile(filePath);
    assert.deepEqual(result, { use_worktrees: true });
  });

  it("round-trips data correctly", () => {
    const filePath = join(tempDir, "roundtrip.json");
    const data = {
      dco: true,
      commit_trailer: "my-trailer",
      pidash_port: 9999,
      acpx_agents: ["claude", "gemini"],
      dream_interval_hours: 4.5,
    };
    writeSettingsFile(filePath, data);
    const result = readSettingsFile(filePath);
    assert.deepEqual(result, data);
  });

  it("writes data to .jsonc file", () => {
    const jsoncPath = join(tempDir, "pi-config-settings.jsonc");
    writeFileSync(jsoncPath, '// user comments\n{"dco": true}');
    writeSettingsFile(jsoncPath, { dco: true, use_worktrees: true });
    const content = readFileSync(jsoncPath, "utf-8");
    assert.ok(content.includes('"use_worktrees": true'), "should have new data");
    assert.ok(content.includes('"dco": true'), "should preserve existing keys");
  });

  it("strips comments from .jsonc on write (per spec)", () => {
    const jsoncPath = join(tempDir, "pi-config-settings-comments.jsonc");
    writeFileSync(jsoncPath, '// user comments\n{"dco": true}');
    writeSettingsFile(jsoncPath, { dco: true });
    const content = readFileSync(jsoncPath, "utf-8");
    assert.ok(!content.includes("// user comments"), "comments should be stripped");
  });

  it("throws on write to read-only path", () => {
    // writeSettingsFile wraps writeFileSync+renameSync in try/catch and re-throws
    // The callers (saveChange/deleteFromScope) catch this and return false
    // Use /proc as a path that exists but is not writable
    assert.throws(() => {
      writeSettingsFile("/proc/settings-tui-test.json", { dco: true });
    });
  });
});

// ── getFilePathForScope ─────────────────────────────────────────────

describe("getFilePathForScope", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "settings-tui-scope-"));
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    globalDir = mkdtempSync(join(tmpdir(), "settings-tui-scope-global-"));
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("returns project path for project scope", () => {
    const result = getFilePathForScope("project", tempDir);
    assert.ok(result.includes(".pi"), "should include .pi directory");
    assert.ok(result.includes("pi-config-settings"), "should include settings filename");
  });

  it("returns global path for global scope", () => {
    const result = getFilePathForScope("global", tempDir);
    assert.ok(result.includes("pi-config-settings"), "should include settings filename");
  });
});

// ── buildSettingItems coverage (indirect — via helpers it composes) ──

describe("buildSettingItems integration", () => {
  it("every CATEGORIES key has a matching SETTINGS_KEYS entry with valid type", () => {
    const validTypes = new Set(["bool", "bool_enable", "bool_or_string", "string", "int", "port", "number", "agent_list", "agent_overrides"]);
    for (const category of CATEGORIES) {
      for (const key of category.keys) {
        const def = SETTINGS_KEYS[key];
        assert.ok(def, `key "${key}" in category "${category.label}" not found in SETTINGS_KEYS`);
        assert.ok(validTypes.has(def.type), `key "${key}" has unknown type "${def.type}"`);
      }
    }
  });

  it("bool keys have no min/max", () => {
    for (const category of CATEGORIES) {
      for (const key of category.keys) {
        const def = SETTINGS_KEYS[key];
        if (def.type === "bool" || def.type === "bool_enable") {
          assert.equal(def.min, undefined, `bool key "${key}" should not have min`);
          assert.equal(def.max, undefined, `bool key "${key}" should not have max`);
        }
      }
    }
  });

  it("int/port keys have valid min/max constraints", () => {
    for (const category of CATEGORIES) {
      for (const key of category.keys) {
        const def = SETTINGS_KEYS[key];
        if (def.type === "int" || def.type === "port") {
          if (def.min !== undefined && def.max !== undefined) {
            assert.ok(def.min <= def.max, `key "${key}": min (${def.min}) > max (${def.max})`);
          }
        }
      }
    }
  });

  it("formatValue round-trips with parseRawValue for every type", () => {
    const testValues: Record<string, unknown> = {
      bool: true,
      bool_enable: false,
      bool_or_string: "custom-trailer",
      string: "test-value",
      int: 5,
      port: 8080,
      number: 3.5,
      agent_list: ["claude", "gemini"],
      agent_overrides: { worker: { provider: "litellm" } },
    };

    const SECRET_PATTERNS = /token|secret|password|auth/i;

    for (const category of CATEGORIES) {
      for (const key of category.keys) {
        const def = SETTINGS_KEYS[key];
        const testVal = testValues[def.type];
        // Secret strings are masked by formatValue — skip round-trip
        if (testVal === undefined || def.type === "agent_overrides" || SECRET_PATTERNS.test(key)) continue;

        const formatted = formatValue(key, testVal, def);
        const parsed = parseRawValue(key, formatted, def);

        if (def.type === "agent_list") {
          assert.deepEqual(parsed, testVal, `round-trip failed for ${key} (${def.type})`);
        } else {
          assert.equal(parsed, testVal, `round-trip failed for ${key} (${def.type})`);
        }
      }
    }
  });
});

// ── registerSettingsTui guard ────────────────────────────────────────

describe("registerSettingsTuiCommand", () => {
  it("registers pi-config-settings command when PI_SUBAGENT_CHILD is unset", () => {
    const original = process.env.PI_SUBAGENT_CHILD;
    try {
      delete process.env.PI_SUBAGENT_CHILD;

      const registered: Array<{ name: string; description: string }> = [];
      const mockPi = {
        registerCommand: (name: string, opts: { description: string; handler: any }) => {
          registered.push({ name, description: opts.description });
        },
      };
      const mockHandler = async () => {};

      registerSettingsTuiCommand(mockPi, mockHandler);

      assert.equal(registered.length, 1, "should register one command");
      assert.equal(registered[0].name, "pi-config-settings");
      assert.equal(registered[0].description, "Interactive settings editor for pi-config");
    } finally {
      if (original !== undefined) process.env.PI_SUBAGENT_CHILD = original;
      else delete process.env.PI_SUBAGENT_CHILD;
    }
  });

  it("skips registration when PI_SUBAGENT_CHILD=1", () => {
    const original = process.env.PI_SUBAGENT_CHILD;
    try {
      process.env.PI_SUBAGENT_CHILD = "1";

      const registered: string[] = [];
      const mockPi = {
        registerCommand: (name: string) => { registered.push(name); },
      };
      const mockHandler = async () => {};

      registerSettingsTuiCommand(mockPi as any, mockHandler);

      assert.equal(registered.length, 0, "should not register when PI_SUBAGENT_CHILD=1");
    } finally {
      if (original !== undefined) process.env.PI_SUBAGENT_CHILD = original;
      else delete process.env.PI_SUBAGENT_CHILD;
    }
  });

  it("allows registration when PI_SUBAGENT_CHILD=0", () => {
    const original = process.env.PI_SUBAGENT_CHILD;
    try {
      process.env.PI_SUBAGENT_CHILD = "0";

      const registered: string[] = [];
      const mockPi = {
        registerCommand: (name: string) => { registered.push(name); },
      };
      const mockHandler = async () => {};

      registerSettingsTuiCommand(mockPi as any, mockHandler);

      assert.equal(registered.length, 1, "should register when PI_SUBAGENT_CHILD=0");
      assert.equal(registered[0], "pi-config-settings");
    } finally {
      if (original !== undefined) process.env.PI_SUBAGENT_CHILD = original;
      else delete process.env.PI_SUBAGENT_CHILD;
    }
  });
});

// ── resolveSecretPrefill (secret scope composition) ────────────────

describe("resolveSecretPrefill", () => {
  let tempDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "settings-secret-prefill-"));
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    globalDir = mkdtempSync(join(tmpdir(), "settings-secret-prefill-global-"));
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("returns scope value but empty prefill when secret exists in project scope", () => {
    writeFileSync(join(tempDir, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_net_auth_token: "project-token" }));
    const result = resolveSecretPrefill("coms_net_auth_token", "project", tempDir);
    assert.equal(result.scopeValue, "project-token");
    assert.equal(result.prefill, "", "prefill must be empty to avoid exposing secret on screen");
    assert.ok(result.hint.length > 0, "hint should be non-empty");
  });

  it("returns null scope value when secret not in project scope", () => {
    const result = resolveSecretPrefill("coms_net_auth_token", "project", tempDir);
    assert.equal(result.scopeValue, null);
    assert.equal(result.prefill, "");
    assert.ok(result.hint.length > 0, "hint should be non-empty");
  });

  it("does not leak global secret into project scope prefill", () => {
    // Secret set in global, NOT in project
    writeFileSync(join(globalDir, "pi-config-settings.json"), JSON.stringify({ coms_net_auth_token: "global-token" }));
    const result = resolveSecretPrefill("coms_net_auth_token", "project", tempDir);
    assert.equal(result.scopeValue, null, "should not see global token in project scope");
    assert.equal(result.prefill, "");
  });

  it("returns global scope value but empty prefill when editing global scope", () => {
    writeFileSync(join(globalDir, "pi-config-settings.json"), JSON.stringify({ coms_net_auth_token: "global-token" }));
    const result = resolveSecretPrefill("coms_net_auth_token", "global", tempDir);
    assert.equal(result.scopeValue, "global-token");
    assert.equal(result.prefill, "", "prefill must be empty to avoid exposing secret on screen");
  });

  it("end-to-end: secret not in scope + empty submit = no change", () => {
    // Compose resolveSecretPrefill + isSecretNoChange like buildSettingItems does
    const info = resolveSecretPrefill("coms_net_auth_token", "project", tempDir);
    assert.equal(info.scopeValue, null);
    // Empty submit should be treated as no-change
    assert.equal(isSecretNoChange("", info.scopeValue !== null), true);
    assert.equal(isSecretNoChange(undefined, info.scopeValue !== null), true);
    assert.equal(isSecretNoChange(EMPTY_VALUE_SENTINEL, info.scopeValue !== null), true);
    // Real input should be a change
    assert.equal(isSecretNoChange("new-token", info.scopeValue !== null), false);
  });

  it("end-to-end: secret in scope + empty submit = allowed change", () => {
    writeFileSync(join(tempDir, ".pi", "pi-config-settings.json"), JSON.stringify({ coms_net_auth_token: "existing" }));
    const info = resolveSecretPrefill("coms_net_auth_token", "project", tempDir);
    assert.equal(info.scopeValue, "existing");
    // Empty submit when scope HAS value = user wants to clear
    assert.equal(isSecretNoChange("", info.scopeValue !== null), false);
    assert.equal(isSecretNoChange(undefined, info.scopeValue !== null), false);
  });
});

// ── sourceGlyph ───────────────────────────────────────────────────────

describe("sourceGlyph", () => {
  const mockTheme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
  };

  it("returns themed P for project source", () => {
    assert.equal(sourceGlyph("P", mockTheme), "[success:P]");
  });

  it("returns themed G for global source", () => {
    assert.equal(sourceGlyph("G", mockTheme), "[accent:G]");
  });

  it("returns themed E for env source", () => {
    assert.equal(sourceGlyph("E", mockTheme), "[warning:E]");
  });

  it("returns themed D for default source", () => {
    assert.equal(sourceGlyph("D", mockTheme), "[dim:D]");
  });

  it("returns themed ? for unknown source", () => {
    assert.equal(sourceGlyph("X", mockTheme), "[dim:?]");
  });
});

// ── filterModelsByProvider ──────────────────────────────────────────

describe("filterModelsByProvider", () => {
  it("returns all models when no provider specified", () => {
    const models = [
      { value: "model-a", label: "model-a", description: "provider-1" },
      { value: "model-b", label: "model-b", description: "provider-2" },
    ];
    const result = filterModelsByProvider(models);
    assert.equal(result.length, 2);
  });

  it("returns all models when provider is empty string", () => {
    const models = [
      { value: "model-a", label: "model-a", description: "provider-1" },
    ];
    const result = filterModelsByProvider(models, "");
    assert.equal(result.length, 1);
  });

  it("filters models by provider", () => {
    const models = [
      { value: "model-a", label: "model-a", description: "provider-1" },
      { value: "model-b", label: "model-b", description: "provider-2" },
      { value: "model-c", label: "model-c", description: "provider-1" },
    ];
    const result = filterModelsByProvider(models, "provider-1");
    assert.equal(result.length, 2);
    assert.ok(result.every((m) => m.description === "provider-1"));
  });

  it("returns empty array when no models match provider", () => {
    const models = [
      { value: "model-a", label: "model-a", description: "provider-1" },
    ];
    const result = filterModelsByProvider(models, "unknown");
    assert.equal(result.length, 0);
  });
});
