/**
 * Socket probe for coms stale peer detection.
 * Extracted for testability — the main coms-p2p module imports this.
 */
import * as net from "node:net";
import { createLogger } from "../shared/logger.js";
import { getSetting } from "../orchestrator/project-settings.js";

const log = createLogger("coms");

/**
 * Probe a Unix socket endpoint to determine if it's in use or stale.
 * Returns "in_use" if a connection succeeds, "stale" if refused/missing/timeout.
 */
export function probeStaleSocket(endpoint: string, name?: string, cwd = process.cwd()): Promise<"in_use" | "stale"> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
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
		sock.once("error", (err: any) => {
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
