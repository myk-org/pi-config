import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { clearAgentsCache, discoverAgents } from "../../../extensions/orchestrator/agents.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];

afterEach(() => {
	clearAgentsCache();
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

function writeAgentFile(dir: string, filename: string, name: string, description: string, body: string) {
	writeFileSync(
		join(dir, filename),
		`---\nname: ${name}\ndescription: ${description}\ntools: read, bash\n---\n\n${body}\n`,
		"utf-8",
	);
}

describe("discoverAgents cache (#1208)", () => {
	it("returns identical configs across repeated calls and invalidates on add, edit, mtime change, and delete", () => {
		const root = makeTempDir("agents-cache-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		const agentFile = join(agentsDir, "custom.md");
		writeAgentFile(agentsDir, "custom.md", "custom-agent", "Initial description", "Initial prompt");

		clearAgentsCache();
		const first = discoverAgents(root, "project");
		const second = discoverAgents(root, "project");
		const firstAgent = first.agents.find((a) => a.name === "custom-agent");
		const secondAgent = second.agents.find((a) => a.name === "custom-agent");
		assert.ok(firstAgent);
		assert.equal(firstAgent.description, "Initial description");
		assert.equal(secondAgent?.systemPrompt, firstAgent.systemPrompt);

		// In-place file modification (updates file mtime + size even if dir mtime stays identical)
		writeAgentFile(agentsDir, "custom.md", "custom-agent", "Updated description", "Updated prompt");
		const future = new Date(Date.now() + 5000);
		utimesSync(agentFile, future, future);

		const third = discoverAgents(root, "project");
		const thirdAgent = third.agents.find((a) => a.name === "custom-agent");
		assert.equal(thirdAgent?.description, "Updated description");
		assert.match(thirdAgent?.systemPrompt ?? "", /Updated prompt/);

		// Adding a new agent file changes directory entries/mtime
		writeAgentFile(agentsDir, "second.md", "second-agent", "Second agent", "Second body");
		const dirFuture = new Date(Date.now() + 10000);
		utimesSync(agentsDir, dirFuture, dirFuture);
		const fourth = discoverAgents(root, "project");
		assert.ok(fourth.agents.some((a) => a.name === "second-agent"));

		// Removing a file invalidates cache
		rmSync(join(agentsDir, "second.md"));
		const dirFuture2 = new Date(Date.now() + 15000);
		utimesSync(agentsDir, dirFuture2, dirFuture2);
		const fifth = discoverAgents(root, "project");
		assert.equal(fifth.agents.some((a) => a.name === "second-agent"), false);
	});

	it("does not cache an incomplete directory when an agent file is unreadable and recovers after chmod", () => {
		if (process.getuid?.() === 0) return;
		const root = makeTempDir("agents-cache-perm-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		const hiddenFile = join(agentsDir, "locked.md");
		writeAgentFile(agentsDir, "locked.md", "locked-agent", "Locked agent", "Locked prompt");
		chmodSync(hiddenFile, 0o000);

		try {
			clearAgentsCache();
			const first = discoverAgents(root, "project");
			assert.equal(first.agents.some((a) => a.name === "locked-agent"), false);

			chmodSync(hiddenFile, 0o644);
			const second = discoverAgents(root, "project");
			assert.equal(second.agents.some((a) => a.name === "locked-agent"), true);
		} finally {
			try { chmodSync(hiddenFile, 0o644); } catch {}
		}
	});
});

describe("agent {{INCLUDE:...}} resolution (#1261)", () => {
	it("resolves _partials includes, ignores _partials during discovery, and invalidates cache when partial changes", () => {
		const root = makeTempDir("agents-include-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		const partialsDir = join(agentsDir, "_partials");
		mkdirSync(partialsDir, { recursive: true });
		writeFileSync(join(partialsDir, "common.md"), "## Shared\n\nRule v1\n", "utf-8");
		writeFileSync(join(agentsDir, "_ignored.md"), "---\nname: ignored\ndescription: ignored\n---\nignored\n", "utf-8");
		writeAgentFile(agentsDir, "reviewer.md", "custom-reviewer", "Custom reviewer", "{{INCLUDE:_partials/common.md}}\n\n## Specific");

		clearAgentsCache();
		const first = discoverAgents(root, "project");
		assert.equal(first.agents.some((a) => a.name === "ignored"), false);
		const rev1 = first.agents.find((a) => a.name === "custom-reviewer");
		assert.ok(rev1);
		assert.match(rev1.systemPrompt, /Rule v1/);
		assert.doesNotMatch(rev1.systemPrompt, /\{\{INCLUDE:/);

		// Edit only the partial file (agent file & agentsDir mtimes unchanged)
		const partialPath = join(partialsDir, "common.md");
		writeFileSync(partialPath, "## Shared\n\nRule v2 updated\n", "utf-8");
		const future = new Date(Date.now() + 5000);
		utimesSync(partialPath, future, future);

		const second = discoverAgents(root, "project");
		const rev2 = second.agents.find((a) => a.name === "custom-reviewer");
		assert.match(rev2?.systemPrompt ?? "", /Rule v2 updated/);
	});

	it("rejects path traversal, absolute paths, and cyclic includes without throwing", () => {
		const root = makeTempDir("agents-include-sec-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		const partialsDir = join(agentsDir, "_partials");
		mkdirSync(partialsDir, { recursive: true });
		writeFileSync(join(root, "secret.md"), "SECRET", "utf-8");
		writeFileSync(join(partialsDir, "a.md"), "{{INCLUDE:_partials/b.md}}", "utf-8");
		writeFileSync(join(partialsDir, "b.md"), "{{INCLUDE:_partials/a.md}}", "utf-8");
		writeAgentFile(
			agentsDir,
			"bad.md",
			"bad-includes",
			"Bad includes",
			"{{INCLUDE:../../secret.md}}\n{{INCLUDE:/etc/passwd}}\n{{INCLUDE:_partials/a.md}}",
		);

		clearAgentsCache();
		const res = discoverAgents(root, "project");
		const agent = res.agents.find((a) => a.name === "bad-includes");
		assert.ok(agent);
		assert.doesNotMatch(agent.systemPrompt, /SECRET/);
		assert.match(agent.systemPrompt, /\{\{INCLUDE:\.\.\/\.\.\/secret\.md\}\}/);
		assert.match(agent.systemPrompt, /\{\{INCLUDE:\/etc\/passwd\}\}/);
	});

	it("resolves all bundled code-reviewer-* and issue-reviewer-* agents with shared partials intact", () => {
		clearAgentsCache();
		const res = discoverAgents(process.cwd(), "both");
		const codeReviewers = [
			"code-reviewer-quality",
			"code-reviewer-guidelines",
			"code-reviewer-security",
			"code-reviewer-docs",
			"code-reviewer-spec",
		];
		for (const name of codeReviewers) {
			const agent = res.agents.find((a) => a.name === name);
			assert.ok(agent, `missing ${name}`);
			assert.doesNotMatch(agent.systemPrompt, /\{\{INCLUDE:/);
			assert.match(agent.systemPrompt, /\$PI_REVIEW_BASE_BRANCH/);
			assert.match(agent.systemPrompt, /\$PI_HAS_PR/);
			assert.match(agent.systemPrompt, /uvx myk-pi-tools@latest pr get-review-history/);
			assert.match(agent.systemPrompt, /## Prior Review Cycle/);
		}
		const issueReviewers = [
			"issue-reviewer-spec",
			"issue-reviewer-feasibility",
			"issue-reviewer-scope",
		];
		for (const name of issueReviewers) {
			const agent = res.agents.find((a) => a.name === name);
			assert.ok(agent, `missing ${name}`);
			assert.doesNotMatch(agent.systemPrompt, /\{\{INCLUDE:/);
			assert.match(agent.systemPrompt, /## Base Rules/);
			assert.match(agent.systemPrompt, /proposed_text/);
		}
	});
});
