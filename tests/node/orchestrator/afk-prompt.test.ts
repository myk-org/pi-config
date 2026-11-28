import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { makeTempDir } from "../helpers/temp-dirs.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROMPTS_DIR = resolve(REPO_ROOT, "prompts");
const AFK_PROMPT_PATH = resolve(PROMPTS_DIR, "afk.md");

describe("prompts/afk.md (#1513)", () => {
  it("parses frontmatter description, AFK instructions, and $ARGUMENTS", () => {
    const raw = readFileSync(AFK_PROMPT_PATH, "utf8");
    const { frontmatter, body } = parseFrontmatter<{ description?: string }>(raw);

    assert.equal(
      frontmatter.description,
      "I'm AFK — do not ask me anything and do not stop; list your questions for when I'm back",
    );
    assert.match(body, /Do not call `ask_user`/);
    assert.match(body, /Do not ask me anything in your reply either/);
    assert.match(body, /Keep going with what you were already doing/);
    assert.match(body, /list whatever you needed to ask me/);
    assert.match(body, /\$ARGUMENTS\s*$/);
  });

  it("is discovered cleanly by Pi DefaultResourceLoader", async () => {
    const tmpCwd = makeTempDir("afk-prompt-cwd-");
    const tmpAgentDir = makeTempDir("afk-prompt-agent-");
    const loader = new DefaultResourceLoader({
      cwd: tmpCwd,
      agentDir: tmpAgentDir,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalPromptTemplatePaths: [PROMPTS_DIR],
    });

    await loader.reload();
    const { prompts, diagnostics } = loader.getPrompts();
    const afk = prompts.find((prompt) => prompt.name === "afk");

    assert.deepEqual(diagnostics, []);
    assert.ok(afk, "expected DefaultResourceLoader to discover 'afk'");
    assert.equal(afk.filePath, AFK_PROMPT_PATH);
    assert.equal(
      afk.description,
      "I'm AFK — do not ask me anything and do not stop; list your questions for when I'm back",
    );
    assert.match(afk.content, /\$ARGUMENTS\s*$/);
  });
});
