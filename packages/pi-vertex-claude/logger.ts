/**
 * Package-local logger for npm installs. Never console.* (leaks into pi chat).
 * Writes ~/.pi/logs/<name>/<session-id>.log
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	isDebugEnabled(): boolean;
}

const LEVEL_ORDER: Record<string, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** Collapse CR/LF so one emit call = one physical log line. */
export function oneLine(text: string): string {
	return text.replace(/\r\n|\r|\n/g, "\\n");
}

function fmt(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return oneLine(a);
			try {
				return oneLine(JSON.stringify(a));
			} catch {
				return oneLine(String(a));
			}
		})
		.join(" ");
}

export function sanitizeLogSegment(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "_");
	return safe || "_";
}

function sessionId(): string {
	return (
		process.env.__PI_CONFIG_SESSION_ID ||
		(globalThis as { __piConfigSessionId?: string }).__piConfigSessionId ||
		process.env.PI_SESSION_ID ||
		"unknown"
	);
}

function envVarKey(name: string): string {
	return `PI_LOG_${sanitizeLogSegment(name).replace(/[-.]/g, "_").toUpperCase()}`;
}

function envLogLevel(name: string): string {
	const envName = envVarKey(name);
	const hyphenated = `PI_LOG_${sanitizeLogSegment(name).toUpperCase()}`;
	return (process.env[envName] || process.env[hyphenated] || process.env.PI_LOG || "info").trim().toLowerCase();
}

export function isDebugEnabled(name: string): boolean {
	const min = envLogLevel(name);
	if (min === "off") return false;
	return (LEVEL_ORDER[min] ?? LEVEL_ORDER.info) <= LEVEL_ORDER.debug;
}

export function createLogger(name: string): Logger {
	const safeName = sanitizeLogSegment(name);
	let failed = false;
	const emit = (level: string, args: unknown[]) => {
		if (failed) return;
		try {
			const dir = join(homedir(), ".pi", "logs", safeName);
			mkdirSync(dir, { recursive: true });
			const safeSid = sanitizeLogSegment(sessionId());
			appendFileSync(join(dir, `${safeSid}.log`), `${new Date().toISOString()} ${level} ${fmt(args)}\n`);
		} catch (err) {
			failed = true;
			try {
				process.stderr.write(`pi-vertex-claude logger write failed name=${name} err=${String(err)}\n`);
			} catch {
				// Diagnostic must never throw.
			}
		}
	};
	return {
		debug(...args: unknown[]) {
			if (!isDebugEnabled(name)) return;
			emit("debug", args);
		},
		info(...args: unknown[]) {
			emit("info", args);
		},
		warn(...args: unknown[]) {
			emit("warn", args);
		},
		error(...args: unknown[]) {
			emit("error", args);
		},
		isDebugEnabled() {
			return isDebugEnabled(name);
		},
	};
}
