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
}

function fmt(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

function sessionId(): string {
	return (
		process.env.__PI_CONFIG_SESSION_ID ||
		(globalThis as { __piConfigSessionId?: string }).__piConfigSessionId ||
		process.env.PI_SESSION_ID ||
		"unknown"
	);
}

export function createLogger(name: string): Logger {
	const emit = (level: string, args: unknown[]) => {
		try {
			const dir = join(homedir(), ".pi", "logs", name);
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, `${sessionId()}.log`), `${new Date().toISOString()} ${level} ${fmt(args)}\n`);
		} catch {
			// Logging must never break the provider.
		}
	};
	return {
		debug(...args: unknown[]) {
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
	};
}
