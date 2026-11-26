/**
 * coms-registry.ts — Unified peer registry, supervision inventory, and socket liveness module.
 *
 * Replaces the 3 divergent registry/liveness implementations previously split across
 * `coms-wrapper.ts`, `coms-p2p.ts`, `coms-shared.ts`, and `probe-socket.ts`.
 *
 * Instantiable per `comsDir` with zero module-level mutable state so production sessions
 * and tests can operate on isolated registry roots concurrently.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getSetting } from "../orchestrator/project-settings.js";
import { createLogger } from "../shared/logger.js";
import { isFreshHeartbeat, type RegistryRow } from "./coms-peers.js";
import type { PeerWorkloadCounts } from "./coms-workload.js";

const log = createLogger("coms");

const PROBE_CONCURRENCY = 10;
const STARTUP_PING_TIMEOUT_MS = 500;

export type ProbeVerdict = "in_use" | "stale";

export interface RegistryEntry {
	/** Entry point that activated coms: `tool`, `slash`, `cli` (or legacy `user`/`agent`). */
	origin?: string | null;
	coms_session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	/** Informational only — not used alone for liveness checks (socket existence + heartbeat/probe used). */
	pid: number;
	endpoint: string;
	cwd: string;
	started_at: string;
	explicit: boolean;
	version: number;
	// Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
	// Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
	context_used_pct?: number;
	queue_depth?: number;
	/** #924 §3: peer is processing a peer inbound (heartbeat-refreshed). */
	busy?: boolean;
	heartbeat_at?: string;
	pi_session_id?: string;
	/** #1080: exact TaskStore file path this peer reads, or null when peer task persistence is disabled/unavailable. */
	task_store_path?: string | null;
	/** #1083: active-only workload counted by the peer itself; absent on older entries. */
	workload?: PeerWorkloadCounts | null;
}

/** Resolve the effective COMS root directory for `cwd` via project settings, falling back to `~/.pi/coms`. */
export function resolveComsDir(cwd = process.cwd()): string {
	try {
		const configured = getSetting(cwd, "coms_dir");
		if (typeof configured === "string" && configured.trim()) return configured;
	} catch {
		/* fall back to default */
	}
	return path.join(os.homedir(), ".pi", "coms");
}

/**
 * Probe a Unix socket / named-pipe endpoint to determine if it is in use or stale.
 * Returns `"in_use"` if a connection succeeds or on transient errors (`EMFILE`, `EACCES`, etc.)
 * to avoid false pruning; returns `"stale"` on `ECONNREFUSED`, `ENOENT`, or timeout.
 */
export function probeStaleSocket(
	endpoint: string,
	name?: string,
	cwd = process.cwd(),
): Promise<ProbeVerdict> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: ProbeVerdict) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(verdict);
		};
		const timeoutMs = getSetting(cwd, "coms_probe_timeout_ms");
		const timer = setTimeout(() => finish("stale"), timeoutMs);
		log.debug("probe_stale", name ?? endpoint, "timeout_ms", timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		sock.once("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err && (err.code === "ECONNREFUSED" || err.code === "ENOENT")) {
				finish("stale");
			} else {
				// Transient errors (EMFILE, EACCES, etc.) — treat as live to avoid false pruning
				finish("in_use");
			}
		});
	});
}

/**
 * Strict liveness probe — returns `true` only on an actual successful connect.
 * Unlike `probeStaleSocket`, treats ANY error as dead (safe for duplicate-name rejection
 * and stale card eviction where false positives would block startup).
 */
export function probeAlive(endpoint: string, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (alive: boolean) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(alive);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish(true);
		});
		sock.once("error", () => {
			clearTimeout(timer);
			finish(false);
		});
	});
}

/**
 * #1083: the registry's `workload` is reported by the peer, so a malformed or absent value
 * means `unknown` (`null`) rather than a zero count.
 */
export function parseRegistryWorkload(value: unknown): PeerWorkloadCounts | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const valid = (["agents", "tasks", "crons"] as const).every(
		(key) => typeof v[key] === "number" && Number.isFinite(v[key]) && (v[key] as number) >= 0,
	);
	if (!valid) return null;
	return { agents: v.agents as number, tasks: v.tasks as number, crons: v.crons as number };
}

/**
 * Synchronous liveness check for inventory rows (`/coms list`, `coms_peers`, completions, kill planning).
 * Checks heartbeat freshness first (guards against PID reuse), socket existence on POSIX, then `process.kill(pid, 0)`.
 */
export function isRegistryRowAlive(
	row: RegistryRow,
	now = Date.now(),
	platform: NodeJS.Platform = process.platform,
): boolean {
	// Heartbeat first: a reused pid would otherwise make a dead peer look alive. The FIRST
	// registry write has no heartbeat yet, so a just-spawned peer falls back to its start time
	// instead of vanishing for a keepalive interval.
	const fresh = isFreshHeartbeat(row.heartbeatAt, now) ||
		(!row.heartbeatAt && isFreshHeartbeat(row.startedAt, now));
	if (!fresh) return false;
	// On Windows the endpoint is a named pipe, which fs.existsSync cannot see.
	if (platform !== "win32" && row.endpoint && !fs.existsSync(row.endpoint)) return false;
	if (!row.pid) return true; // no pid claim: socket + heartbeat decided
	try {
		process.kill(row.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Probe a `.ping` endpoint during startup pruning; returns `true` if the registry file should be unlinked. */
function probePingForStartupPrune(pingEndpoint: string, timeoutMs = STARTUP_PING_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.createConnection(pingEndpoint);
		let settled = false;
		const finish = (shouldUnlink: boolean) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(shouldUnlink);
		};
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => finish(false)); // alive
		sock.once("error", (err: NodeJS.ErrnoException) => {
			// Only prune registry on definitive dead signals.
			// Never delete socket files — that's destructive and irreversible,
			// killing live peers whose ping worker may have crashed while main server is alive.
			finish(err?.code === "ECONNREFUSED" || err?.code === "ENOENT");
		});
		sock.once("timeout", () => {
			// Timeout means peer may be busy — remove registry entry only, NOT the socket file.
			// The peer's keepalive can self-heal the registry, while a deleted socket kills connectivity.
			finish(true);
		});
	});
}

export class ComsRegistry {
	readonly comsDir: string;
	private startupPruned = false;

	constructor(comsDir: string) {
		this.comsDir = comsDir;
	}

	static forCwd(cwd = process.cwd()): ComsRegistry {
		return new ComsRegistry(resolveComsDir(cwd));
	}

	projectsDir(): string {
		return path.join(this.comsDir, "projects");
	}

	socketsDir(): string {
		return path.join(this.comsDir, "sockets");
	}

	peersDir(): string {
		return path.join(this.comsDir, "peers");
	}

	historyPath(): string {
		return path.join(this.comsDir, "history.jsonl");
	}

	projectAgentsDir(project: string): string {
		return path.join(this.comsDir, "projects", project, "agents");
	}

	registryFilePath(project: string, sessionId: string): string {
		// Guard against path traversal from malformed session_id
		if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
			throw new Error(`Invalid session_id: ${sessionId}`);
		}
		return path.join(this.projectAgentsDir(project), `${sessionId}.json`);
	}

	makeEndpoint(sessionId: string): string {
		if (process.platform === "win32") {
			return `\\\\.\\pipe\\pi-coms-${sessionId}`;
		}
		return path.join(this.socketsDir(), `${sessionId}.sock`);
	}

	ensureProjectDirs(project: string): void {
		fs.mkdirSync(this.projectAgentsDir(project), { recursive: true });
		if (process.platform !== "win32") {
			fs.mkdirSync(this.socketsDir(), { recursive: true });
			try { fs.chmodSync(this.comsDir, 0o700); } catch { /* best-effort */ }
		}
	}

	listProjects(): string[] {
		const root = this.projectsDir();
		try {
			return fs.readdirSync(root).filter((d) => {
				try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
			});
		} catch {
			return [];
		}
	}

	writeEntryAtomic(entry: RegistryEntry, project: string): string {
		const dir = this.projectAgentsDir(project);
		fs.mkdirSync(dir, { recursive: true });
		const final = this.registryFilePath(project, entry.coms_session_id);
		const tmp = `${final}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
		fs.renameSync(tmp, final);
		return final;
	}

	removeEntry(project: string, sessionId: string): void {
		try {
			fs.unlinkSync(this.registryFilePath(project, sessionId));
		} catch {
			// best-effort
		}
	}

	readEntries(project: string): RegistryEntry[] {
		const dir = this.projectAgentsDir(project);
		if (!fs.existsSync(dir)) return [];
		const out: RegistryEntry[] = [];
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			return [];
		}
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			try {
				const raw = fs.readFileSync(path.join(dir, f), "utf-8");
				const parsed = JSON.parse(raw) as RegistryEntry;
				if (parsed && typeof parsed.coms_session_id === "string") {
					out.push(parsed);
				}
			} catch {
				// skip malformed
			}
		}
		return out;
	}

	readAllEntries(): RegistryEntry[] {
		const out: RegistryEntry[] = [];
		for (const project of this.listProjects()) {
			out.push(...this.readEntries(project));
		}
		return out;
	}

	/**
	 * Read PC-wide peer inventory rows across every project in this registry.
	 * Logs unreadable/corrupt JSON files instead of silently hiding them.
	 */
	readRows(): RegistryRow[] {
		const rows: RegistryRow[] = [];
		const root = this.projectsDir();
		let projects: string[] = [];
		try { projects = fs.readdirSync(root); } catch { return rows; }
		for (const project of projects) {
			const agentsDir = this.projectAgentsDir(project);
			let files: string[] = [];
			try { files = fs.readdirSync(agentsDir); } catch { continue; }
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const filePath = path.join(agentsDir, file);
				try {
					const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
					if (!entry || typeof entry.name !== "string") continue;
					rows.push({
						project,
						name: entry.name,
						pid: Number.isInteger(entry.pid) ? entry.pid : null,
						cwd: typeof entry.cwd === "string" ? entry.cwd : "",
						purpose: typeof entry.purpose === "string" ? entry.purpose : "",
						endpoint: typeof entry.endpoint === "string" ? entry.endpoint : "",
						busy: entry.busy === true,
						queueDepth: typeof entry.queue_depth === "number" ? entry.queue_depth : null,
						contextUsedPct: typeof entry.context_used_pct === "number" ? entry.context_used_pct : null,
						startedAt: typeof entry.started_at === "string" ? entry.started_at : null,
						heartbeatAt: typeof entry.heartbeat_at === "string" ? entry.heartbeat_at : null,
						origin: typeof entry.origin === "string" ? entry.origin : null,
						createdBy: null,
						piSessionId: typeof entry.pi_session_id === "string" ? entry.pi_session_id : null,
						// #1083: a peer that reports nothing stays null — never 0.
						workload: parseRegistryWorkload(entry.workload),
					});
				} catch (error: unknown) {
					log.warn("coms_registry_entry_unreadable", {
						file: filePath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		return rows;
	}

	readLiveRows(now = Date.now()): RegistryRow[] {
		return this.readRows().filter((row) => isRegistryRowAlive(row, now));
	}

	/**
	 * Read supervisor records from this registry's `peers/` directory plus any extra dirs
	 * (such as `PI_COMS_DIR/peers` when configured differently).
	 */
	readSupervisionRecords(extraDirs: string[] = []): any[] {
		const dirs = new Set<string>([this.peersDir()]);
		for (const dir of extraDirs) {
			const trimmed = dir.trim();
			if (trimmed) dirs.add(trimmed);
		}
		const records: any[] = [];
		for (const dir of dirs) {
			let files: string[] = [];
			try { files = fs.readdirSync(dir); } catch { continue; }
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const filePath = path.join(dir, file);
				try {
					records.push(JSON.parse(fs.readFileSync(filePath, "utf-8")));
				} catch (error: unknown) {
					log.warn("coms_supervision_record_unreadable", {
						file: filePath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		return records;
	}

	/**
	 * Two-phase dead-entry pruning for one project:
	 * Phase 1: fast synchronous pre-filter (missing endpoint/socket, grace period, timestamp validity).
	 * Phase 2: bounded-concurrency socket probes (max 10 concurrent to avoid EMFILE).
	 */
	async pruneDeadEntries(project: string, cwd = process.cwd()): Promise<RegistryEntry[]> {
		const entries = this.readEntries(project);

		// Phase 1: Sync pre-filter (fast — no network I/O)
		const candidates: RegistryEntry[] = [];
		const youngEntries: RegistryEntry[] = [];
		const graceMs = getSetting(cwd, "coms_entry_grace_period_ms");
		for (const entry of entries) {
			if (!entry.endpoint || typeof entry.endpoint !== "string") {
				this.removeEntry(project, entry.coms_session_id);
				continue;
			}
			// On Windows, endpoints are named pipes — fs.existsSync doesn't apply
			if (process.platform !== "win32" && !fs.existsSync(entry.endpoint)) {
				this.removeEntry(project, entry.coms_session_id);
				continue;
			}
			// Skip entries younger than grace period — recently booted peers get grace period
			const entryAge = Date.now() - new Date(entry.heartbeat_at ?? entry.started_at ?? "").getTime();
			if (!Number.isNaN(entryAge) && entryAge < graceMs) {
				log.debug("prune_skip_grace", entry.name, "age_ms", entryAge);
				youngEntries.push(entry);
				continue;
			}
			// Check heartbeat/started_at structural validity (malformed = remove, missing = remove).
			// Timestamp staleness is NOT checked here — stale entries go to Phase 2 for socket probing.
			// This prevents false pruning after laptop suspend/resume when all timestamps are stale
			// but peers are still alive.
			const lastSeen = entry.heartbeat_at ?? entry.started_at;
			if (lastSeen) {
				const lastSeenMs = new Date(lastSeen).getTime();
				if (Number.isNaN(lastSeenMs)) {
					this.removeEntry(project, entry.coms_session_id);
					continue;
				}
			} else {
				this.removeEntry(project, entry.coms_session_id);
				continue;
			}
			candidates.push(entry);
		}

		// Phase 2: Parallel socket probes (capped at 10 concurrent to avoid EMFILE)
		if (candidates.length === 0) {
			log.debug("prune_complete", "checked", entries.length);
			return youngEntries;
		}
		const results: ProbeVerdict[] = [];
		for (let start = 0; start < candidates.length; start += PROBE_CONCURRENCY) {
			const batch = candidates.slice(start, start + PROBE_CONCURRENCY);
			const batchResults = await Promise.allSettled(
				batch.map((entry) => probeStaleSocket(entry.endpoint, entry.name, cwd)),
			);
			results.push(...batchResults.map((r) => (r.status === "fulfilled" ? r.value : "in_use" as const)));
		}
		const live: RegistryEntry[] = [];
		for (let i = 0; i < candidates.length; i++) {
			if (results[i] === "stale") {
				const entry = candidates[i]!;
				this.removeEntry(project, entry.coms_session_id);
				// Do NOT delete socket files — they belong to the peer process.
			} else {
				live.push(candidates[i]!);
			}
		}
		log.debug("prune_complete", "checked", entries.length);
		return [...live, ...youngEntries];
	}

	async pruneDeadEntriesAllProjects(cwd = process.cwd()): Promise<RegistryEntry[]> {
		const out: RegistryEntry[] = [];
		for (const project of this.listProjects()) {
			out.push(...await this.pruneDeadEntries(project, cwd));
		}
		return out;
	}

	/**
	 * Startup registry & orphan-socket cleanup (replaces module-global `pruneStaleRegistry`).
	 * Removes entries with missing pid/endpoint/socket or dead `.ping` socket, and removes
	 * orphan `.sock` / `.sock.ping` files that have no matching registry entry after a fresh rescan.
	 */
	async pruneStaleStartup(): Promise<void> {
		const projectsDir = this.projectsDir();
		if (!fs.existsSync(projectsDir)) return;
		let dirs: string[];
		try { dirs = fs.readdirSync(projectsDir); } catch { return; }

		const allEndpoints = new Set<string>();
		const probeTasks: Array<Promise<void>> = [];

		for (const proj of dirs) {
			try {
				const projDir = path.join(projectsDir, proj);
				if (!fs.lstatSync(projDir).isDirectory()) continue;
				const agentsDir = path.join(projDir, "agents");
				if (!fs.existsSync(agentsDir)) continue;
				for (const file of fs.readdirSync(agentsDir)) {
					if (!file.endsWith(".json")) continue;
					const fp = path.join(agentsDir, file);
					try {
						const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
						if (typeof data?.pid !== "number") {
							try { fs.unlinkSync(fp); } catch { /* ignore */ }
							continue;
						}
						const endpoint = data?.endpoint;
						if (typeof endpoint !== "string" || !endpoint) {
							try { fs.unlinkSync(fp); } catch { /* ignore */ }
							continue;
						}
						if (process.platform !== "win32" && !fs.existsSync(endpoint)) {
							try { fs.unlinkSync(fp); } catch { /* ignore */ }
							continue;
						}
						allEndpoints.add(endpoint);
						const pingEndpoint = `${endpoint}.ping`;
						probeTasks.push(
							probePingForStartupPrune(pingEndpoint).then((shouldUnlink) => {
								if (shouldUnlink) {
									try { fs.unlinkSync(fp); } catch { /* ignore */ }
								}
							}),
						);
					} catch (e: unknown) {
						const code = (e as NodeJS.ErrnoException)?.code;
						if (code === "ESRCH" || e instanceof SyntaxError) {
							try { fs.unlinkSync(fp); } catch { /* ignore */ }
						}
					}
				}
			} catch {
				/* skip unreadable project directory */
			}
		}

		// Cleanup orphan sockets (no matching registry entry)
		const socketsDir = this.socketsDir();
		if (fs.existsSync(socketsDir)) {
			try {
				const orphanCandidates: Array<{ sp: string; parentEndpoint: string }> = [];
				for (const sf of fs.readdirSync(socketsDir)) {
					if (!sf.endsWith(".sock") && !sf.endsWith(".sock.ping")) continue;
					const sp = path.join(socketsDir, sf);
					const parentEndpoint = sf.endsWith(".sock.ping") ? sp.slice(0, -5) : sp;
					if (!allEndpoints.has(parentEndpoint)) {
						orphanCandidates.push({ sp, parentEndpoint });
					}
				}
				if (orphanCandidates.length > 0) {
					// One fresh registry scan across all orphan candidates so concurrently registered peers survive
					// without rescanning once per orphan socket.
					let currentDirs: string[] = [];
					try { currentDirs = fs.readdirSync(projectsDir); } catch { /* ignore */ }
					for (const p of currentDirs) {
						try {
							const pd = path.join(projectsDir, p);
							if (!fs.lstatSync(pd).isDirectory()) continue;
							const ad = path.join(pd, "agents");
							if (!fs.existsSync(ad)) continue;
							for (const f of fs.readdirSync(ad)) {
								if (!f.endsWith(".json")) continue;
								try {
									const d = JSON.parse(fs.readFileSync(path.join(ad, f), "utf-8"));
									if (typeof d?.endpoint === "string" && d.endpoint) {
										allEndpoints.add(d.endpoint);
									}
								} catch { /* ignore */ }
							}
						} catch { /* ignore */ }
					}
					for (const { sp, parentEndpoint } of orphanCandidates) {
						if (!allEndpoints.has(parentEndpoint)) {
							try { fs.unlinkSync(sp); } catch { /* ignore */ }
						}
					}
				}
			} catch {
				/* ignore */
			}
		}

		if (probeTasks.length > 0) {
			await Promise.allSettled(probeTasks);
		}
		log.debug("startup_prune_complete", { comsDir: this.comsDir, probed: probeTasks.length });
	}

	/**
	 * Schedule startup stale registry pruning non-blockingly, at most once per `ComsRegistry` instance.
	 */
	scheduleStartupPrune(): void {
		if (this.startupPruned) return;
		this.startupPruned = true;
		setImmediate(() => {
			void this.pruneStaleStartup().catch((err: unknown) => {
				log.warn("startup_prune_failed", {
					comsDir: this.comsDir,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		});
	}
}
