import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import installProviders from "../../../extensions/providers/index.js";
import { resetProvidersInitialized } from "../../../extensions/providers/initialized-guard.js";

describe("CLI/ACPX provider discovery summary (#788)", () => {
  const originalCwd = process.cwd();
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(`${tmpdir()}/provider-discovery-summary-`);
    process.chdir(cwd);
    clearSettingsCache();
    resetProvidersInitialized();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearSettingsCache();
    resetProvidersInitialized();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("persists summaries for initial session reasons", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const appended: Array<{ type: string; data: { summary: string } }> = [];
    const renderers: Array<{ type: string; render: any }> = [];
    const notifications: unknown[][] = [];
    await installProviders({
      on: (event: string, handler: any) => handlers.set(event, handler),
      appendEntry: (type: string, data: { summary: string }) => appended.push({ type, data }),
      registerEntryRenderer: (type: string, render: any) => renderers.push({ type, render }),
      setThinkingLevel: () => {},
      getThinkingLevel: () => "off",
      setModel: () => {},
    } as any, { providerSummaryParts: ["cli-codex (2)"] });

    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart);
    const context = { modelRegistry: {}, ui: { notify: (...args: unknown[]) => notifications.push(args) } };
    sessionStart({ reason: "startup" }, context);
    sessionStart({ reason: "new" }, context);

    assert.deepEqual(appended, [
      { type: "provider-discovery-summary", data: { summary: "Providers: cli-codex (2)" } },
      { type: "provider-discovery-summary", data: { summary: "Providers: cli-codex (2)" } },
    ]);
    assert.deepEqual(notifications, []);
    assert.equal(renderers.length, 1);
    const component = renderers[0].render(
      { data: appended[0].data }, {}, { fg: (_color: string, text: string) => text },
    );
    assert.deepEqual(component.render(80), ["Providers: cli-codex (2)"]);
    assert.doesNotThrow(() => component.invalidate());
  });

  it("does not append a summary for a non-start session reason", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    const appended: unknown[] = [];
    await installProviders({
      on: (event: string, handler: any) => handlers.set(event, handler),
      appendEntry: (...args: unknown[]) => appended.push(args),
      registerEntryRenderer: () => {},
      setThinkingLevel: () => {},
      getThinkingLevel: () => "off",
      setModel: () => {},
    } as any, { providerSummaryParts: ["cli-codex (2)"] });

    handlers.get("session_start")!({ reason: "resume" }, { modelRegistry: {} });
    assert.deepEqual(appended, []);
  });
});
