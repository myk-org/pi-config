/**
 * Persist CLI session ids so resume works across turns.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export interface CliSessionKey {
  cwd: string;
  agent: string;
  model: string;
  /** Pi session id when available; falls back to "default" */
  piSessionId?: string | null;
}

function sessionsDir(): string {
  return join(homedir(), ".pi", "cli-sessions");
}

function keyHash(key: CliSessionKey): string {
  const raw = [
    key.cwd,
    key.agent,
    key.model,
    key.piSessionId || "default",
  ].join("\0");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function sessionFile(key: CliSessionKey): string {
  return join(sessionsDir(), `${keyHash(key)}.json`);
}

export function loadCliSessionId(key: CliSessionKey): string | null {
  const path = sessionFile(key);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return typeof data.sessionId === "string" && data.sessionId
      ? data.sessionId
      : null;
  } catch {
    return null;
  }
}

export function saveCliSessionId(key: CliSessionKey, sessionId: string): void {
  if (!sessionId) return;
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    sessionFile(key),
    JSON.stringify({
      sessionId,
      agent: key.agent,
      model: key.model,
      cwd: key.cwd,
      piSessionId: key.piSessionId || "default",
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
}

export function clearCliSessionId(key: CliSessionKey): void {
  const path = sessionFile(key);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}
