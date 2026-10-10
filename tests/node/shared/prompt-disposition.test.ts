/**
 * Guards for pi 0.99's per-input disposition contract.
 *
 * pi 0.99 added `disposition` ("handled" | "queued" | "started") to prompt/steer/follow_up
 * RPC replies, and made `AgentSession.prompt()` THROW when input arrives mid-run without
 * `streamingBehavior`. pi-config drives agents in-process, never over pi's RPC mode, so the
 * disposition field is intentionally unused — see contributing/pi-099-disposition-audit.md.
 *
 * These tests lock in *why* the in-process paths are safe. If pi's contract changes again,
 * they fail here instead of breaking the coms queue or async agents in production.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function* tsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) yield* tsFiles(full);
		else if (full.endsWith(".ts")) yield full;
	}
}

/** Blanks out comments (replaced by spaces to keep offsets) so prose about a call is not a call. */
function stripComments(source: string): string {
	const out = source.split("");
	let i = 0;
	while (i < source.length) {
		const two = source.slice(i, i + 2);
		if (two === "//") {
			while (i < source.length && source[i] !== "\n") out[i++] = " ";
		} else if (two === "/*") {
			while (i < source.length && source.slice(i, i + 2) !== "*/") out[i++] = source[i] === "\n" ? "\n" : " ";
			if (i < source.length) { out[i] = out[i + 1] = " "; i += 2; }
		} else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
			const quote = source[i];
			i++;
			while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
			i++;
		} else i++;
	}
	return out.join("");
}

/** Captures the full argument text of a call, honouring nesting. */
function callAt(source: string, openParenIdx: number): string {
	let depth = 0;
	for (let i = openParenIdx; i < source.length; i++) {
		if (source[i] === "(") depth++;
		else if (source[i] === ")" && --depth === 0) return source.slice(openParenIdx + 1, i);
	}
	return source.slice(openParenIdx + 1);
}

describe("pi 0.99 disposition contract", () => {
	it("keeps AgentSession.prompt() void and rejects mid-run input without streamingBehavior", () => {
		// package.json is not in the package "exports" map and the exports map has no
		// "require" condition — resolve the ESM entry and walk up to the package root.
		const pkgRoot = join(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "..", "..");

		// The audit's premise: in-process prompt() exposes NO disposition, so no caller can
		// branch on "handled" without switching to steer()/followUp() or pi's RPC mode.
		const types = readFileSync(join(pkgRoot, "dist/core/agent-session.d.ts"), "utf8");
		assert.match(types, /prompt\(text: string, options\?: PromptOptions\): Promise<void>;/);

		// The load-bearing runtime invariant (present well before 0.99): mid-run input with no
		// streamingBehavior throws. Every in-process sendUserMessage must therefore pass deliverAs.
		const impl = readFileSync(join(pkgRoot, "dist/core/agent-session.js"), "utf8");
		assert.match(impl, /if \(!options\?\.streamingBehavior\) \{\s*throw new Error\("Agent is already processing/);

		// sendCustomMessage — what pi.sendMessage and the whole coms queue use — never goes
		// through prompt(), so it can never be "handled" and can never throw the above.
		const custom = impl.slice(impl.indexOf("async sendCustomMessage"), impl.indexOf("async sendUserMessage"));
		assert.ok(!/\bthis\.prompt\(/.test(custom), "sendCustomMessage must not route through prompt()");

		// sendUserMessage maps deliverAs -> streamingBehavior and nothing else.
		assert.match(impl.slice(impl.indexOf("async sendUserMessage"), impl.indexOf("async sendUserMessage") + 1200), /streamingBehavior: options\?\.deliverAs/);
	});

	it("does not read pi's disposition field anywhere (would need a doc + test update)", () => {
		const offenders: string[] = [];
		for (const dir of ["extensions", "packages/pi-sidecar/src"]) {
			for (const file of tsFiles(join(REPO_ROOT, dir))) {
				const source = stripComments(readFileSync(file, "utf8"));
				if (/\.disposition\b|from\s+["'][^"']*rpc-client/.test(source)) {
					offenders.push(file.slice(REPO_ROOT.length + 1));
				}
			}
		}
		assert.deepEqual(offenders, [], `disposition adoption needs contributing/pi-099-disposition-audit.md updated: ${offenders.join(", ")}`);
	});
});

describe("streamingBehavior is supplied on every in-process prompt path", () => {
	it("passes deliverAs at every pi.sendUserMessage() call site", () => {
		// AgentSession.sendUserMessage maps deliverAs -> streamingBehavior. pi 0.99 throws
		// "Agent is already processing" when streamingBehavior is absent mid-run, and the
		// extension binding swallows that rejection into an extension error event.
		const missing: string[] = [];
		for (const file of tsFiles(join(REPO_ROOT, "extensions"))) {
			const source = stripComments(readFileSync(file, "utf8"));
			for (const match of source.matchAll(/\.sendUserMessage\(/g)) {
				const call = callAt(source, match.index + match[0].length - 1);
				if (!call.includes("deliverAs")) missing.push(`${file.slice(REPO_ROOT.length + 1)}:${source.slice(0, match.index).split("\n").length}`);
			}
		}
		assert.deepEqual(missing, [], `sendUserMessage without deliverAs throws while streaming: ${missing.join(", ")}`);
	});

	it("guards pi-sidecar's bare session.prompt() with the in-flight check", () => {
		// The one AgentSession.prompt() call site passes no options at all, so it relies on
		// `inFlight` (set synchronously, cleared only after the run resolves) to guarantee
		// isStreaming === false. Assert the guard still precedes the call.
		const sessions = stripComments(readFileSync(join(REPO_ROOT, "packages/pi-sidecar/src/sessions.ts"), "utf8"));
		const calls = [...sessions.matchAll(/\.session\.prompt\(/g)];
		assert.equal(calls.length, 1, "expected exactly one AgentSession.prompt() call site");
		const guardIdx = sessions.indexOf("if (entry.inFlight)");
		assert.ok(guardIdx > -1, "in-flight guard missing");
		assert.ok(guardIdx < calls[0].index!, "in-flight guard must precede session.prompt()");
		assert.ok(!callAt(sessions, calls[0].index! + ".session.prompt".length).includes("streamingBehavior"));
	});
});

describe("coms queue is independent of pi's disposition", () => {
	it("routes every coms inbound through sendCustomMessage, which never consults disposition", () => {
		// pi.sendMessage -> AgentSession.sendCustomMessage -> agent.steer/followUp/_runAgentPrompt.
		// It bypasses prompt() entirely: no input handlers, no extension commands, no
		// preflightResult. So a coms inbound can never come back "handled" (no run) and can
		// never trip the streamingBehavior requirement.
		const coms = stripComments(readFileSync(join(REPO_ROOT, "extensions/coms/coms-p2p.ts"), "utf8"));
		assert.equal(coms.match(/pi\.sendUserMessage\(/g), null, "coms must not use sendUserMessage (that path can be 'handled')");

		// Every inbound injection must pass deliverAs, since sendCustomMessage branches on it.
		for (const match of coms.matchAll(/pi\.sendMessage\(/g)) {
			const call = callAt(coms, match.index + match[0].length - 1);
			if (call.includes("triggerTurn: true")) {
				assert.match(call, /deliverAs: "followUp"/, `coms turn-triggering sendMessage missing deliverAs at offset ${match.index}`);
			}
		}
	});
});
