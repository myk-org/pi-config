import { useRef, useState, useCallback, useEffect } from "react";
import type { SessionInfo } from "../types";

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

interface Props {
  sessions: SessionInfo[];
  activePid: number | null;
  connected: boolean;
  onSelect: (s: SessionInfo) => void;
}

export function Sidebar({ sessions, activePid, connected, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(260);
  const resizing = useRef(false);

  const onMouseDown = useCallback(() => { resizing.current = true; }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      setWidth(Math.max(180, Math.min(500, e.clientX)));
    };
    const onUp = () => { resizing.current = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  if (collapsed) {
    return (
      <button className="expand-btn" onClick={() => setCollapsed(false)} title="Expand sidebar">▶</button>
    );
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <span className="title">pidash</span>
        <span>
          <span className={`conn ${connected ? "ok" : "err"}`}>●</span>
          {" "}
          <button className="collapse-btn" onClick={() => setCollapsed(true)} title="Collapse">◀</button>
        </span>
      </div>
      <div className="sess-list">
        {sessions.length === 0 && <div className="no-sess">No sessions</div>}
        {sessions.map((s) => {
          const name = s.cwd.split("/").pop() || s.cwd;
          const gitIcon = s.gitDirty ? <span className="git-dirty">●</span> : <span className="git-clean">✓</span>;
          const parts: string[] = [];
          if (s.model) parts.push(s.model);
          parts.push(ago(s.startedAt));
          if (!s.active) parts.push("⏸");
          if (s.container) parts.push("📦");

          return (
            <div
              key={s.pid}
              className={`si${!s.active ? " inactive" : ""}${s.pid === activePid ? " active" : ""}`}
              onClick={() => onSelect(s)}
            >
              <div className="si-name">{name}</div>
              <div className="si-detail">
                {s.branch && <>{gitIcon} {s.branch}{s.gitChanges ? ` ~${s.gitChanges}` : ""} · </>}
                {parts.join(" · ")}
              </div>
            </div>
          );
        })}
      </div>
      <div className="resize-handle" onMouseDown={onMouseDown} />
    </div>
  );
}
