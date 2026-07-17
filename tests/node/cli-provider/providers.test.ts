/**
 * Tests for cli-provider command builders, parsers, and CLI-only discovery parsers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCliCommand, isCliAgentName } from "../../../extensions/cli-provider/providers.js";
import {
  parseClaudeJson,
  parseCursorStreamJson,
  parseGeminiJson,
  StreamJsonAccumulator,
} from "../../../extensions/cli-provider/parsers.js";
import {
  discoverCliModelIds,
  modelIdToDisplayName,
  parseAgentListModels,
  parseClaudeBinaryCatalog,
  scanClaudeBinaryCatalog,
  parseGeminiCliVisibleModels,
} from "../../../extensions/cli-provider/discover.js";
import { supportsAsyncLlm } from "../../../extensions/orchestrator/async-capability.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cli-provider providers", () => {
  it("recognizes supported agents", () => {
    assert.equal(isCliAgentName("claude"), true);
    assert.equal(isCliAgentName("gemini"), true);
    assert.equal(isCliAgentName("cursor"), true);
    assert.equal(isCliAgentName("opencode"), false);
  });

  it("builds claude command with resume plus skip-permissions", () => {
    const { binary, args } = buildCliCommand({
      agent: "claude",
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp/proj",
      sessionId: "sess-1",
    });
    assert.equal(binary, "claude");
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--include-partial-messages"));
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("sess-1"));
  });

  it("omits --model for default", () => {
    const { args } = buildCliCommand({
      agent: "claude",
      model: "default",
      cwd: "/tmp/proj",
    });
    assert.equal(args.includes("--model"), false);
  });

  it("builds gemini with skip-trust plus yolo", () => {
    const { binary, args } = buildCliCommand({
      agent: "gemini",
      model: "gemini-2.5-pro",
      cwd: "/tmp/ws",
    });
    assert.equal(binary, "gemini");
    assert.ok(args.includes("--skip-trust"));
    assert.ok(args.includes("--yolo"));
    assert.ok(args.includes("stream-json"));
  });

  it("builds cursor with trust force stream-partial", () => {
    const { binary, args } = buildCliCommand({
      agent: "cursor",
      model: "gpt-5.4",
      cwd: "/tmp/ws",
    });
    assert.equal(binary, "agent");
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--trust"));
    assert.ok(args.includes("--force"));
    assert.ok(args.includes("--stream-partial-output"));
    assert.ok(args.includes("--workspace"));
    assert.ok(args.includes("/tmp/ws"));
  });
});

describe("cli-provider discover", () => {
  it("formats model display names like acpx", () => {
    assert.equal(modelIdToDisplayName("composer-2"), "Composer 2");
    assert.equal(
      modelIdToDisplayName("gpt-5.4[context=272k]"),
      "Gpt 5.4",
    );
  });

  it("returns empty model ids for unknown agents", async () => {
    assert.deepEqual(await discoverCliModelIds("nope"), []);
  });

  it("parses agent --list-models output", () => {
    const models = parseAgentListModels(`Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
gpt-5.4-medium - GPT-5.4 1M

Tip: use --model <id>
`);
    assert.equal(models.length, 3);
    assert.equal(models[0].id, "auto");
    assert.equal(models[0].name, "Auto");
    assert.equal(models[1].id, "composer-2.5");
    assert.equal(models[2].name, "GPT-5.4 1M");
  });

  it("parses claude binary catalog", () => {
    const models = parseClaudeBinaryCatalog(
      `{id:"claude-opus-4-6",family:"opus",display_name:"Opus 4.6"}` +
        `{id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6"}`,
    );
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "claude-opus-4-6");
    assert.equal(models[0].name, "Opus 4.6");
  });

  it("scans claude catalog across chunk boundaries without full-file load", () => {
    const entry =
      `{id:"claude-opus-4-6",family:"opus",display_name:"Opus 4.6"}` +
      `{id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6"}`;
    const chunkSize = 64;
    // Split first entry across the first chunk boundary
    const splitAt = chunkSize - 10;
    const pad = Buffer.alloc(splitAt, 0x41); // 'A'
    const body = Buffer.from(entry, "utf-8");
    const dir = mkdtempSync(join(tmpdir(), "cli-claude-scan-"));
    const file = join(dir, "fake-claude.bin");
    try {
      writeFileSync(file, Buffer.concat([pad, body]));
      const models = scanClaudeBinaryCatalog(file, {
        chunkSize,
        overlap: 48,
      });
      assert.equal(models.length, 2);
      assert.equal(models[0].id, "claude-opus-4-6");
      assert.equal(models[1].id, "claude-sonnet-4-6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses gemini CLI isVisible models", () => {
    const models = parseGeminiCliVisibleModels(`
      "gemini-2.5-pro": {
        tier: "pro",
        isVisible: true,
        features: {}
      },
      "gemini-hidden": {
        isVisible: false
      },
      "gemini-3.5-flash": {
        family: "gemini-3",
        isVisible: true
      },
    `);
    assert.deepEqual(
      models.map((m) => m.id).sort(),
      ["gemini-2.5-pro", "gemini-3.5-flash"],
    );
  });
});

describe("cli-provider parsers", () => {
  it("parses claude json", () => {
    const r = parseClaudeJson(
      JSON.stringify({ result: "hello", session_id: "abc" }),
    );
    assert.equal(r.text, "hello");
    assert.equal(r.sessionId, "abc");
  });

  it("parses gemini json", () => {
    const r = parseGeminiJson(
      JSON.stringify({ response: "hi", sessionId: "g1" }),
    );
    assert.equal(r.text, "hi");
    assert.equal(r.sessionId, "g1");
  });

  it("parses cursor stream-json", () => {
    const stdout = [
      JSON.stringify({ type: "text", text: "Hel" }),
      JSON.stringify({ type: "text", text: "lo", session_id: "c1" }),
    ].join("\n");
    const r = parseCursorStreamJson(stdout);
    assert.equal(r.text, "Hello");
    assert.equal(r.sessionId, "c1");
  });

  it("streams cursor partials without duplicating full snapshots", () => {
    const acc = new StreamJsonAccumulator();
    const deltas: string[] = [];
    for (const ev of [
      { type: "assistant", message: { content: [{ type: "text", text: "STREAM" }] }, session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "_OK" }] }, session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "STREAM_OK" }] }, session_id: "s1" },
      { type: "result", result: "STREAM_OK", session_id: "s1" },
    ]) {
      for (const out of acc.push(ev)) {
        if (out.kind === "text_delta") deltas.push(out.text);
      }
    }
    assert.equal(acc.text, "STREAM_OK");
    assert.equal(deltas.join(""), "STREAM_OK");
  });

  it("streams gemini message deltas", () => {
    const acc = new StreamJsonAccumulator();
    const deltas: string[] = [];
    for (const ev of [
      { type: "init", session_id: "g1" },
      { type: "message", role: "assistant", content: "LIVE_", delta: true },
      { type: "message", role: "assistant", content: "OK_1", delta: true },
    ]) {
      for (const out of acc.push(ev)) {
        if (out.kind === "text_delta") deltas.push(out.text);
      }
    }
    assert.equal(acc.sessionId, "g1");
    assert.equal(acc.text, "LIVE_OK_1");
    assert.equal(deltas.join(""), "LIVE_OK_1");
  });
});

describe("cli-* supports async LLM", () => {
  it("does not coerce cli providers even when registered", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cli-async-"));
    const globalTmp = mkdtempSync(join(tmpdir(), "cli-async-g-"));
    try {
      setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
      mkdirSync(join(tmp, ".pi"), { recursive: true });
      writeFileSync(
        join(tmp, ".pi", "pi-config-settings.json"),
        JSON.stringify({
          acpx_agents: ["cursor"],
          cli_agents: ["cursor"],
        }),
      );
      clearSettingsCache();
      assert.equal(supportsAsyncLlm("cli-cursor", tmp), true);
      assert.equal(supportsAsyncLlm("acpx-cursor", tmp), false);
    } finally {
      setGlobalSettingsPath(null);
      clearSettingsCache();
      rmSync(tmp, { recursive: true, force: true });
      rmSync(globalTmp, { recursive: true, force: true });
    }
  });
});
