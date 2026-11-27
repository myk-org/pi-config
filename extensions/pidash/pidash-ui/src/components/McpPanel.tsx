import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/create-logger";
import { CopyButton } from "@/components/CopyButton";
import type { McpServerInfo } from "@/types";

const log = createLogger("McpPanel");

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
}

/** #968 F / #1481 — MCP server management: list, login, logout with untruncated output and Copy buttons. */
export function McpPanel({ sendCmd, onMessage, notify }: Props) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [opResult, setOpResult] = useState<{ op: string; server: string; ok: boolean; output: string } | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(() => new Set());
  const [topErrorOpen, setTopErrorOpen] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);
  const [opOutputOpen, setOpOutputOpen] = useState(true);

  useEffect(() => {
    sendCmd("mcp-list");
    return onMessage((ev: any) => {
      if (ev.type === "mcp-list") {
        setRefreshing(false);
        setServers(ev.servers ?? null);
        setRaw(ev.raw ?? null);
        setError(ev.error ?? null);
      }
      if (ev.type === "mcp-op-result") {
        setBusy(null);
        setOpResult(ev);
        setOpOutputOpen(true);
        // Refresh list after login/logout
        sendCmd("mcp-list");
      }
    });
  }, [sendCmd, onMessage]);

  const refresh = () => {
    setRefreshing(true);
    log.debug("mcp_list_refresh");
    sendCmd("mcp-list");
  };

  const toggleServerError = (name: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const nameOf = (s: McpServerInfo) => String(s.name ?? s.server ?? "?");
  const statusOf = (s: McpServerInfo) => String(s.status ?? s.state ?? "");
  const toolsOf = (s: McpServerInfo): string => {
    if (typeof s.tools === "number") return `${s.tools} tools`;
    if (Array.isArray(s.tools)) return `${s.tools.length} tools`;
    return "";
  };

  return (
    <div className="p-3 space-y-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">MCP Servers</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted"
          onClick={refresh}
          title="Refresh MCP servers"
        >
          <RefreshCw className={cn("h-2.5 w-2.5", refreshing && "animate-spin")} />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 p-2 rounded bg-red-500/10 border border-red-500/30 space-y-1.5 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              aria-expanded={topErrorOpen}
              onClick={() => setTopErrorOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-red-400 hover:underline min-w-0"
            >
              {topErrorOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <span className="truncate">Error ({error.length} chars)</span>
            </button>
            <CopyButton text={error} title="Copy MCP error" onCopied={() => notify("Copied MCP error")} />
          </div>
          {topErrorOpen && (
            <pre className="text-[10px] whitespace-pre-wrap break-words max-h-60 overflow-y-auto">{error}</pre>
          )}
        </div>
      )}

      {servers === null && !raw && !error && (
        <div className="text-xs text-muted-foreground py-4 text-center">Loading…</div>
      )}

      {servers && servers.length === 0 && (
        <div className="text-xs text-muted-foreground">No MCP servers configured</div>
      )}

      <div className="space-y-1.5">
        {(servers ?? []).map((s) => {
          const name = nameOf(s);
          const status = statusOf(s);
          const isOk = /ok|connected|running|authenticated/i.test(status);
          const errText = s.error ? String(s.error) : "";
          const errExpanded = expandedErrors.has(name);
          return (
            <div key={name} className="p-2 rounded-md bg-card border border-border text-xs space-y-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className={isOk ? "text-green-500" : "text-red-400"}>{isOk ? "✓" : "✗"}</span>
                <span className="font-medium text-foreground flex-1 truncate">{name}</span>
                {toolsOf(s) && <span className="text-[10px] text-muted-foreground shrink-0">{toolsOf(s)}</span>}
              </div>
              {status && <div className="text-[10px] text-muted-foreground break-words">{status}</div>}
              {errText && (
                <div className="rounded border border-red-500/30 bg-red-500/5 p-1.5 space-y-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <button
                      type="button"
                      aria-expanded={errExpanded}
                      onClick={() => toggleServerError(name)}
                      className="flex items-center gap-1 text-[10px] text-red-400 hover:underline min-w-0"
                    >
                      {errExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="truncate">Error details ({errText.length} chars)</span>
                    </button>
                    <CopyButton
                      text={errText}
                      title={`Copy error for ${name}`}
                      onCopied={() => notify(`Copied error for ${name}`)}
                    />
                  </div>
                  {errExpanded && (
                    <pre className="text-[10px] text-red-400 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                      {errText}
                    </pre>
                  )}
                </div>
              )}
              <div className="flex gap-1 mt-1.5 justify-end">
                <button
                  type="button"
                  className="px-1.5 py-0.5 text-[10px] rounded bg-accent/50 hover:bg-accent disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(`login:${name}`);
                    sendCmd("mcp-login", { server: name });
                  }}
                >
                  {busy === `login:${name}` ? "Opening…" : "Login"}
                </button>
                <button
                  type="button"
                  className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 hover:bg-red-500/40 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(`logout:${name}`);
                    sendCmd("mcp-logout", { server: name });
                  }}
                >
                  {busy === `logout:${name}` ? "…" : "Logout"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {raw && (
        <div className="rounded-md bg-card border border-border p-2 space-y-1.5 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              aria-expanded={rawOpen}
              onClick={() => setRawOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-foreground hover:underline min-w-0"
            >
              {rawOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <span className="truncate">Raw output ({raw.length} chars)</span>
            </button>
            <CopyButton text={raw} title="Copy raw MCP output" onCopied={() => notify("Copied raw MCP output")} />
          </div>
          {rawOpen && (
            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
              {raw}
            </pre>
          )}
        </div>
      )}

      {opResult && (
        <div
          className={cn(
            "text-[10px] p-2 rounded-md border space-y-1.5 min-w-0",
            opResult.ok
              ? "text-green-600 dark:text-green-400 border-green-500/30 bg-green-500/10"
              : "text-red-400 border-red-500/30 bg-red-500/10",
          )}
        >
          <div className="flex items-center justify-between gap-1 min-w-0">
            <button
              type="button"
              aria-expanded={opOutputOpen}
              onClick={() => setOpOutputOpen((v) => !v)}
              className="flex items-center gap-1 font-medium text-left hover:underline min-w-0 flex-1"
            >
              {opOutputOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <span className="break-words min-w-0">
                {opResult.op} {opResult.ok ? "succeeded" : "failed"} — {opResult.server}
              </span>
            </button>
            {opResult.output && (
              <CopyButton
                text={opResult.output}
                title="Copy command output"
                onCopied={() => notify("Copied command output")}
              />
            )}
          </div>
          {opResult.output && opOutputOpen && (
            <pre className="whitespace-pre-wrap break-words mt-1 max-h-60 overflow-y-auto">
              {opResult.output}
            </pre>
          )}
        </div>
      )}

      <div className="text-[10px] text-muted-foreground">
        Login opens the OAuth flow on the machine running pi. List/state via <code>pi mcp list</code>.
      </div>
    </div>
  );
}
