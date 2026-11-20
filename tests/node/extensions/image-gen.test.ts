/**
 * image-gen tool guard-path tests (Qodo PR #954: changed public function
 * `createImageGenTool` — now typed `ToolDefinition<typeof imageGenSchema>` —
 * has no test coverage for its observable error returns).
 *
 * Covers the three pre-flight guards of execute(): unset image model,
 * non-image model id, and missing API key. The Gemini API happy path is not
 * exercised (no network in tests).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";

import { join } from "node:path";
import { createImageGenTool } from "../../../extensions/image-gen/image-gen.js";
import { setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


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
    const cwd = makeTempDir("image-gen-nomodel-");
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
    const cwd = makeTempDir("image-gen-badmodel-");
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
    const cwd = makeTempDir("image-gen-nokey-");
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

  it("tightens tool description and schema descriptions without duplicating enum values (#1193)", () => {
    const tool = createImageGenTool();
    assert.ok(tool.description.length < 100, `expected concise description, got ${tool.description.length} chars`);
    assert.doesNotMatch(tool.description, /GEMINI_API_KEY|pi-config-settings/);
    const props = (tool.parameters as any).properties;
    assert.equal(props.aspect_ratio.description, "Image aspect ratio");
    assert.deepEqual(props.aspect_ratio.enum, ["1:1", "3:4", "4:3", "9:16", "16:9"]);
  });

  it("bounds raw HTML and large JSON error bodies from non-2xx responses to 500 chars (#1193)", async (t) => {
    const cwd = makeTempDir("image-gen-http-err-");
    const globalFile = join(cwd, "global-settings.json");
    writeFileSync(globalFile, JSON.stringify({ image_model: "gemini-2.5-flash-image" }));
    const prevGemini = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key"; // pragma: allowlist secret — synthetic test fixture
    setGlobalSettingsPath(globalFile);

    try {
      // Case 1: 502 HTML error page (> 5 KB)
      const htmlBody = `  <html><body><h1>502 Bad Gateway</h1>${"x".repeat(6000)}</body></html>  `;
      t.mock.method(globalThis, "fetch", async () =>
        new Response(htmlBody, { status: 502, headers: { "content-type": "text/html" } }),
      );
      const htmlText = await runExecute(cwd);
      assert.match(htmlText, /^Error: Gemini image request failed \(502\): <html>/);
      const htmlDetail = htmlText.replace(/^Error: Gemini image request failed \(502\): /, "");
      assert.equal(htmlDetail.length, 500);

      // Case 2: Large JSON error message (> 2 KB)
      t.mock.restoreAll();
      const longJsonMsg = `  ${"E".repeat(2000)}  `;
      t.mock.method(globalThis, "fetch", async () =>
        new Response(JSON.stringify({ error: { message: longJsonMsg } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
      const jsonText = await runExecute(cwd);
      assert.match(jsonText, /^Error: Gemini image request failed \(400\): E+/);
      const jsonDetail = jsonText.replace(/^Error: Gemini image request failed \(400\): /, "");
      assert.equal(jsonDetail.length, 500);
    } finally {
      t.mock.restoreAll();
      setGlobalSettingsPath(null);
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
