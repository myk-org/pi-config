import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { clearAgentsCache, discoverAgentByName, discoverAgents } from "../../../extensions/orchestrator/agents.js";
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
	it("expands {{INCLUDE:_partials/...}} directives in loaded agent prompts", () => {
		const root = makeTempDir("agents-include-resolve-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		const partialsDir = join(agentsDir, "_partials");
		mkdirSync(partialsDir, { recursive: true });
		writeFileSync(join(partialsDir, "common.md"), "## Shared\n\nRule v1\n", "utf-8");
		writeAgentFile(agentsDir, "reviewer.md", "custom-reviewer", "Custom reviewer", "{{INCLUDE:_partials/common.md}}\n\n## Specific");

		clearAgentsCache();
		const res = discoverAgents(root, "project");
		const rev = res.agents.find((a) => a.name === "custom-reviewer");
		assert.ok(rev);
		assert.match(rev.systemPrompt, /Rule v1/);
		assert.doesNotMatch(rev.systemPrompt, /\{\{INCLUDE:/);
	});

	it("excludes underscore-prefixed files during agent discovery", () => {
		const root = makeTempDir("agents-include-exclude-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(join(agentsDir, "_partials"), { recursive: true });
		writeFileSync(join(agentsDir, "_partials", "common.md"), "---\nname: partial\ndescription: partial\n---\npartial\n", "utf-8");
		writeFileSync(join(agentsDir, "_ignored.md"), "---\nname: ignored\ndescription: ignored\n---\nignored\n", "utf-8");
		writeAgentFile(agentsDir, "real.md", "real-agent", "Real agent", "Body");

		clearAgentsCache();
		const res = discoverAgents(root, "project");
		assert.equal(res.agents.some((a) => a.name === "ignored"), false);
		assert.equal(res.agents.some((a) => a.name === "partial"), false);
		assert.equal(res.agents.some((a) => a.name === "real-agent"), true);
	});

	it("invalidates cached agent prompt when an included partial file changes", () => {
		const root = makeTempDir("agents-include-cache-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		const partialsDir = join(agentsDir, "_partials");
		mkdirSync(partialsDir, { recursive: true });
		const partialPath = join(partialsDir, "common.md");
		writeFileSync(partialPath, "## Shared\n\nRule v1\n", "utf-8");
		writeAgentFile(agentsDir, "reviewer.md", "custom-reviewer", "Custom reviewer", "{{INCLUDE:_partials/common.md}}");

		clearAgentsCache();
		const first = discoverAgents(root, "project");
		assert.match(first.agents.find((a) => a.name === "custom-reviewer")?.systemPrompt ?? "", /Rule v1/);

		writeFileSync(partialPath, "## Shared\n\nRule v2 updated\n", "utf-8");
		const future = new Date(Date.now() + 5000);
		utimesSync(partialPath, future, future);

		const second = discoverAgents(root, "project");
		assert.match(second.agents.find((a) => a.name === "custom-reviewer")?.systemPrompt ?? "", /Rule v2 updated/);
	});

	it("invalidates cache when a partial symlink is retargeted to a file with identical size and mtime", () => {
		const root = makeTempDir("agents-include-symlink-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		const partialsDir = join(agentsDir, "_partials");
		mkdirSync(partialsDir, { recursive: true });
		const targetA = join(partialsDir, "target-a.md");
		const targetB = join(partialsDir, "target-b.md");
		const fixedTime = new Date(Date.now() - 10_000);
		writeFileSync(targetA, "RULE_ALPHA", "utf-8");
		writeFileSync(targetB, "RULE_BRAVO", "utf-8");
		utimesSync(targetA, fixedTime, fixedTime);
		utimesSync(targetB, fixedTime, fixedTime);
		const linkPath = join(partialsDir, "active.md");
		symlinkSync(targetA, linkPath);
		writeAgentFile(agentsDir, "reviewer.md", "symlink-reviewer", "Symlink reviewer", "{{INCLUDE:_partials/active.md}}");

		clearAgentsCache();
		const first = discoverAgents(root, "project");
		assert.match(first.agents.find((a) => a.name === "symlink-reviewer")?.systemPrompt ?? "", /RULE_ALPHA/);

		rmSync(linkPath);
		symlinkSync(targetB, linkPath);
		const second = discoverAgents(root, "project");
		const secondPrompt = second.agents.find((a) => a.name === "symlink-reviewer")?.systemPrompt ?? "";
		assert.match(secondPrompt, /RULE_BRAVO/);
		assert.doesNotMatch(secondPrompt, /RULE_ALPHA/);
	});

	it("rejects path traversal in {{INCLUDE:...}} without throwing", () => {
		const root = makeTempDir("agents-include-traversal-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(root, "secret.md"), "SECRET", "utf-8");
		writeAgentFile(agentsDir, "bad.md", "bad-traversal", "Bad traversal", "{{INCLUDE:../../secret.md}}");

		clearAgentsCache();
		const res = discoverAgents(root, "project");
		const agent = res.agents.find((a) => a.name === "bad-traversal");
		assert.ok(agent);
		assert.doesNotMatch(agent.systemPrompt, /SECRET/);
		assert.match(agent.systemPrompt, /\{\{INCLUDE:\.\.\/\.\.\/secret\.md\}\}/);
	});

	it("rejects absolute paths in {{INCLUDE:...}} without throwing", () => {
		const root = makeTempDir("agents-include-abs-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, "bad.md", "bad-abs", "Bad absolute path", "{{INCLUDE:/etc/passwd}}");

		clearAgentsCache();
		const res = discoverAgents(root, "project");
		const agent = res.agents.find((a) => a.name === "bad-abs");
		assert.ok(agent);
		assert.match(agent.systemPrompt, /\{\{INCLUDE:\/etc\/passwd\}\}/);
	});

	it("rejects cyclic {{INCLUDE:...}} references without throwing", () => {
		const root = makeTempDir("agents-include-cycle-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		const partialsDir = join(agentsDir, "_partials");
		mkdirSync(partialsDir, { recursive: true });
		writeFileSync(join(partialsDir, "a.md"), "A {{INCLUDE:_partials/b.md}}", "utf-8");
		writeFileSync(join(partialsDir, "b.md"), "B {{INCLUDE:_partials/a.md}}", "utf-8");
		writeAgentFile(agentsDir, "bad.md", "bad-cycle", "Bad cycle", "{{INCLUDE:_partials/a.md}}");

		clearAgentsCache();
		const res = discoverAgents(root, "project");
		const agent = res.agents.find((a) => a.name === "bad-cycle");
		assert.ok(agent);
		assert.match(agent.systemPrompt, /\{\{INCLUDE:_partials\/a\.md\}\}/);
	});

	it("falls back to bundled package _partials when a reviewer override is copied without _partials", () => {
		const root = makeTempDir("agents-include-override-");
		tempDirs.push(root);
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		const bundled = readFileSync(join(process.cwd(), "agents", "code-reviewer-security.md"), "utf-8");
		writeFileSync(join(agentsDir, "code-reviewer-security.md"), bundled, "utf-8");

		clearAgentsCache();
		const res = discoverAgents(root, "both");
		const agent = res.agents.find((a) => a.name === "code-reviewer-security");
		assert.ok(agent);
		assert.equal(agent.source, "project");
		assert.doesNotMatch(agent.systemPrompt, /\{\{INCLUDE:/);
		assert.match(agent.systemPrompt, /\$PI_REVIEW_BASE_BRANCH/);
		assert.match(agent.systemPrompt, /## Prior Review Cycle/);
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
			assert.match(agent.systemPrompt, /CODING_STANDARDS\.md/);
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

describe("package cache & discoverAgentByName (#1292)", () => {
	it("retains process-level package agents cache even after visiting >32 distinct project directories", () => {
		clearAgentsCache();
		const initial = discoverAgents(process.cwd(), "both");
		const initialPkgWorker = initial.agents.find((a) => a.name === "worker" && a.source === "package");
		assert.ok(initialPkgWorker, "expected bundled worker agent");

		// Visit 35 distinct project dirs (exceeding DIR_AGENTS_CACHE_MAX=32)
		for (let i = 0; i < 35; i++) {
			const root = makeTempDir(`agents-lru-${i}-`);
			tempDirs.push(root);
			const dir = join(root, ".pi", "agents");
			mkdirSync(dir, { recursive: true });
			writeAgentFile(dir, "extra.md", `extra-${i}`, "Extra", "Body");
			discoverAgents(root, "both");
		}

		const after = discoverAgents(process.cwd(), "both");
		const afterPkgWorker = after.agents.find((a) => a.name === "worker" && a.source === "package");
		// Exact object identity proves package agents were served from process cache without re-reading disk
		assert.strictEqual(afterPkgWorker, initialPkgWorker);

		clearAgentsCache();
		const reloaded = discoverAgents(process.cwd(), "both");
		const reloadedPkgWorker = reloaded.agents.find((a) => a.name === "worker" && a.source === "package");
		assert.ok(reloadedPkgWorker);
		assert.notStrictEqual(reloadedPkgWorker, initialPkgWorker);
	});

	it("discoverAgentByName prefers project override over package agent", () => {
		const root = makeTempDir("agents-byname-override-");
		tempDirs.push(root);
		const dir = join(root, ".pi", "agents");
		mkdirSync(dir, { recursive: true });
		writeAgentFile(dir, "worker.md", "worker", "Project worker override", "Custom project body");

		clearAgentsCache();
		const override = discoverAgentByName(root, "both", "worker");
		assert.equal(override.agent?.source, "project");
		assert.equal(override.agent?.description, "Project worker override");
		assert.equal(override.projectAgentsDir, dir);

		const pkgOnly = discoverAgentByName(root, "user", "worker");
		assert.equal(pkgOnly.agent?.source, "package");
	});

	it("discoverAgentByName returns undefined for unknown agent names", () => {
		const root = makeTempDir("agents-byname-missing-");
		tempDirs.push(root);
		const dir = join(root, ".pi", "agents");
		mkdirSync(dir, { recursive: true });

		clearAgentsCache();
		const missing = discoverAgentByName(root, "both", "does-not-exist-xyz");
		assert.equal(missing.agent, undefined);
		assert.equal(missing.projectAgentsDir, dir);
	});
});
