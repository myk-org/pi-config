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
});

describe("PiDash SettingsPanel sidebar, search, and copy helpers (#1473)", () => {
  const sampleKeys: any[] = [
    { key: "dco", description: "Auto-inject signoff", type: "bool", default: false, group: "Git", stored: undefined, effective: false, source: "D" },
    { key: "lsp_enabled", description: "Enable LSP diagnostics", type: "bool", default: false, group: "LSP", stored: true, effective: true, source: "P" },
    { key: "lsp_servers", description: "LSP server config", type: "string", default: "", group: "LSP", stored: undefined, effective: "pyright", source: "G" },
    { key: "turn_snapshots", description: "Per-turn snapshots", type: "bool", default: true, group: "Session", stored: undefined, effective: true, source: "D" },
  ];

  it("groups keys into sidebar categories preserving order", () => {
    const categories = buildSettingsCategories(sampleKeys);
    assert.deepEqual(
      categories.map((c) => [c.name, c.keys.length]),
      [
        ["Git", 1],
        ["LSP", 2],
        ["Session", 1],
      ],
    );
  });

  it("filters keys across all categories when searching for lsp", () => {
    const matches = filterSettingsKeys(sampleKeys, "lsp");
    assert.deepEqual(
      matches.map((m) => m.key),
      ["lsp_enabled", "lsp_servers"],
    );
  });

  it("resolves copyable value from draft, stored, effective, then default", () => {
    assert.equal(getCopyableSettingValue(sampleKeys[0], true, "true"), "true");
    assert.equal(getCopyableSettingValue(sampleKeys[1], false), "true");
    assert.equal(getCopyableSettingValue(sampleKeys[2], false), "pyright");
    assert.equal(getCopyableSettingValue(sampleKeys[3], false), "true");
  });

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
