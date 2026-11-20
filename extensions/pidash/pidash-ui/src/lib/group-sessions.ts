import type { SessionInfo } from "@/types";

export interface SessionGroup {
  name: string;
  cwd: string;
  sessions: SessionInfo[];
}

/** Group sessions by project directory name (last segment of cwd) with active groups and sessions first. */
export function groupAndSortSessions(sessions: readonly SessionInfo[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const name = (s.cwd || "").split("/").pop() || s.cwd;
    let group = groups.get(name);
    if (!group) {
      group = { name, cwd: s.cwd, sessions: [] };
      groups.set(name, group);
    }
    group.sessions.push(s);
  }

  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  }

  return [...groups.values()].sort((a, b) => {
    const aActive = a.sessions.some((s) => s.active);
    const bActive = b.sessions.some((s) => s.active);
    if (aActive !== bActive) return bActive ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
