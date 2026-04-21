import { useState } from "react";
import { GitBranch, Circle, Pause, PanelLeftClose, ChevronRight, ChevronDown, Folder } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { SessionInfo } from "@/types";

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
}

export function SessionSidebar({ sessions, activeSessionId, connected, onSelect, collapsed, onToggle }: Props) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  // Auto-expand all groups when sessions first load
  if (!initialized && sessions.length > 0) {
    setInitialized(true);
    const all = new Set<string>();
    for (const s of sessions) all.add(s.cwd.split("/").pop() || s.cwd);
    setExpandedProjects(all);
  }

  if (collapsed) return null;

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
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
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
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" onClick={onToggle}>
            <PanelLeftClose className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>
      <ScrollArea className="flex-1">
        {sessions.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">No sessions</p>
        )}
        {sortedGroups.map(([name, group]) => {
          const isExpanded = expandedProjects.has(name);
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
              {isExpanded && group.sessions.map((s) => {
                const isActive = s.sessionId === activeSessionId;
                return (
                  <div
                    key={s.sessionId}
                    className={cn(
                      "pl-7 pr-3 py-2 cursor-pointer transition-colors border-b border-border/50",
                      isActive && "bg-accent border-l-3 border-l-primary",
                      !isActive && "hover:bg-accent/30",
                      !s.active && "opacity-35",
                    )}
                    onClick={() => onSelect(s)}
                  >
                    <div className={cn("text-xs font-medium truncate flex items-center gap-1.5", s.active ? "text-primary" : "text-muted-foreground")}>
                      {!s.active && <Pause className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
                      <span className="truncate">{s.model || "—"}</span>
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
                      <span>{ago(s.startedAt)}</span>
                      {s.container && <Badge variant="outline" className="text-[8px] px-1 py-0 h-3">📦</Badge>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}
