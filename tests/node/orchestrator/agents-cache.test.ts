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
