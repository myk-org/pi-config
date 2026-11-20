/**
 * Agent discovery — extended from pi's subagent example.
 *
 * Discovery sources (in priority order, later overrides earlier):
 * 1. Package-bundled agents (this package's agents/ directory)
 * 2. User agents (~/.pi/agent/agents/)
 * 3. Project agents (.pi/agents/ in cwd or parent dirs)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";

const log = createLogger("agents");

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	provider?: string;
	systemPrompt: string;
	source: "user" | "project" | "package";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface DirAgentsCacheEntry {
	dirMtimeMs: number;
	fileMeta: Map<string, { mtimeMs: number; size: number }>;
	agents: AgentConfig[];
}

const DIR_AGENTS_CACHE_MAX = 32;
const dirAgentsCache = new Map<string, DirAgentsCacheEntry>();

/** Clear cached agent frontmatter reads (tests). */
export function clearAgentsCache(): void {
	dirAgentsCache.clear();
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "package"): AgentConfig[] {
	const cacheKey = `${source}\0${dir}`;
	let dirStat: fs.Stats;
	try {
		dirStat = fs.statSync(dir);
	} catch {
		dirAgentsCache.delete(cacheKey);
		return [];
	}
	if (!dirStat.isDirectory()) {
		dirAgentsCache.delete(cacheKey);
		return [];
	}

	const cached = dirAgentsCache.get(cacheKey);
	if (cached && cached.dirMtimeMs === dirStat.mtimeMs) {
		let valid = true;
		for (const [filePath, meta] of cached.fileMeta) {
			try {
				const st = fs.statSync(filePath);
				if (st.mtimeMs !== meta.mtimeMs || st.size !== meta.size) {
					valid = false;
					break;
				}
			} catch {
				valid = false;
				break;
			}
		}
		if (valid) {
			dirAgentsCache.delete(cacheKey);
			dirAgentsCache.set(cacheKey, cached);
			return cached.agents;
		}
	}

	const agents: AgentConfig[] = [];
	const fileMeta = new Map<string, { mtimeMs: number; size: number }>();
	let complete = true;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		dirAgentsCache.delete(cacheKey);
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			const st = fs.statSync(filePath);
			content = fs.readFileSync(filePath, "utf-8");
			fileMeta.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
		} catch {
			complete = false;
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined,
			provider: typeof frontmatter.provider === "string" ? frontmatter.provider.trim() || undefined : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	if (complete) {
		if (dirAgentsCache.size >= DIR_AGENTS_CACHE_MAX) {
			const oldest = dirAgentsCache.keys().next().value;
			if (oldest !== undefined) dirAgentsCache.delete(oldest);
		}
		dirAgentsCache.set(cacheKey, { dirMtimeMs: dirStat.mtimeMs, fileMeta, agents });
	} else {
		dirAgentsCache.delete(cacheKey);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Get the package's bundled agents directory.
 * This file lives in extensions/orchestrator/agents.ts,
 * and the agents are in ../../agents/ relative to this file.
 */
function getPackageAgentsDir(): string {
	const resolvedPath = path.resolve(MODULE_DIR, "..", "..", "agents");
	log.debug("resolved package agents directory", { path: resolvedPath });
	return resolvedPath;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const packageDir = getPackageAgentsDir();
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Load from all sources
	const packageAgents = loadAgentsFromDir(packageDir, "package");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Merge: package < user < project (later overrides earlier by name)
	const agentMap = new Map<string, AgentConfig>();

	// Package agents are always loaded as the base
	for (const agent of packageAgents) agentMap.set(agent.name, agent);

	if (scope !== "project") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}

	if (scope !== "user" && projectAgentsDir) {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
