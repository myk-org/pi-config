/** #968 G — browser-ops settings payload/apply round-trip (project scope only; global touches real home). */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { join } from "node:path";
import { applySetting, buildSettingsPayload, mcpList, validateSettingValue } from "../../../extensions/pidash/browser-ops.ts";
import { SETTINGS_KEYS } from "../../../extensions/orchestrator/project-settings.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";


function tempProject(): string {
  const dir = makeTempDir("pidash-settings-");
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  return dir;
}

describe("browser-ops settings", () => {
  it("payload lists every settings-keys.json key with metadata", () => {
    const dir = tempProject();
    try {
      const payload = buildSettingsPayload(dir, "project");
      assert.equal(payload.scope, "project");
      assert.ok(payload.keys.length >= 50, `expected the full key set, got ${payload.keys.length}`);
      assert.equal(payload.keys.length, Object.keys(SETTINGS_KEYS).length);
      const dco = payload.keys.find((k) => k.key === "dco");
      assert.ok(dco, "dco key present");
      assert.equal(dco!.type, "bool");
      assert.equal(dco!.stored, undefined, "nothing stored in fresh temp project");
      assert.ok(dco!.group, "group carried");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalid scope returns an error payload", () => {
    const payload = buildSettingsPayload("/tmp", "bogus");
    assert.ok(payload.error);
  });

  it("payload carries the resolved settings path — identical from a subdirectory (Qodo R7)", () => {
    const dir = tempProject();
    try {
      const fromRoot = buildSettingsPayload(dir, "project");
      assert.ok(fromRoot.settingsPath, "project payload carries settingsPath");
      assert.equal(fromRoot.settingsPath, join(dir, ".pi", "pi-config-settings.json"));

      // A session running in a repo subdirectory resolves to the SAME
      // settings file — this identity is what SettingsPanel uses to accept
      // or reject cross-session broadcasts. getSettingsPath resolves through
      // git rev-parse --git-common-dir, so the temp project must be a repo.
      mkdirSync(join(dir, "packages", "nested", "deeper"), { recursive: true });
      const fromSub = buildSettingsPayload(join(dir, "packages", "nested", "deeper"), "project");
      assert.equal(fromSub.settingsPath, fromRoot.settingsPath, "subdir resolves to the same settings file");

      // Global scope has no project file identity.
      const global = buildSettingsPayload(dir, "global");
      assert.equal(global.settingsPath, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applySetting writes project file and round-trips through payload", () => {
    const dir = tempProject();
    try {
      const r1 = applySetting(dir, "project", "dco", true);
      assert.ok(r1.ok, r1.error);
      const file = join(dir, ".pi", "pi-config-settings.json");
      assert.ok(existsSync(file), "settings file created");
      const onDisk = JSON.parse(readFileSync(file, "utf-8"));
      assert.equal(onDisk.dco, true);

      const payload = buildSettingsPayload(dir, "project");
      assert.equal(payload.keys.find((k) => k.key === "dco")!.stored, true);

      // clear
      const r2 = applySetting(dir, "project", "dco", null);
      assert.ok(r2.ok, r2.error);
      const onDisk2 = JSON.parse(readFileSync(file, "utf-8"));
      assert.equal("dco" in onDisk2, false);
      const payload2 = buildSettingsPayload(dir, "project");
      assert.equal(payload2.keys.find((k) => k.key === "dco")!.stored, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applySetting preserves existing keys in the file", () => {
    const dir = tempProject();
    try {
      const file = join(dir, ".pi", "pi-config-settings.json");
      writeFileSync(file, JSON.stringify({ pidash_enable: true }), "utf-8");
      const r = applySetting(dir, "project", "dco", true);
      assert.ok(r.ok, r.error);
      const onDisk = JSON.parse(readFileSync(file, "utf-8"));
      assert.equal(onDisk.pidash_enable, true, "pre-existing key preserved");
      assert.equal(onDisk.dco, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown key is rejected", () => {
    const dir = tempProject();
    try {
      assert.equal(applySetting(dir, "project", "not_a_real_key", true).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalid scope is rejected", () => {
    const dir = tempProject();
    try {
      assert.equal(applySetting(dir, "galactic", "dco", true).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dangerous_command_allowlist writes are refused from the browser", () => {
    const dir = tempProject();
    try {
      const res = applySetting(dir, "project", "dangerous_command_allowlist", ["*"]);
      assert.equal(res.ok, false);
      assert.match(res.error!, /managed by the terminal settings editor/);
      assert.ok(!existsSync(join(dir, ".pi", "pi-config-settings.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restricted_folders writes are refused from the browser", () => {
    const dir = tempProject();
    try {
      const res = applySetting(dir, "project", "restricted_folders", []);
      assert.equal(res.ok, false);
      assert.match(res.error!, /managed by the terminal settings editor/);
      assert.ok(!existsSync(join(dir, ".pi", "pi-config-settings.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tool_permissions writes are refused from the browser", () => {
    const dir = tempProject();
    try {
      const res = applySetting(dir, "project", "tool_permissions", { "*": "allow" });
      assert.equal(res.ok, false);
      assert.match(res.error!, /managed by the terminal settings editor/);
      assert.ok(!existsSync(join(dir, ".pi", "pi-config-settings.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed settings file refuses to save instead of being replaced", () => {
    const dir = tempProject();
    try {
      const file = join(dir, ".pi", "pi-config-settings.json");
      writeFileSync(file, "{ broken json !!");
      const res = applySetting(dir, "project", "dco", true);
      assert.equal(res.ok, false);
      assert.match(res.error!, /malformed/);
      // The user's broken file must still be intact — not rewritten
      assert.equal(readFileSync(file, "utf-8"), "{ broken json !!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown keys in the settings file survive a browser write", () => {
    const dir = tempProject();
    try {
      const file = join(dir, ".pi", "pi-config-settings.json");
      writeFileSync(file, JSON.stringify({ some_future_key: "keep me", dco: false }));
      const res = applySetting(dir, "project", "dco", true);
      assert.equal(res.ok, true);
      const after = JSON.parse(readFileSync(file, "utf-8"));
      assert.equal(after.dco, true);
      assert.equal(after.some_future_key, "keep me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateSettingValue", () => {
  it("bool rejects non-boolean values", () => {
    assert.equal(validateSettingValue("dco", "yes"), "dco must be a boolean");
    assert.equal(validateSettingValue("dco", null), null);
    assert.equal(validateSettingValue("dco", true), null);
  });

  it("int enforces integer type and bounds", () => {
    assert.match(validateSettingValue("review_loop_max_cycles", 2.5)!, /integer/);
    assert.match(validateSettingValue("review_loop_max_cycles", 99)!, /<= 10/);
    assert.equal(validateSettingValue("review_loop_max_cycles", 3), null);
  });

  it("accepts 0 or 20..99 for auto_compact_threshold_pct", () => {
    assert.equal(validateSettingValue("auto_compact_threshold_pct", 0), null);
    assert.equal(validateSettingValue("auto_compact_threshold_pct", 20), null);
    assert.equal(validateSettingValue("auto_compact_threshold_pct", 99), null);
  });

  it("rejects invalid bounds for auto_compact_threshold_pct", () => {
    assert.ok(validateSettingValue("auto_compact_threshold_pct", 1));
    assert.ok(validateSettingValue("auto_compact_threshold_pct", 19));
    assert.ok(validateSettingValue("auto_compact_threshold_pct", -1));
    assert.ok(validateSettingValue("auto_compact_threshold_pct", 100));
    assert.ok(validateSettingValue("auto_compact_threshold_pct", 50.5));
  });

  it("exposes allow_zero metadata in settings payload for auto_compact_threshold_pct", () => {
    const dir = tempProject();
    try {
      const payload = buildSettingsPayload(dir, "project");
      const entry = payload.keys.find((k) => k.key === "auto_compact_threshold_pct");
      assert.ok(entry);
      assert.equal(entry!.min, 20);
      assert.equal(entry!.max, 99);
      assert.equal(entry!.allow_zero, true);
      assert.equal(entry!.default, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent_overrides requires an object", () => {
    assert.match(validateSettingValue("agent_overrides", "worker")!, /object/);
    assert.equal(validateSettingValue("agent_overrides", { worker: { model: "x" } }), null);
  });

  it("allows empty strings for non-enum string keys while rejecting them for enum keys (#1353)", () => {
    assert.equal(validateSettingValue("widget_tasks_shortcut", ""), null);
    assert.equal(validateSettingValue("enforcement_allowed_commands", ""), null);
    assert.equal(validateSettingValue("internal_operations_model", ""), null);
    assert.match(validateSettingValue("widgets_default_mode", "")!, /must be one of/);
    assert.match(validateSettingValue("log_coms", "loud")!, /must be one of/);
    assert.equal(validateSettingValue("widgets_default_mode", "collapsed"), null);
  });
});

describe("mcpList (#1481)", () => {
  it("parses servers with untruncated >250-char error from err.stdout when pi mcp list --json exits code 1", async () => {
    const longErr = `MCP_BROKEN_${"E".repeat(260)}_TAIL`;
    const payload = {
      servers: [
        { name: "healthy", state: "connected", tools: ["ping"] },
        { name: "broken", state: "error", error: longErr },
      ],
    };
    const runner = async () => {
      throw Object.assign(new Error("Command failed: pi mcp list --json"), {
        code: 1,
        stdout: JSON.stringify(payload),
        stderr: "",
      });
    };

    const res = await mcpList("/tmp", runner);

    assert.equal(res.error, undefined);
    assert.equal(res.servers?.length, 2);
    const [healthy, broken] = res.servers as Array<{ name: string; state: string; tools?: string[]; error?: string }>;
    assert.deepEqual(healthy, { name: "healthy", state: "connected", tools: ["ping"] });
    assert.equal(broken.name, "broken");
    assert.equal(broken.state, "error");
    assert.equal(broken.error, longErr);
    assert.ok(broken.error!.length > 250);
  });

  it("parses top-level JSON array from Buffer err.stdout on non-zero exit", async () => {
    const runner = async () => {
      throw Object.assign(new Error("Command failed: pi mcp list --json"), {
        code: 1,
        stdout: Buffer.from(JSON.stringify([{ name: "srv", state: "error", error: "fail" }]), "utf-8"),
        stderr: "",
      });
    };

    const res = await mcpList("/tmp", runner);

    assert.equal(res.error, undefined);
    assert.equal(res.servers?.length, 1);
    const [srv] = res.servers as Array<{ name: string; state: string; error?: string }>;
    assert.deepEqual(srv, { name: "srv", state: "error", error: "fail" });
  });

  it("falls back to error when non-zero exit stdout is non-JSON", async () => {
    const runner = async () => {
      throw Object.assign(new Error("Command failed: pi mcp list --json"), {
        code: 1,
        stdout: "not valid json",
        stderr: "pi mcp failed",
      });
    };

    const res = await mcpList("/tmp", runner);

    assert.equal(res.servers, undefined);
    assert.equal(res.error, "pi mcp failed");
  });

  it("falls back to error when non-zero exit stdout is a plain JSON error object", async () => {
    const runner = async () => {
      throw Object.assign(new Error("Command failed: pi mcp list --json"), {
        code: 1,
        stdout: JSON.stringify({ error: "not logged in" }),
        stderr: "",
      });
    };

    const res = await mcpList("/tmp", runner);

    assert.equal(res.servers, undefined);
    assert.equal(res.error, "Command failed: pi mcp list --json");
  });

  it("falls back to error when non-zero exit stdout has an empty server list", async () => {
    const runner = async () => {
      throw Object.assign(new Error("Command failed: pi mcp list --json"), {
        code: 1,
        stdout: JSON.stringify({ servers: [] }),
        stderr: "mcp daemon unavailable",
      });
    };

    const res = await mcpList("/tmp", runner);

    assert.equal(res.servers, undefined);
    assert.equal(res.error, "mcp daemon unavailable");
  });
});
