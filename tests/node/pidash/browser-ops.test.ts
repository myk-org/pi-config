/** #968 G — browser-ops settings payload/apply round-trip (project scope only; global touches real home). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetting, buildSettingsPayload, validateSettingValue } from "../../../extensions/pidash/browser-ops.ts";
import { SETTINGS_KEYS } from "../../../extensions/orchestrator/project-settings.ts";

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pidash-settings-"));
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

  it("applySetting writes project file and round-trips through payload", () => {
    const dir = tempProject();
    try {
      const r1 = applySetting(dir, "project", "dco", true);
      assert.ok(r1.ok, r1.error);
      const file = join(dir, ".pi", "pi-config-settings.jsonc");
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
      const file = join(dir, ".pi", "pi-config-settings.jsonc");
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

  it("agent_overrides requires an object", () => {
    assert.match(validateSettingValue("agent_overrides", "worker")!, /object/);
    assert.equal(validateSettingValue("agent_overrides", { worker: { model: "x" } }), null);
  });
});
