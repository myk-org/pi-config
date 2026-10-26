import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { McpServerInfo } from "@/types";

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
}

/** #968 F — MCP server management: list, login, logout (pi mcp CLI). */
export function McpPanel({ sendCmd, onMessage, notify }: Props) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opResult, setOpResult] = useState<{ op: string; server: string; ok: boolean; output: string } | null>(null);

  useEffect(() => {
    sendCmd("mcp-list");
    return onMessage((ev: any) => {
      if (ev.type === "mcp-list") {
        setServers(ev.servers ?? null);
        setRaw(ev.raw ?? null);
        setError(ev.error ?? null);
      }
      if (ev.type === "mcp-op-result") {
        setBusy(null);
        setOpResult(ev);
        // Refresh list after login/logout
        sendCmd("mcp-list");
      }
    });
  }, [sendCmd, onMessage]);

  const nameOf = (s: McpServerInfo) => String(s.name ?? s.server ?? "?");
  const statusOf = (s: McpServerInfo) => String(s.status ?? s.state ?? "");
  const toolsOf = (s: McpServerInfo): string => {
    if (typeof s.tools === "number") return `${s.tools} tools`;
    if (Array.isArray(s.tools)) return `${s.tools.length} tools`;
    return "";
  };

  return (
    <div className="p-3 space-y-2">
      <div className="text-xs font-semibold text-foreground">MCP Servers</div>

      {error && <div className="text-xs text-red-400 p-2 rounded bg-red-500/10">{error}</div>}
      {servers === null && !raw && !error && <div className="text-xs text-muted-foreground py-4 text-center">Loading…</div>}

      {servers && servers.length === 0 && <div className="text-xs text-muted-foreground">No MCP servers configured</div>}

      <div className="space-y-1">
        {(servers ?? []).map((s) => {
          const name = nameOf(s);
          const status = statusOf(s);
          const isOk = /ok|connected|running|authenticated/i.test(status);
          return (
            <div key={name} className="p-2 rounded-md bg-card border border-border text-xs">
              <div className="flex items-center gap-2">
                <span className={isOk ? "text-green-500" : "text-red-400"}>{isOk ? "✓" : "✗"}</span>
                <span className="font-medium text-foreground flex-1 truncate">{name}</span>
                {toolsOf(s) && <span className="text-[10px] text-muted-foreground">{toolsOf(s)}</span>}
              </div>
              {status && <div className="text-[10px] text-muted-foreground">{status}</div>}
              {s.error && <div className="text-[10px] text-red-400 break-words">{String(s.error).slice(0, 200)}</div>}
              <div className="flex gap-1 mt-1.5 justify-end">
                <button
                  className="px-1.5 py-0.5 text-[10px] rounded bg-accent/50 hover:bg-accent disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => { setBusy(`login:${name}`); sendCmd("mcp-login", { server: name }); }}
                >
                  {busy === `login:${name}` ? "Opening…" : "Login"}
                </button>
                <button
                  className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => { setBusy(`logout:${name}`); sendCmd("mcp-logout", { server: name }); }}
                >
                  {busy === `logout:${name}` ? "…" : "Logout"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {raw && <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap p-2 rounded-md bg-card border border-border">{raw}</pre>}

      {opResult && (
        <div className={cn("text-[10px] p-2 rounded-md border break-words", opResult.ok ? "text-green-400 border-green-500/30 bg-green-500/10" : "text-red-400 border-red-500/30 bg-red-500/10")}>
          <div className="font-medium">{opResult.op} {opResult.ok ? "succeeded" : "failed"} — {opResult.server}</div>
          {opResult.output && <pre className="whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto">{opResult.output.slice(0, 1000)}</pre>}
        </div>
      )}

      <div className="text-[10px] text-muted-foreground">
        Login opens the OAuth flow on the machine running pi. List/state via <code>pi mcp list</code>.
      </div>
    </div>
  );
}
