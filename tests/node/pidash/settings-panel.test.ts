/**
 * Unit tests for #1473 PiDash SettingsPanel parity: scope isolation,
 * left category sidebar grouping, cross-category search, and Copy button.
 *
 * Run with: npx tsx --test tests/node/pidash/settings-panel.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildSettingsPayload } from "../../../extensions/pidash/browser-ops.ts";
import {
  buildSettingsCategories,
  filterSettingsKeys,
  getCopyableSettingValue,
} from "../../../extensions/pidash/pidash-ui/src/lib/settings-edit.ts";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("PiDash settings payload scope isolation (#1473)", () => {
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    projectDir = makeTempDir("pidash-1473-proj-");
    execFileSync("git", ["init", "-q", projectDir]);
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("pidash-1473-global-");
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("isolates global payload from project dangerous_command_allowlist overrides", () => {
    const tenPatterns = Array.from({ length: 10 }, (_, i) => `cmd-${i}`);
    writeFileSync(
      join(projectDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ dangerous_command_allowlist: tenPatterns }),
      "utf8",
    );
    clearSettingsCache();

    const globalPayload = buildSettingsPayload(projectDir, "global");
    const allowlist = globalPayload.keys.find((k) => k.key === "dangerous_command_allowlist");
    assert.ok(allowlist);
    assert.equal(allowlist.stored, undefined);
    assert.deepEqual(allowlist.effective, []);
    assert.equal(allowlist.source, "D");

    const projectPayload = buildSettingsPayload(projectDir, "project");
    const projAllowlist = projectPayload.keys.find((k) => k.key === "dangerous_command_allowlist");
    assert.ok(projAllowlist);
    assert.equal((projAllowlist.stored as string[]).length, 10);
    assert.equal(projAllowlist.source, "P");
  });

  it("groups real schema keys into sidebar categories preserving tail LSP category", () => {
    const payload = buildSettingsPayload(projectDir, "project");
    const categories = buildSettingsCategories(payload.keys);
    assert.ok(categories.length >= 18);
    assert.equal(categories[0].name, "Git");
    assert.equal(categories[categories.length - 1].name, "LSP");
  });

  it("filters real schema keys across all categories when searching for lsp", () => {
    const payload = buildSettingsPayload(projectDir, "project");
    const matches = filterSettingsKeys(payload.keys, "lsp");
    const keys = matches.map((m) => m.key);
    assert.ok(keys.includes("lsp_enabled"));
    assert.ok(keys.includes("lsp_servers"));
    assert.equal(matches.find((m) => m.key === "lsp_enabled")?.group, "LSP");
    assert.equal(matches.find((m) => m.key === "lsp_enabled")?.globalOnly, true);
  });

  it("filters real schema keys across all categories when searching for turn_snapshots", () => {
    const payload = buildSettingsPayload(projectDir, "project");
    const matches = filterSettingsKeys(payload.keys, "turn_snapshots");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].key, "turn_snapshots");
    assert.equal(matches[0].group, "Session");
  });

  it("resolves copyable value from draft, stored, effective, then default", () => {
    writeFileSync(join(globalDir, "pi-config-settings.json"), JSON.stringify({ agent_provider: "google" }), "utf8");
    writeFileSync(join(projectDir, ".pi", "pi-config-settings.json"), JSON.stringify({ dco: true }), "utf8");
    clearSettingsCache();

    const payload = buildSettingsPayload(projectDir, "project");
    const dcoKey = payload.keys.find((k) => k.key === "dco")!;
    const provKey = payload.keys.find((k) => k.key === "agent_provider")!;
    const snapKey = payload.keys.find((k) => k.key === "turn_snapshots")!;

    assert.equal(getCopyableSettingValue(dcoKey, true, "false"), "false");
    assert.equal(getCopyableSettingValue(dcoKey, false), "true");
    assert.equal(getCopyableSettingValue(provKey, false), "google");
    assert.equal(getCopyableSettingValue(snapKey, false), "true");
  });
});

describe("PiDash SettingsPanel parity wiring (#1473)", () => {
  it("renders left category sidebar container in SettingsPanel.tsx", () => {
    const source = readFileSync(
      join(process.cwd(), "extensions/pidash/pidash-ui/src/components/SettingsPanel.tsx"),
      "utf8",
    );
    assert.match(source, /data-testid="settings-category-sidebar"/);
  });

  it("renders cross-category search input in SettingsPanel.tsx", () => {
    const source = readFileSync(
      join(process.cwd(), "extensions/pidash/pidash-ui/src/components/SettingsPanel.tsx"),
      "utf8",
    );
    assert.match(source, /aria-label="Search all settings"/);
  });

  it("renders value Copy button wired to copyTextInBrowser in SettingsPanel.tsx", () => {
    const source = readFileSync(
      join(process.cwd(), "extensions/pidash/pidash-ui/src/components/SettingsPanel.tsx"),
      "utf8",
    );
    assert.match(source, /aria-label=\{`Copy \$\{def\.key\} value`\}/);
    assert.match(source, /copyTextInBrowser/);
  });
});
