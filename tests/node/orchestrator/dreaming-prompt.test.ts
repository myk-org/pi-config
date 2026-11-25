import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildDreamPrompt } from "../../../extensions/orchestrator/dreaming.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const topicsDir = "/repo/.pi/memory/topics";
const prompt = buildDreamPrompt(undefined, topicsDir);

describe("dream prompt", () => {
  it("narrows [done] to non-derivable outcome knowledge", () => {
    assert.ok(prompt.includes("ONLY non-derivable outcome knowledge"));
    assert.ok(prompt.includes("NEVER store a PR/issue number list"));
  });

  it("stops extracting merged-PR lists", () => {
    assert.ok(!prompt.includes("Completed features/PRs merged"));
  });

  it("prunes git/GitHub/Jira history from topic files", () => {
    assert.ok(prompt.includes("Remove entries that restate git/GitHub/Jira history"));
  });

  it("keeps the pinned and enforced guards verbatim", () => {
    assert.ok(prompt.includes("NEVER remove or modify entries marked with *(pinned)*"));
    assert.ok(prompt.includes("NEVER remove or modify entries marked with *(enforced)*"));
  });

  it("interpolates the topics dir and the session file", () => {
    assert.ok(prompt.includes(`Topics directory: ${topicsDir}`));
    assert.ok(prompt.includes(`Read all existing topic files in ${topicsDir}/`));
    assert.ok(prompt.includes("Session file: none"));
    assert.ok(buildDreamPrompt("/sessions/abc.jsonl", topicsDir).includes(
      "Session file: /sessions/abc.jsonl",
    ));
  });

  it("states each shared constraint once under the top-level Rules block (#1268)", () => {
    assert.ok(prompt.includes("Rules (apply to all steps):"));
    const sharedConstraints = [
      "NEVER remove or modify entries marked with *(pinned)*",
      "NEVER remove or modify entries marked with *(enforced)*",
      "NEVER store a PR/issue number list",
      "NEVER write rules/ or .pi/rules/",
      "skill-maintenance: auto",
    ];
    for (const rule of sharedConstraints) {
      assert.equal(
        prompt.split(rule).length - 1,
        1,
        `expected shared constraint to appear once: ${rule}`,
      );
    }
  });

  it("instructs dreaming to write trigger-keyword-rich skill descriptions (#1383)", () => {
    assert.ok(prompt.includes("concrete trigger keywords/phrases"));
    assert.ok(prompt.includes("only loads name+description at startup"));
  });
});

describe("shipped skills frontmatter (#1383)", () => {
  it("gives every shipped skill a matching name and a trigger-bearing description within 1024 chars", () => {
    const skillsDir = path.join(REPO_ROOT, "skills");
    const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    assert.ok(dirs.length > 0, "expected shipped skills under skills/");

    for (const dir of dirs) {
      const skillPath = path.join(skillsDir, dir.name, "SKILL.md");
      const content = fs.readFileSync(skillPath, "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fmMatch, `${dir.name}/SKILL.md must start with YAML frontmatter`);
      const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
      assert.equal(nameMatch?.[1]?.trim(), dir.name, `${dir.name}/SKILL.md name must match directory`);
      const desc = (descMatch?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
      assert.ok(desc.length > 0 && desc.length <= 1024, `${dir.name}/SKILL.md description must be 1..1024 chars`);
      assert.match(desc, /\bUse when\b/i, `${dir.name}/SKILL.md description must include an explicit "Use when" trigger clause`);
    }
  });
});
