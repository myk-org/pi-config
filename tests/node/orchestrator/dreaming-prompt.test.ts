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

  it("guides dreaming to write startup-routed, YAML-safe skill descriptions (#1383)", () => {
    assert.match(prompt, /\bUse when\b/i);
    assert.match(prompt, /name\s*\+\s*description|name and description/i);
    assert.match(prompt, /\bMANDATORY\b/);
    assert.match(prompt, /single quotes|double quotes/i);
  });
});

interface ParsedShippedSkill {
  dirName: string;
  frontmatterName: string | undefined;
  rawDescription: string;
  description: string;
}

function loadShippedSkills(): ParsedShippedSkill[] {
  const skillsDir = path.join(REPO_ROOT, "skills");
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  return dirs.map((dir) => {
    const content = fs.readFileSync(path.join(skillsDir, dir.name, "SKILL.md"), "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, `${dir.name}/SKILL.md must start with YAML frontmatter`);
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    const rawDescription = (descMatch?.[1] ?? "").trim();
    const description = rawDescription.replace(/^["']|["']$/g, "");
    return {
      dirName: dir.name,
      frontmatterName: nameMatch?.[1]?.trim(),
      rawDescription,
      description,
    };
  });
}

describe("shipped skills frontmatter (#1383)", () => {
  const shipped = loadShippedSkills();

  it("matches every shipped skill frontmatter name to its directory", () => {
    assert.ok(shipped.length > 0, "expected shipped skills under skills/");
    for (const skill of shipped) {
      assert.equal(skill.frontmatterName, skill.dirName, `${skill.dirName}/SKILL.md name must match directory`);
    }
  });

  it("keeps every shipped skill description within 1 to 1024 chars without unescaped interior double quotes", () => {
    for (const skill of shipped) {
      assert.ok(
        skill.description.length > 0 && skill.description.length <= 1024,
        `${skill.dirName}/SKILL.md description must be 1..1024 chars`,
      );
      if (skill.rawDescription.startsWith('"') && skill.rawDescription.endsWith('"')) {
        const inner = skill.rawDescription.slice(1, -1);
        assert.ok(
          !/(^|[^\\])"/.test(inner),
          `${skill.dirName}/SKILL.md description must not contain unescaped interior double quotes`,
        );
      }
    }
  });

  it("includes a Use when trigger clause in every shipped skill description", () => {
    for (const skill of shipped) {
      assert.match(skill.description, /\bUse when\b/i, `${skill.dirName}/SKILL.md must include a Use when clause`);
    }
  });
});
