import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { makeTempDir } from "../helpers/temp-dirs.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROMPTS_DIR = resolve(REPO_ROOT, "prompts");
const AFK_PROMPT_PATH = resolve(PROMPTS_DIR, "afk.md");
const EXPECTED_DESCRIPTION =
  "I'm AFK — do not ask me anything and do not stop; list your questions for when I'm back";

async function loadRepoPrompts(): Promise<{
  loader: DefaultResourceLoader;
  cwd: string;
  agentDir: string;
}> {
  const cwd = makeTempDir("afk-prompt-cwd-");
  const agentDir = makeTempDir("afk-prompt-agent-");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalPromptTemplatePaths: [PROMPTS_DIR],
  });
  await loader.reload();
  return { loader, cwd, agentDir };
}

describe("prompts/afk.md (#1513)", () => {
  it("declares the expected frontmatter description", () => {
    const raw = readFileSync(AFK_PROMPT_PATH, "utf8");
    const { frontmatter } = parseFrontmatter<{ description?: string }>(raw);

    assert.equal(frontmatter.description, EXPECTED_DESCRIPTION);
  });

  it("instructs the agent to skip ask_user without waiting on routine work", () => {
    const raw = readFileSync(AFK_PROMPT_PATH, "utf8");
    const { body } = parseFrontmatter<{ description?: string }>(raw);

    assert.match(body, /Do not call `ask_user`/);
    assert.match(body, /Do not ask me anything in your reply either/);
    assert.match(body, /Keep going with what you were already doing/);
    assert.match(body, /list whatever you needed to ask me/);
  });

  it("preserves approval gates for destructive or externally visible actions", () => {
    const raw = readFileSync(AFK_PROMPT_PATH, "utf8");
    const { body } = parseFrontmatter<{ description?: string }>(raw);

    assert.match(body, /Never bypass approval gates/i);
    assert.match(body, /destructive or externally visible actions/i);
    assert.match(body, /Defer that gated step/i);
  });

  it("ends with the $ARGUMENTS placeholder", () => {
    const raw = readFileSync(AFK_PROMPT_PATH, "utf8");
    const { body } = parseFrontmatter<{ description?: string }>(raw);

    assert.match(body, /\$ARGUMENTS\s*$/);
  });

  it("is discovered cleanly by Pi DefaultResourceLoader", async () => {
    const { loader } = await loadRepoPrompts();
    const { prompts, diagnostics } = loader.getPrompts();
    const afk = prompts.find((prompt) => prompt.name === "afk");

    assert.deepEqual(diagnostics, []);
    assert.ok(afk, "expected DefaultResourceLoader to discover 'afk'");
    assert.equal(afk.filePath, AFK_PROMPT_PATH);
    assert.equal(afk.description, EXPECTED_DESCRIPTION);
  });

  it("expands /afk arguments through Pi AgentSession", async () => {
    const { loader, cwd, agentDir } = await loadRepoPrompts();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    });

    try {
      await session.followUp("/afk finish PR #1518 checks first");
      const [expanded] = session.getFollowUpMessages();

      assert.ok(expanded, "expected expanded /afk message");
      assert.match(expanded, /Do not call `ask_user`/);
      assert.match(expanded, /finish PR #1518 checks first\s*$/);
      assert.doesNotMatch(expanded, /\$ARGUMENTS/);
    } finally {
      session.dispose();
    }
  });

  it("strips $ARGUMENTS when /afk is invoked without extra text", async () => {
    const { loader, cwd, agentDir } = await loadRepoPrompts();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    });

    try {
      await session.followUp("/afk");
      const [expanded] = session.getFollowUpMessages();

      assert.ok(expanded, "expected expanded /afk message");
      assert.match(expanded, /Do not call `ask_user`/);
      assert.doesNotMatch(expanded, /\$ARGUMENTS/);
    } finally {
      session.dispose();
    }
  });
});
