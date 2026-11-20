import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

describe("symlink-cli-specialists.sh", () => {
	const scriptPath = join(process.cwd(), "scripts", "symlink-cli-specialists.sh");
	const agentsDir = join(process.cwd(), "agents");

	it("renders {{INCLUDE:...}} reviewer agents without leaving placeholders while symlinking standalone agents", () => {
		const projectDir = makeTempDir("cli-specialists-");
		tempDirs.push(projectDir);

		execFileSync("bash", [scriptPath, agentsDir, projectDir], { encoding: "utf-8" });

		for (const cliDir of [".cursor/agents", ".claude/agents", ".gemini/agents"]) {
			const qualityPath = join(projectDir, cliDir, "code-reviewer-quality.md");
			const qualityText = readFileSync(qualityPath, "utf-8");
			assert.doesNotMatch(qualityText, /\{\{INCLUDE:/);
			assert.match(qualityText, /^---\nname: code-reviewer-quality\n/);
			assert.match(qualityText, /\$PI_REVIEW_BASE_BRANCH/);
			assert.match(qualityText, /Return ONLY a JSON object/);
			assert.match(qualityText, /## Prior Review Cycle/);

			const scopePath = join(projectDir, cliDir, "issue-reviewer-scope.md");
			const scopeText = readFileSync(scopePath, "utf-8");
			assert.doesNotMatch(scopeText, /\{\{INCLUDE:/);
			assert.match(scopeText, /## Base Rules/);
			assert.match(scopeText, /Return ONLY a JSON object/);

			const workerPath = join(projectDir, cliDir, "worker.md");
			assert.equal(lstatSync(workerPath).isSymbolicLink(), true);
		}
	});

	it("updates previously rendered files on re-run without overwriting user-authored regular files", () => {
		const projectDir = makeTempDir("cli-specialists-rerun-");
		tempDirs.push(projectDir);

		const cursorDir = join(projectDir, ".cursor", "agents");
		mkdirSync(cursorDir, { recursive: true });
		const userOverride = join(cursorDir, "code-reviewer-quality.md");
		writeFileSync(userOverride, "# user custom reviewer\n", "utf-8");

		execFileSync("bash", [scriptPath, agentsDir, projectDir], { encoding: "utf-8" });
		assert.equal(readFileSync(userOverride, "utf-8"), "# user custom reviewer\n");

		// Generated file in .claude/agents updates cleanly on re-run
		const claudeSecurity = join(projectDir, ".claude", "agents", "code-reviewer-security.md");
		assert.match(readFileSync(claudeSecurity, "utf-8"), /generated-by: symlink-cli-specialists/);
		execFileSync("bash", [scriptPath, agentsDir, projectDir], { encoding: "utf-8" });
		assert.doesNotMatch(readFileSync(claudeSecurity, "utf-8"), /\{\{INCLUDE:/);
	});
});
