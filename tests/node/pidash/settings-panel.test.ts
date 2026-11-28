/**
 * Unit tests for #1473 PiDash SettingsPanel parity: scope isolation,
 * left category sidebar grouping, cross-category search, and Copy button.
 *
 * Run with: npx tsx --test tests/node/pidash/settings-panel.test.ts
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as rootReact from "react";
import { createServer, type ViteDevServer } from "vite";
import * as pidashReact from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { act, createElement } from "../../../extensions/pidash/pidash-ui/node_modules/react/index.js";
import { createRoot, type Root } from "../../../extensions/pidash/pidash-ui/node_modules/react-dom/client.js";
import { buildSettingsPayload } from "../../../extensions/pidash/browser-ops.ts";
import {
  buildSettingsCategories,
  filterSettingsKeys,
  getCopyableSettingValue,
} from "../../../extensions/pidash/pidash-ui/src/lib/settings-edit.ts";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { elements, installReactDomShim } from "./react-dom-shim.mjs";

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

describe("PiDash SettingsPanel global_only parity (#1491)", () => {
  let vite: ViteDevServer;
  let SettingsPanel: any;
  const mounted: Root[] = [];

  before(async () => {
    const rootInternals = (rootReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const pidashInternals = (pidashReact as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    for (const key of ["H", "A", "T"]) {
      Object.defineProperty(rootInternals, key, {
        configurable: true,
        get: () => pidashInternals[key],
        set: (value) => { pidashInternals[key] = value; },
      });
    }
    vite = await createServer({
      root: path.resolve("extensions/pidash/pidash-ui"),
      server: { middlewareMode: true },
      appType: "custom",
    });
    ({ SettingsPanel } = await vite.ssrLoadModule("/src/components/SettingsPanel.tsx"));
  });

  after(() => vite.close());

  afterEach(async () => {
    while (mounted.length) await act(async () => mounted.pop()!.unmount());
  });

  function samplePayload(scope: "project" | "global") {
    return {
      type: "settings-data",
      scope,
      settingsPath: scope === "project" ? "/repo/.pi/pi-config-settings.json" : "/home/.pi/pi-config-settings.json",
      keys: [
        {
          key: "lsp_enabled",
          type: "bool",
          default: false,
          effective: false,
          source: "D",
          description: "Enable opt-in LSP diagnostics",
          group: "LSP",
          globalOnly: true,
        },
        {
          key: "lsp_servers",
          type: "lsp_servers",
          default: {},
          effective: {},
          source: "D",
          description: "Per-server LSP overrides",
          group: "LSP",
          globalOnly: true,
        },
      ],
    };
  }

  async function mountSettingsPanel() {
    const { container } = installReactDomShim();
    const sent: Array<{ command: string; extra?: Record<string, unknown> }> = [];
    let listener: ((ev: any) => void) | null = null;
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(SettingsPanel, {
          cwd: "/repo",
          sendCmd: (command: string, extra?: Record<string, unknown>) => sent.push({ command, extra }),
          onMessage: (handler: (ev: any) => void) => {
            listener = handler;
            return () => { listener = null; };
          },
          notify: () => {},
        }),
      );
    });
    const emit = async (ev: any) => act(async () => { listener?.(ev); });
    await emit(samplePayload("project"));
    return { container, sent, emit };
  }

  it("marks global_only rows as blocked on the Project tab", async () => {
    const view = await mountSettingsPanel();
    const blockedRows = elements(view.container, "div").filter(
      (el) => el.getAttribute("data-global-only-blocked") === "true",
    );
    assert.equal(blockedRows.length, 2);
    assert.match(blockedRows[0].textContent, /global-only/);
  });

  it("shows inline warning when clicking a global_only bool control on the Project tab", async () => {
    const view = await mountSettingsPanel();
    const toggleBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "disabled");
    assert.ok(toggleBtn);

    await act(async () => {
      toggleBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const warning = elements(view.container, "div").find(
      (el) => el.getAttribute("data-testid") === "global-only-warning-lsp_enabled",
    );
    assert.ok(warning);
    assert.match(warning!.textContent, /Global-only setting — switch to Global scope to edit/);
    assert.equal(view.sent.filter((c) => c.command === "settings-set").length, 0);
  });

  it("shows inline warning when interacting with a global_only text input on the Project tab", async () => {
    const view = await mountSettingsPanel();
    const textInput = elements(view.container, "input").find(
      (el) => el.getAttribute("aria-disabled") === "true",
    );
    assert.ok(textInput);

    await act(async () => {
      textInput!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const warning = elements(view.container, "div").find(
      (el) => el.getAttribute("data-testid") === "global-only-warning-lsp_servers",
    );
    assert.ok(warning);
    assert.match(warning!.textContent, /Global-only setting — switch to Global scope to edit/);
  });

  it("switches to Global scope from the inline global_only warning link", async () => {
    const view = await mountSettingsPanel();
    const toggleBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "disabled");
    assert.ok(toggleBtn);
    await act(async () => {
      toggleBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const switchBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "Switch to Global");
    assert.ok(switchBtn);
    await act(async () => {
      switchBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    assert.equal(view.sent.at(-1)?.command, "settings-get");
    assert.equal(view.sent.at(-1)?.extra?.scope, "global");

    await view.emit(samplePayload("global"));
    const blockedRows = elements(view.container, "div").filter(
      (el) => el.getAttribute("data-global-only-blocked") === "true",
    );
    assert.equal(blockedRows.length, 0);
  });

  async function withPidashDebugLogs(fn: (logs: () => Array<{ name: string; level: string; msg: string }>) => Promise<void>) {
    const state = globalThis as Record<string, unknown>;
    const prevDebug = state.__PIDASH_DEBUG;
    const prevLogs = state.__pidashUiLogs;
    state.__PIDASH_DEBUG = true;
    state.__pidashUiLogs = [];
    try {
      await fn(() => (state.__pidashUiLogs as Array<{ name: string; level: string; msg: string }>) ?? []);
    } finally {
      if (prevDebug === undefined) delete state.__PIDASH_DEBUG;
      else state.__PIDASH_DEBUG = prevDebug;
      if (prevLogs === undefined) delete state.__pidashUiLogs;
      else state.__pidashUiLogs = prevLogs;
    }
  }

  it("logs debug event when clicking a blocked global_only bool control", async () => {
    await withPidashDebugLogs(async (getLogs) => {
      const view = await mountSettingsPanel();
      const toggleBtn = elements(view.container, "button").find((b) => b.textContent.trim() === "disabled");
      assert.ok(toggleBtn);
      await act(async () => {
        toggleBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      assert.ok(
        getLogs().some(
          (e) =>
            e.name === "SettingsPanel" &&
            e.level === "debug" &&
            e.msg.includes("global_only bool blocked in project scope") &&
            e.msg.includes("lsp_enabled"),
        ),
      );
    });
  });

  it("logs debug event when clicking a blocked global_only input", async () => {
    await withPidashDebugLogs(async (getLogs) => {
      const view = await mountSettingsPanel();
      const textInput = elements(view.container, "input").find((el) => el.getAttribute("aria-disabled") === "true");
      assert.ok(textInput);
      await act(async () => {
        textInput!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      assert.ok(
        getLogs().some(
          (e) =>
            e.name === "SettingsPanel" &&
            e.level === "debug" &&
            e.msg.includes("global_only input clicked in project scope") &&
            e.msg.includes("lsp_servers"),
        ),
      );
    });
  });

  it("logs debug event when clicking a blocked global_only row container", async () => {
    await withPidashDebugLogs(async (getLogs) => {
      const view = await mountSettingsPanel();
      const blockedRow = elements(view.container, "div").find(
        (el) => el.getAttribute("data-global-only-blocked") === "true",
      );
      assert.ok(blockedRow);
      await act(async () => {
        blockedRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      assert.ok(
        getLogs().some(
          (e) =>
            e.name === "SettingsPanel" &&
            e.level === "debug" &&
            e.msg.includes("global_only setting row clicked in project scope") &&
            e.msg.includes("lsp_enabled"),
        ),
      );
    });
  });

  it("logs debug event on blocked keydown in a global_only input", async () => {
    await withPidashDebugLogs(async (getLogs) => {
      const view = await mountSettingsPanel();
      const textInput = elements(view.container, "input").find((el) => el.getAttribute("aria-disabled") === "true");
      assert.ok(textInput);
      await act(async () => {
        textInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      });
      assert.ok(
        getLogs().some(
          (e) =>
            e.name === "SettingsPanel" &&
            e.level === "debug" &&
            e.msg.includes("global_only input keydown blocked in project scope") &&
            e.msg.includes("lsp_servers"),
        ),
      );
    });
  });
});
