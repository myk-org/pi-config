/**
 * Tests for cli-provider command builders and parsers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCliCommand, isCliAgentName } from "../../../extensions/cli-provider/providers.js";
import {
  parseClaudeJson,
  parseCursorStreamJson,
  parseGeminiJson,
} from "../../../extensions/cli-provider/parsers.js";
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

  it("builds claude command with resume", () => {
    const { binary, args } = buildCliCommand({
      agent: "claude",
      model: "claude-sonnet-4-20250514",
      cwd: "/tmp/proj",
      sessionId: "sess-1",
    });
    assert.equal(binary, "claude");
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("sess-1"));
  });

  it("builds cursor command with workspace", () => {
    const { binary, args } = buildCliCommand({
      agent: "cursor",
      model: "gpt-5.4",
      cwd: "/tmp/ws",
    });
    assert.equal(binary, "agent");
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--workspace"));
    assert.ok(args.includes("/tmp/ws"));
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
