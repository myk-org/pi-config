import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import installProviders from "../../../extensions/providers/index.js";
import { resetProvidersInitialized } from "../../../extensions/providers/initialized-guard.js";

type DiscoverySummarySetup = {
  handlers: Map<string, (event: any, ctx: any) => void>;
  appended: Array<{ type: string; data: { summary: string } }>;
  renderers: Array<{ type: string; render: any }>;
};

async function installDiscoverySummaryExtension(): Promise<DiscoverySummarySetup> {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const appended: Array<{ type: string; data: { summary: string } }> = [];
  const renderers: Array<{ type: string; render: any }> = [];
  await installProviders({
    on: (event: string, handler: any) => handlers.set(event, handler),
    appendEntry: (type: string, data: { summary: string }) => appended.push({ type, data }),
    registerEntryRenderer: (type: string, render: any) => renderers.push({ type, render }),
    setThinkingLevel: () => {},
    getThinkingLevel: () => "off",
    setModel: () => {},
  } as any, { providerSummaryParts: ["cli-codex (2)"] });
  return { handlers, appended, renderers };
}

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

  it("persists a summary when the session starts at startup", async () => {
    const { handlers, appended } = await installDiscoverySummaryExtension();

    handlers.get("session_start")!({ reason: "startup" }, { modelRegistry: {} });

    assert.deepEqual(appended, [
      { type: "provider-discovery-summary", data: { summary: "Providers: cli-codex (2)" } },
    ]);
  });

  it("persists a summary when a new session starts", async () => {
    const { handlers, appended } = await installDiscoverySummaryExtension();

    handlers.get("session_start")!({ reason: "new" }, { modelRegistry: {} });

    assert.deepEqual(appended, [
      { type: "provider-discovery-summary", data: { summary: "Providers: cli-codex (2)" } },
    ]);
  });

  it("does not append a summary for a non-start session reason", async () => {
    const { handlers, appended } = await installDiscoverySummaryExtension();

    handlers.get("session_start")!({ reason: "resume" }, { modelRegistry: {} });

    assert.deepEqual(appended, []);
  });

  it("registers a renderer that renders and invalidates persisted summaries", async () => {
    const { renderers } = await installDiscoverySummaryExtension();

    assert.equal(renderers.length, 1);
    assert.equal(renderers[0].type, "provider-discovery-summary");
    const component = renderers[0].render(
      { data: { summary: "Providers: cli-codex (2)" } },
      {},
      { fg: (_color: string, text: string) => text },
    );
    assert.deepEqual(component.render(80), ["Providers: cli-codex (2)"]);
    assert.doesNotThrow(() => component.invalidate());
  });
});
