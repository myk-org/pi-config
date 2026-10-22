/**
 * image-gen tool guard-path tests (Qodo PR #954: changed public function
 * `createImageGenTool` — now typed `ToolDefinition<typeof imageGenSchema>` —
 * has no test coverage for its observable error returns).
 *
 * Covers the three pre-flight guards of execute(): unset image model,
 * non-image model id, and missing API key. The Gemini API happy path is not
 * exercised (no network in tests).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageGenTool } from "../../../extensions/image-gen/image-gen.js";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";

describe("image-gen tool guard paths", () => {
  const runExecute = async (cwd: string) => {
    const tool = createImageGenTool();
    const result = await tool.execute(
      "test-call",
      { subject: "a cat" },
      undefined,
      undefined,
      { cwd } as never,
    );
    assert.ok(result && Array.isArray(result.content), "execute returns a content array");
    const text = result.content.map((c: { type: string; text?: string }) =>
      c.type === "text" ? (c.text ?? "") : "").join("");
    return text;
  };

  it("returns a setup error when image_model is unset", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "image-gen-nomodel-"));
    try {
      const prevGemini = process.env.GEMINI_API_KEY;
      const prevGoogle = process.env.GOOGLE_API_KEY;
      const prevPi = process.env.PI_IMAGE_MODEL;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.PI_IMAGE_MODEL;
      setGlobalSettingsPath(join(cwd, "absent-global.json"));
      try {
        const text = await runExecute(cwd);
        assert.match(text, /image model is not set/i);
      } finally {
        setGlobalSettingsPath(null);
        if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
        if (prevGoogle !== undefined) process.env.GOOGLE_API_KEY = prevGoogle;
        if (prevPi !== undefined) process.env.PI_IMAGE_MODEL = prevPi;
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an image_model that is not an image-generation model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "image-gen-badmodel-"));
    try {
      const globalFile = join(cwd, "global-settings.json");
      writeFileSync(globalFile, JSON.stringify({ image_model: "gpt-4o" }));
      setGlobalSettingsPath(globalFile);
      try {
        const text = await runExecute(cwd);
        assert.match(text, /not an image-generation model/i);
      } finally {
        setGlobalSettingsPath(null);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns an API-key error when the model is valid but no key is set", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "image-gen-nokey-"));
    try {
      const globalFile = join(cwd, "global-settings.json");
      writeFileSync(globalFile, JSON.stringify({ image_model: "gemini-2.5-flash-image" }));
      const prevGemini = process.env.GEMINI_API_KEY;
      const prevGoogle = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      setGlobalSettingsPath(globalFile);
      try {
        const text = await runExecute(cwd);
        assert.match(text, /No API key found/i);
      } finally {
        setGlobalSettingsPath(null);
        if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
        if (prevGoogle !== undefined) process.env.GOOGLE_API_KEY = prevGoogle;
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
