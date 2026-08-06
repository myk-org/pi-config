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
    assert.equal(formatValue("image_model", "", SETTINGS_KEYS.image_model), "(empty)");
  });

  it("formats non-empty string", () => {
    assert.equal(formatValue("image_model", "gemini-2.0-flash", SETTINGS_KEYS.image_model), "gemini-2.0-flash");
  });

  it("formats agent_list with entries", () => {
    assert.equal(formatValue("acpx_agents", ["claude", "gemini"], SETTINGS_KEYS.acpx_agents), "claude, gemini");
  });

  it("formats empty agent_list", () => {
    assert.equal(formatValue("acpx_agents", [], SETTINGS_KEYS.acpx_agents), "(empty)");
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
    assert.equal(formatValue("coms_net_auth_token", "", tokenDef), "(empty)");
  });

  it("does not mask non-secret string keys", () => {
    assert.equal(formatValue("image_model", "gemini-2.0-flash", SETTINGS_KEYS.image_model), "gemini-2.0-flash");
  });

  it("readSettingsFile returns scope-specific value for secret keys", () => {
    // Simulate: secret set in project file only
    const projectDir = mkdtempSync(join(tmpdir(), "settings-secret-scope-"));
    const settingsPath = join(projectDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ coms_net_auth_token: "real-token-value" }));

    const data = readSettingsFile(settingsPath);
    assert.ok(data !== null);
    assert.equal(data!["coms_net_auth_token"], "real-token-value");

    // Secret not in another scope file
    const otherPath = join(projectDir, "other.json");
    const otherData = readSettingsFile(otherPath);
    assert.deepEqual(otherData, {}); // missing file = empty, not the secret
    assert.equal(otherData!["coms_net_auth_token"], undefined);

    rmSync(projectDir, { recursive: true, force: true });
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
    assert.equal(parseRawValue("image_model", "(empty)", SETTINGS_KEYS.image_model), "");
  });

  it("parses agent_list comma-separated", () => {
    assert.deepEqual(parseRawValue("acpx_agents", "claude, gemini", SETTINGS_KEYS.acpx_agents), ["claude", "gemini"]);
  });

  it("parses empty agent_list", () => {
    assert.deepEqual(parseRawValue("acpx_agents", "", SETTINGS_KEYS.acpx_agents), []);
    assert.deepEqual(parseRawValue("acpx_agents", "(empty)", SETTINGS_KEYS.acpx_agents), []);
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

describe("CATEGORIES coverage", () => {
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

  it("writes directly to .jsonc file", () => {
    const jsoncPath = join(tempDir, "pi-config-settings.jsonc");
    writeFileSync(jsoncPath, '// user comments\n{"dco": true}');
    writeSettingsFile(jsoncPath, { dco: true, use_worktrees: true });
    const content = readFileSync(jsoncPath, "utf-8");
    assert.ok(content.includes('"use_worktrees": true'), "should write new data to .jsonc");
    assert.ok(content.includes('"dco": true'), "should preserve existing keys");
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
