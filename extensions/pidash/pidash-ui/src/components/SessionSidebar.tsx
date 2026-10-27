import { useState } from "react";
import { GitBranch, Circle, Pause, PanelLeftClose, ChevronRight, ChevronDown, Folder, Settings, Pencil, Plus, MessagesSquare, X, Sun, Moon } from "lucide-react";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { NotificationSettings } from "@/components/NotificationSettings";
import { cn } from "@/lib/utils";
import type { SessionInfo, NotificationPreferences } from "@/types";
import { sessionActivityDisplay } from "@/lib/activity-display";
import { loadTheme, setTheme, type Theme } from "@/lib/theme";

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  connected: boolean;
  onSelect: (s: SessionInfo) => void;
  collapsed: boolean;
  onToggle: () => void;
  onSettings?: () => void;
  onNewSession?: () => void;
  onRename?: (sessionId: string, name: string) => void;
  notifications?: {
    permission: NotificationPermission;
    supported: boolean;
    preferences: NotificationPreferences;
    setPreference: <K extends keyof NotificationPreferences>(key: K, value: boolean) => void;
    requestPermission: () => void;
  };
}

// Track which groups the user explicitly collapsed.
// Everything NOT in this set is expanded by default.
const COLLAPSED_STORAGE_KEY = "pidash-collapsed-projects";

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

function saveCollapsedProjects(projects: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...projects])); } catch {}
}

export function SessionSidebar({ sessions, activeSessionId, connected, onSelect, collapsed, onToggle, onSettings, onNewSession, onRename, notifications }: Props) {
  const [collapsedProjects, setCollapsedProjectsRaw] = useState<Set<string>>(() => loadCollapsedProjects());
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Coms lens: a project name filters the whole list to its members. Transient
  // by design — the directory tree is the default view, coms is a lens on it.
  const [comsFilter, setComsFilter] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());

  // Wrap setter to persist to localStorage
  const setCollapsedProjects = (update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setCollapsedProjectsRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      saveCollapsedProjects(next);
      return next;
    });
  };

  if (collapsed) return null;

  /** One session row — shared by the directory tree and the coms lens. */
  const renderSession = (s: SessionInfo) => {
    const isActive = s.sessionId === activeSessionId;
    const status = sessionActivityDisplay(s);
    return (
      <div
        key={s.sessionId}
        className={cn(
          "group/session pl-7 pr-3 py-2 cursor-pointer transition-colors border-b border-border/50",
          isActive && "bg-accent border-l-3 border-l-primary",
          !isActive && "hover:bg-accent/30",
          !s.active && "opacity-35",
        )}
        onClick={() => onSelect(s)}
      >
        <div className={cn("text-xs font-medium truncate flex items-center gap-1.5", s.active ? "text-primary" : "text-muted-foreground")}>
          {!s.active && <Pause className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
          {s.active && status.isWorking && (
            <span className="relative flex h-2 w-2 flex-shrink-0" aria-label="working">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
            </span>
          )}
          {s.active && s.activity === "waiting_for_input" && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-cyan-400" aria-label="waiting for input" />
          )}
          {editingSessionId === s.sessionId ? (
            <input
              className="bg-transparent border-b border-primary outline-none text-xs w-full"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editName.trim()) {
                  onRename?.(s.sessionId, editName.trim());
                  setEditingSessionId(null);
                }
                if (e.key === "Escape") setEditingSessionId(null);
              }}
              onBlur={() => setEditingSessionId(null)}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="truncate">{s.name || s.model || "—"}</span>
              {onRename && (
                <Pencil
                  className="h-3 w-3 flex-shrink-0 opacity-0 group-hover/session:opacity-100 text-muted-foreground hover:text-primary cursor-pointer transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingSessionId(s.sessionId);
                    setEditName(s.name || s.model || "");
                  }}
                />
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
          {s.branch && (
            <span className="flex items-center gap-0.5">
              <GitBranch className="h-2.5 w-2.5" />
              <span className={s.gitDirty ? "text-red-500" : "text-green-500"}>
                {s.gitDirty ? "●" : "✓"}
              </span>
              <span className="truncate">{s.branch}</span>
            </span>
          )}
          {s.comsProject && (
            <span className="flex items-center gap-0.5 text-cyan-700 dark:text-cyan-400/90" title={`Coms project: ${s.comsProject}${s.comsName ? ` (you are ${s.comsName})` : ""}`}>
              <span aria-hidden="true">◆</span>
              <span className="truncate max-w-[5rem]">{s.comsProject}</span>
            </span>
          )}
          <span>{ago(s.startedAt)}</span>
          {s.activity === "waiting_for_input" && <span className="text-cyan-400">waiting for input</span>}
          {s.container && <Badge variant="outline" className="text-[8px] px-1 py-0 h-3">📦</Badge>}
        </div>
      </div>
    );
  };


  // ── Coms projects present among the sessions we can see ──────────────
  const comsProjects = new Map<string, { sessions: SessionInfo[]; busy: number }>();
  for (const s of sessions) {
    if (!s.comsProject) continue;
    if (!comsProjects.has(s.comsProject)) comsProjects.set(s.comsProject, { sessions: [], busy: 0 });
    const entry = comsProjects.get(s.comsProject)!;
    entry.sessions.push(s);
    if (s.activity === "working") entry.busy += 1;
  }
  const sortedComsProjects = [...comsProjects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const filtered = comsFilter ? comsProjects.get(comsFilter)?.sessions ?? [] : null;

  // Group sessions by project name (last segment of cwd)
  const groups = new Map<string, { cwd: string; sessions: SessionInfo[] }>();
  for (const s of sessions) {
    const name = s.cwd.split("/").pop() || s.cwd;
    if (!groups.has(name)) groups.set(name, { cwd: s.cwd, sessions: [] });
    groups.get(name)!.sessions.push(s);
  }

  // Sort: active sessions first within each group
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  }

  // Sort groups: groups with active sessions first
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aActive = a[1].sessions.some(s => s.active);
    const bActive = b[1].sessions.some(s => s.active);
    if (aActive !== bActive) return bActive ? 1 : -1;
    return a[0].localeCompare(b[0]);
  });

  const toggleProject = (name: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); // was collapsed → expand
      else next.add(name); // was expanded → collapse
      return next;
    });
  };

  // Auto-expand groups that contain the active session
  const activeGroup = sessions.find(s => s.sessionId === activeSessionId);
  const activeGroupName = activeGroup ? (activeGroup.cwd.split("/").pop() || activeGroup.cwd) : null;

  return (
    <div className="flex flex-col h-full border-r border-border">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-sm font-bold text-primary">pidash</span>
        <span className="flex items-center gap-2">
          <Circle className={cn("h-2 w-2 fill-current", connected ? "text-green-500" : "text-red-500")} />
          {onNewSession && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-primary" onClick={onNewSession} title="New session">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {notifications && <NotificationSettings
            permission={notifications.permission}
            supported={notifications.supported}
            preferences={notifications.preferences}
            setPreference={notifications.setPreference}
            requestPermission={notifications.requestPermission}
          />}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
            onClick={() => {
              const next: Theme = theme === "dark" ? "light" : "dark";
              setThemeState(next);
              setTheme(next);
            }}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
          {onSettings && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" onClick={onSettings}>
              <Settings className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" onClick={onToggle}>
            <PanelLeftClose className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>
      <ScrollArea className="flex-1">
        {sessions.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">No sessions</p>
        )}

        {/* Coms lens — projects are a collaboration namespace, the tree below is
            the filesystem. Clicking one filters; nothing is ever listed twice. */}
        {sortedComsProjects.length > 0 && (
          <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <MessagesSquare className="h-3 w-3" />
              <span>Coms</span>
              {comsFilter && (
                <button
                  className="ml-auto flex items-center gap-0.5 text-[10px] normal-case text-muted-foreground hover:text-foreground"
                  onClick={() => setComsFilter(null)}
                  title="Show all sessions"
                >
                  <X className="h-3 w-3" /> clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {sortedComsProjects.map(([project, info]) => {
                const isFiltered = comsFilter === project;
                return (
                  <button
                    key={project}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors",
                      isFiltered
                        ? "border-primary text-primary bg-accent"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                    onClick={() => setComsFilter((prev) => (prev === project ? null : project))}
                    title={`${info.sessions.length} session${info.sessions.length === 1 ? "" : "s"}${info.busy ? ` · ${info.busy} busy` : ""} in coms project ${project}`}
                    aria-pressed={isFiltered}
                  >
                    <span aria-hidden="true">◆</span>
                    <span className="truncate max-w-[7rem]">{project}</span>
                    <span className="tabular-nums opacity-70">{info.sessions.length}</span>
                    {info.busy > 0 && <span className="text-green-600 dark:text-green-400">●</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Filtered view: one project, its members, no duplication */}
        {filtered && (
          <div>
            <div className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold border-b border-border text-primary">
              <span aria-hidden="true">◆</span>
              <span className="truncate">{comsFilter}</span>
              <span className="ml-auto text-[10px] font-normal">{filtered.length}</span>
            </div>
            {filtered.length === 0 && (
              <p className="p-4 text-center text-xs text-muted-foreground">No sessions in this project</p>
            )}
            {filtered.map(renderSession)}
          </div>
        )}
        {!filtered && sortedGroups.map(([name, group]) => {
          const isExpanded = !collapsedProjects.has(name);
          const hasActive = group.sessions.some(s => s.active);
          const count = group.sessions.length;

          return (
            <div key={name}>
              {/* Project header */}
              <div
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 cursor-pointer text-sm font-semibold border-b border-border",
                  hasActive ? "text-primary" : "text-muted-foreground",
                  "hover:bg-accent/30",
                )}
                onClick={() => toggleProject(name)}
              >
                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <Folder className="h-3 w-3" />
                <span className="truncate">{name}</span>
                <span className="ml-auto text-[10px] font-normal">{count}</span>
              </div>

              {/* Sessions in this group */}
              {isExpanded && group.sessions.map(renderSession)}
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}
