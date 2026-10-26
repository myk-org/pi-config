import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { SettingsData, SettingsKey } from "@/types";
import { displaySettingValue as displayValue, parseTypedSetting as parseTyped } from "@/lib/settings-edit";
import { createLogger } from "@/lib/create-logger";

const log = createLogger("SettingsPanel");

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
}

type Draft = Record<string, unknown>;



/** #968 G — full /pi-config-settings parity: every key from settings-keys.json,
 *  grouped, typed editors, project + global scopes, stored/default/env visible. */
export function SettingsPanel({ sendCmd, onMessage, notify }: Props) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const [data, setData] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Pending write awaiting the server's ack (refreshed settings-data = ok,
  // settings-error = failed). Success is only announced after the ack — a
  // toast fired at send time would claim success for writes that fail
  // server-side (Qodo R1).
  const pendingOpRef = useRef<{ key: string; kind: "save" | "clear"; timer: ReturnType<typeof setTimeout> } | null>(null);

  const settlePending = (ok: boolean, errorText?: string) => {
    const pending = pendingOpRef.current;
    pendingOpRef.current = null;
    setSavingKey(null);
    if (pending) clearTimeout(pending.timer);
    if (!pending) return;
    if (ok) {
      log.info("setting saved", { key: pending.key, kind: pending.kind, scope });
      notify(`${pending.kind === "clear" ? "Cleared" : "Saved"} ${pending.key} (${scope})`);
    } else {
      log.warn("setting write failed", { key: pending.key, kind: pending.kind, error: errorText });
      notify(`Failed to ${pending.kind} ${pending.key}${errorText ? `: ${errorText}` : ""}`, "error");
    }
  };

  const armPending = (key: string, kind: "save" | "clear") => {
    if (pendingOpRef.current) clearTimeout(pendingOpRef.current.timer);
    const timer = setTimeout(() => {
      log.warn("setting write timed out — no server ack", { key, kind });
      settlePending(false, "no response from server");
    }, 10000);
    pendingOpRef.current = { key, kind, timer };
    setSavingKey(key);
  };

  useEffect(() => {
    setData(null);
    setDraft({});
    setErrors({});
    sendCmd("settings-get", { scope });
    return onMessage((ev: any) => {
      if (ev.type === "settings-data" && ev.scope === scope) {
        log.debug("settings payload received", { scope, keys: (ev as any).keys?.length });
        setData(ev as SettingsData);
        setDraft({});
        setErrors({});
        // A refreshed payload is the success ack for a pending write.
        settlePending(true);
      }
      if (ev.type === "settings-error") {
        if (ev.scope !== undefined && ev.scope !== scope) return; // other scope's panel handles it
        log.warn("settings error from server", { key: ev.key, error: ev.error });
        if (pendingOpRef.current) settlePending(false, ev.error);
        else notify(`Settings error (${ev.key}): ${ev.error}`, "error");
      }
    });
  }, [sendCmd, onMessage, scope, notify]);

  const groups = useMemo(() => {
    if (!data) return [] as Array<[string, SettingsKey[]]>;
    const byGroup = new Map<string, SettingsKey[]>();
    for (const k of data.keys) {
      if (filter && !k.key.toLowerCase().includes(filter.toLowerCase())
        && !k.description.toLowerCase().includes(filter.toLowerCase())) continue;
      if (!byGroup.has(k.group)) byGroup.set(k.group, []);
      byGroup.get(k.group)!.push(k);
    }
    return [...byGroup.entries()];
  }, [data, filter]);

  const setDraftValue = (key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const save = (def: SettingsKey) => {
    if (!(def.key in draft)) return;
    const raw = draft[def.key];
    // Toggle path passes booleans directly; text path parses
    let value: unknown;
    if (typeof raw === "boolean") value = raw;
    else {
      const parsed = parseTyped(String(raw), def);
      if (parsed.error) {
        log.warn("setting draft rejected", { key: def.key, error: parsed.error });
        setErrors((e) => ({ ...e, [def.key]: parsed.error! }));
        return;
      }
      value = parsed.value;
    }
    setSavingKey(def.key);
    armPending(def.key, "save");
    sendCmd("settings-set", { scope, key: def.key, value });
  };

  const clearKey = (key: string) => {
    armPending(key, "clear");
    sendCmd("settings-set", { scope, key });
  };

  if (data?.error) return <div className="text-xs text-red-400 p-4">Settings load failed: {data.error}</div>;
  if (!data) return <div className="text-xs text-muted-foreground p-4 text-center">Loading settings…</div>;

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex rounded-md border border-border overflow-hidden text-xs">
          <button
            className={cn("px-2.5 py-1", scope === "project" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/30")}
            onClick={() => setScope("project")}
          >Project</button>
          <button
            className={cn("px-2.5 py-1", scope === "global" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/30")}
            onClick={() => setScope("global")}
          >Global</button>
        </div>
        <input
          className="flex-1 px-2 py-1 text-xs rounded bg-background border border-border outline-none focus:border-primary"
          placeholder="Filter settings…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {groups.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">No matching settings</div>}

      {groups.map(([group, keys]) => (
        <div key={group} className="rounded-md border border-border overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-2 py-1.5 bg-card text-xs font-semibold text-foreground"
            onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
          >
            <span>{group}</span>
            <span className="text-[10px] text-muted-foreground font-normal">{keys.length}</span>
          </button>
          {!collapsed[group] && (
            <div className="divide-y divide-border">
              {keys.map((def) => {
                const storedStr = displayValue(def.stored);
                const isSet = def.stored !== undefined;
                const draftVal = draft[def.key];
                const dirty = def.key in draft && String(draftVal ?? "") !== storedStr && !(typeof draftVal === "boolean" && def.stored === draftVal);
                const isBool = def.type === "bool" || def.type === "bool_enable";
                // Toggle state: draft > stored value > schema default (unset keys show their default).
                const boolEffective = typeof draftVal === "boolean"
                  ? draftVal
                  : def.stored !== undefined ? def.stored === true : def.default === true;
                return (
                  <div key={def.key} className="px-2 py-2 bg-background">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-foreground break-words">{def.key}</div>
                        <div className="text-[10px] text-muted-foreground break-words">{def.description}</div>
                        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                          default: {displayValue(def.default) || "—"}
                          {def.env && <> · env: <code>{def.env}</code></>}
                          {isSet && <> · <span className="text-primary">set ({scope})</span></>}
                        </div>
                      </div>
                      <div className="flex-shrink-0 w-[130px]">
                        {isBool ? (
                          <button
                            className={cn(
                              "w-full px-2 py-1 text-[11px] rounded border transition-colors",
                              boolEffective
                                ? "bg-green-500/20 text-green-400 border-green-500/40"
                                : "bg-muted/40 text-muted-foreground border-border",
                            )}
                            onClick={() => {
                              setDraftValue(def.key, !boolEffective);
                              armPending(def.key, "save");
                              sendCmd("settings-set", { scope, key: def.key, value: !boolEffective });
                            }}
                            disabled={savingKey === def.key}
                          >
                            {boolEffective ? "enabled" : "disabled"}
                          </button>
                        ) : (
                          <input
                            className={cn(
                              "w-full px-2 py-1 text-[11px] rounded bg-background border outline-none font-mono",
                              errors[def.key] ? "border-red-500" : dirty ? "border-primary" : "border-border",
                            )}
                            placeholder={storedStr || displayValue(def.default) || "—"}
                            value={def.key in draft ? displayValue(draftVal) : storedStr}
                            onChange={(e) => setDraftValue(def.key, e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") save(def); }}
                          />
                        )}
                      </div>
                    </div>
                    {!isBool && (dirty || errors[def.key]) && (
                      <div className="flex items-center gap-2 mt-1 justify-end">
                        {errors[def.key] && <span className="text-[10px] text-red-400">{errors[def.key]}</span>}
                        {dirty && !errors[def.key] && (
                          <button className="px-1.5 py-0.5 text-[10px] rounded bg-primary text-primary-foreground" onClick={() => save(def)}>Save</button>
                        )}
                        <button
                          className="px-1.5 py-0.5 text-[10px] rounded bg-muted/50 hover:bg-muted text-muted-foreground"
                          onClick={() => { setDraft((d) => { const n = { ...d }; delete n[def.key]; return n; }); setErrors((e) => { const n = { ...e }; delete n[def.key]; return n; }); }}
                        >Reset</button>
                      </div>
                    )}
                    {isSet && !dirty && (
                      <div className="mt-0.5 text-right">
                        <button className="text-[10px] text-muted-foreground hover:text-red-400" onClick={() => clearKey(def.key)}>clear</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      <div className="text-[10px] text-muted-foreground">
        Writes go through the live settings module (atomic file write) and apply on next session start or /reload — same semantics as /pi-config-settings.
      </div>
    </div>
  );
}
