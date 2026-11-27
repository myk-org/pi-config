import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsData, SettingsKey } from "@/types";
import {
  buildSettingsCategories,
  displaySettingValue as displayValue,
  filterSettingsKeys,
  getCopyableSettingValue,
  parseTypedSetting as parseTyped,
} from "@/lib/settings-edit";
import { copyTextInBrowser } from "@/lib/worktrees-panel-helpers";
import { createLogger } from "@/lib/create-logger";

const log = createLogger("SettingsPanel");

interface Props {
  sendCmd: (command: string, extra?: Record<string, unknown>) => void;
  onMessage: (handler: (data: any) => void) => () => void;
  notify: (msg: string, level?: string) => void;
  cwd?: string;
}

type Draft = Record<string, unknown>;

const ALL_CATEGORY_ID = "__all__";

function sourceBadgeMeta(source: SettingsKey["source"]): { label: string; className: string; title: string } {
  switch (source) {
    case "P":
      return { label: "P", className: "bg-green-500/20 text-green-400 border-green-500/40", title: "Project override" };
    case "G":
      return { label: "G", className: "bg-blue-500/20 text-blue-400 border-blue-500/40", title: "Global setting" };
    case "E":
      return { label: "E", className: "bg-amber-500/20 text-amber-400 border-amber-500/40", title: "Environment variable" };
    default:
      return { label: "D", className: "bg-muted/60 text-muted-foreground border-border", title: "Default value" };
  }
}

/** #968 G + #1473 — full /pi-config-settings parity: left category sidebar,
 *  cross-category search, strict project/global scopes, and Copy value button. */
export function SettingsPanel({ sendCmd, onMessage, notify, cwd }: Props) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const [data, setData] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending write awaiting the server's ack (refreshed settings-data = ok,
  // settings-error = failed). Success is only announced after the ack — a
  // toast fired at send time would claim success for writes that fail
  // server-side (Qodo R1).
  const pendingOpRef = useRef<{ key: string; kind: "save" | "clear"; scope: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // This panel's resolved project settings file path, learned from the first
  // settings-data it accepts — the durable identity of "my settings file"
  // across worktrees/subdirs of one repo (Qodo R5).
  const settingsPathRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (pendingOpRef.current) clearTimeout(pendingOpRef.current.timer);
    };
  }, []);

  const settlePending = (ok: boolean | "cancelled", errorText?: string) => {
    const pending = pendingOpRef.current;
    pendingOpRef.current = null;
    setSavingKey(null);
    if (pending) clearTimeout(pending.timer);
    if (!pending) return;
    if (ok === "cancelled") {
      // The command WAS sent — the server may still apply it. Announce the
      // unknown outcome, not a failure (Qodo R3).
      log.info("setting write outcome unknown — scope switched", { key: pending.key, kind: pending.kind });
      notify(`${pending.key}: write sent, result unknown (scope switched)`, "info");
      return;
    }
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
    pendingOpRef.current = { key, kind, scope, timer };
    setSavingKey(key);
  };

  // A pending write belongs to the scope it was armed in. Switching scopes
  // re-subscribes the handler; the old scope's ack/error will never arrive on
  // the new subscription, and the new scope's ordinary fetch must NOT be
  // mistaken for the old write's success ack (Qodo R2).
  const cancelPendingIfScopeChanged = () => {
    const pending = pendingOpRef.current;
    if (pending && pending.scope !== scope) {
      settlePending("cancelled");
    }
  };

  useEffect(() => {
    cancelPendingIfScopeChanged();
    // New session cwd = new settings file: drop the learned path and all
    // state so the fresh settings-get reply is accepted and re-learned —
    // otherwise the stale path rejected the new project's payload and the
    // panel stayed blank until remounted (Qodo R6).
    settingsPathRef.current = null;
    setData(null);
    setDraft({});
    setErrors({});
    sendCmd("settings-get", { scope });
    return onMessage((ev: any) => {
      if (ev.type === "settings-data" && ev.scope === scope) {
        // Project-scoped payloads must describe THIS panel's settings file.
        // Preferred identity: the resolved settings file path — two sessions
        // in different worktrees/subdirs of one repo share the same file.
        // Fallback (older daemons): raw cwd compare. Global scope is
        // machine-wide and applies to everyone (Qodo R4/R5).
        const sourceCwd = (ev as any).sourceCwd as string | undefined;
        const evPath = (ev as any).settingsPath as string | undefined;
        const ownPath = settingsPathRef.current;
        const mine = (cwd ?? "").replace(/\/+$/, "");
        const isBroadcast = Boolean(sourceCwd);
        if (scope === "project") {
          if (!ownPath) {
            // Identity not yet learned: only the panel's OWN settings-get
            // reply (never a broadcast — those carry sourceCwd) may establish
            // it, so a foreign project's broadcast arriving first cannot
            // seize the filter (Qodo R7).
            if (isBroadcast) {
              log.debug("ignoring broadcast before own settings identity is learned", {});
              return;
            }
          } else if (evPath && evPath !== ownPath) {
            log.debug("ignoring settings payload for a different settings file", { evPath, ownPath });
            return;
          } else if (!evPath && sourceCwd && cwd && sourceCwd.replace(/\/+$/, "") !== mine) {
            log.debug("ignoring project-scoped settings broadcast from another project", { sourceCwd });
            return;
          }
        }
        if (evPath) settingsPathRef.current = evPath;
        log.debug("settings payload received", { scope, keys: (ev as any).keys?.length });
        setData(ev as SettingsData);
        setDraft({});
        setErrors({});
        // A refreshed payload is the success ack for a pending write in THIS
        // scope — never for one armed in the other scope (Qodo R2).
        if (pendingOpRef.current?.scope === scope) settlePending(true);
      }
      if (ev.type === "settings-error") {
        if (ev.scope !== undefined && ev.scope !== scope) return; // other scope's panel handles it
        log.warn("settings error from server", { key: ev.key, error: ev.error });
        if (pendingOpRef.current) settlePending(false, ev.error);
        else notify(`Settings error (${ev.key}): ${ev.error}`, "error");
      }
    });
  }, [sendCmd, onMessage, scope, notify, cwd]);

  const categories = useMemo(() => {
    if (!data) return [];
    return buildSettingsCategories(data.keys);
  }, [data]);

  const activeCategory = useMemo(() => {
    if (categories.length === 0) return "";
    if (selectedCategory && categories.some((c) => c.name === selectedCategory)) {
      return selectedCategory;
    }
    return categories[0].name;
  }, [categories, selectedCategory]);

  const trimmedFilter = filter.trim();
  const isSearching = trimmedFilter.length > 0;

  const crossCategoryMatches = useMemo(() => {
    if (!data || !isSearching) return [] as SettingsKey[];
    return filterSettingsKeys(data.keys, trimmedFilter);
  }, [data, isSearching, trimmedFilter]);

  const matchCountsByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const k of crossCategoryMatches) {
      const group = k.group || "Other";
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return counts;
  }, [crossCategoryMatches]);

  const visibleKeys = useMemo(() => {
    if (!data) return [] as SettingsKey[];
    if (isSearching) {
      if (selectedCategory && selectedCategory !== ALL_CATEGORY_ID) {
        return crossCategoryMatches.filter((k) => (k.group || "Other") === selectedCategory);
      }
      return crossCategoryMatches;
    }
    const cat = categories.find((c) => c.name === activeCategory);
    return cat ? cat.keys : [];
  }, [data, isSearching, selectedCategory, crossCategoryMatches, categories, activeCategory]);

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

  const handleCopyValue = async (def: SettingsKey) => {
    const text = getCopyableSettingValue(def, def.key in draft, draft[def.key]);
    const ok = await copyTextInBrowser(text);
    if (ok) {
      setCopiedKey(def.key);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
      notify(`Copied ${def.key} value`);
      log.debug("setting value copied", { key: def.key });
    } else {
      notify(`Failed to copy ${def.key} value`, "error");
    }
  };

  if (data?.error) return <div className="text-xs text-red-400 p-4">Settings load failed: {data.error}</div>;
  if (!data) return <div className="text-xs text-muted-foreground p-4 text-center">Loading settings…</div>;

  const rightHeaderLabel = isSearching
    ? selectedCategory && selectedCategory !== ALL_CATEGORY_ID
      ? `${selectedCategory} · "${trimmedFilter}"`
      : `All matches · "${trimmedFilter}"`
    : activeCategory;

  return (
    <div className="h-full flex flex-col min-w-0 overflow-hidden" data-testid="settings-panel">
      {/* Top toolbar: Scope switch + cross-category search */}
      <div className="p-2 border-b border-border flex items-center gap-1.5 min-w-0 shrink-0">
        <div className="flex rounded-md border border-border overflow-hidden text-[11px] shrink-0">
          <button
            className={cn(
              "px-2 py-1 transition-colors",
              scope === "project" ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/30",
            )}
            onClick={() => setScope("project")}
          >
            Project
          </button>
          <button
            className={cn(
              "px-2 py-1 transition-colors",
              scope === "global" ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/30",
            )}
            onClick={() => setScope("global")}
          >
            Global
          </button>
        </div>
        <div className="relative flex-1 min-w-0">
          <Search className="h-3 w-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            aria-label="Search all settings"
            className="w-full pl-6 pr-6 py-1 text-xs rounded bg-background border border-border outline-none focus:border-primary min-w-0"
            placeholder="Search all categories…"
            value={filter}
            onChange={(e) => {
              const next = e.target.value;
              setFilter(next);
              if (next.trim().length > 0) {
                setSelectedCategory(ALL_CATEGORY_ID);
              } else if (selectedCategory === ALL_CATEGORY_ID) {
                setSelectedCategory(categories[0]?.name ?? "");
              }
            }}
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setFilter("");
                if (selectedCategory === ALL_CATEGORY_ID) {
                  setSelectedCategory(categories[0]?.name ?? "");
                }
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Main split body: scrollable left category sidebar + right settings list */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        <nav
          aria-label="Settings categories"
          data-testid="settings-category-sidebar"
          className="w-[104px] sm:w-[116px] shrink-0 border-r border-border overflow-y-auto py-1 bg-card/30"
        >
          {isSearching && (
            <button
              type="button"
              className={cn(
                "w-full flex items-center justify-between gap-1 px-2 py-1.5 text-left text-[11px] transition-colors border-l-2",
                selectedCategory === ALL_CATEGORY_ID || !selectedCategory
                  ? "bg-accent text-foreground font-medium border-primary"
                  : "text-muted-foreground hover:bg-accent/40 border-transparent",
              )}
              onClick={() => setSelectedCategory(ALL_CATEGORY_ID)}
            >
              <span className="truncate">All</span>
              <span className="text-[10px] opacity-80 shrink-0">{crossCategoryMatches.length}</span>
            </button>
          )}
          {categories.map((cat) => {
            const count = isSearching ? (matchCountsByCategory.get(cat.name) ?? 0) : cat.keys.length;
            const isActive = isSearching ? selectedCategory === cat.name : activeCategory === cat.name;
            const dimmed = isSearching && count === 0;
            return (
              <button
                key={cat.name}
                type="button"
                title={`${cat.name} (${count})`}
                className={cn(
                  "w-full flex items-center justify-between gap-1 px-2 py-1.5 text-left text-[11px] transition-colors border-l-2",
                  isActive
                    ? "bg-accent text-foreground font-medium border-primary"
                    : dimmed
                      ? "text-muted-foreground/45 hover:bg-accent/20 border-transparent"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/40 border-transparent",
                )}
                onClick={() => setSelectedCategory(cat.name)}
              >
                <span className="truncate">{cat.name}</span>
                <span className="text-[10px] opacity-80 shrink-0">{count}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-w-0 overflow-y-auto p-2 space-y-2" data-testid="settings-items-pane">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground pb-1 border-b border-border/60 min-w-0">
            <span className="font-semibold text-foreground truncate">{rightHeaderLabel}</span>
            <span className="shrink-0">
              {visibleKeys.length} {visibleKeys.length === 1 ? "key" : "keys"} · {scope === "project" ? "Project" : "Global"}
            </span>
          </div>

          {visibleKeys.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">No matching settings</div>
          )}

          {visibleKeys.map((def) => {
            const storedStr = displayValue(def.stored);
            const isSet = def.stored !== undefined;
            const draftVal = draft[def.key];
            const dirty =
              def.key in draft &&
              String(draftVal ?? "") !== storedStr &&
              !(typeof draftVal === "boolean" && def.stored === draftVal);
            const isBool = def.type === "bool" || def.type === "bool_enable";
            // Strictly scope-aware boolean state: draft > stored > scope effective > default
            const effectiveBoolBase =
              def.stored !== undefined
                ? def.stored === true
                : scope === "project" && def.effective !== undefined
                  ? def.effective === true
                  : def.default === true;
            const boolEffective = typeof draftVal === "boolean" ? draftVal : effectiveBoolBase;
            const badge = sourceBadgeMeta(def.source ?? (isSet ? (scope === "project" ? "P" : "G") : "D"));
            const globalOnlyBlocked = Boolean(def.globalOnly && scope === "project");
            const placeholderVal =
              storedStr ||
              (scope === "project" && def.effective !== undefined ? displayValue(def.effective) : displayValue(def.default)) ||
              "—";

            return (
              <div key={def.key} className="rounded-md border border-border bg-background p-2 space-y-1.5 min-w-0">
                <div className="flex items-start justify-between gap-1.5 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                      <span
                        title={badge.title}
                        className={cn(
                          "inline-flex items-center justify-center px-1 py-0 text-[9px] font-mono font-semibold rounded border shrink-0",
                          badge.className,
                        )}
                      >
                        {badge.label}
                      </span>
                      <span className="text-xs font-mono font-medium text-foreground break-all">{def.key}</span>
                      {isSearching && (
                        <span className="text-[9px] px-1 py-0 rounded bg-muted text-muted-foreground shrink-0">
                          {def.group}
                        </span>
                      )}
                      {def.globalOnly && (
                        <span className="text-[9px] px-1 py-0 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
                          global-only
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground break-words mt-0.5">{def.description}</div>
                    <div className="text-[10px] text-muted-foreground/70 mt-0.5 break-all">
                      default: {displayValue(def.default) || "—"}
                      {def.env && <> · env: <code>{def.env}</code></>}
                      {isSet && <> · <span className="text-primary">set ({scope})</span></>}
                    </div>
                  </div>
                </div>

                {/* Editor control + Copy button (full width row prevents overflow even in narrow drawers) */}
                <div className="flex items-center gap-1 min-w-0">
                  {isBool ? (
                    <button
                      type="button"
                      className={cn(
                        "flex-1 min-w-0 px-2 py-1 text-[11px] rounded border transition-colors text-left",
                        boolEffective
                          ? "bg-green-500/20 text-green-400 border-green-500/40"
                          : "bg-muted/40 text-muted-foreground border-border",
                        globalOnlyBlocked && "opacity-50 cursor-not-allowed",
                      )}
                      onClick={() => {
                        if (globalOnlyBlocked) return;
                        setDraftValue(def.key, !boolEffective);
                        armPending(def.key, "save");
                        sendCmd("settings-set", { scope, key: def.key, value: !boolEffective });
                      }}
                      disabled={savingKey === def.key || globalOnlyBlocked}
                      title={globalOnlyBlocked ? "Switch to Global scope to edit" : undefined}
                    >
                      {boolEffective ? "enabled" : "disabled"}
                    </button>
                  ) : (
                    <input
                      className={cn(
                        "flex-1 min-w-0 px-2 py-1 text-[11px] rounded bg-background border outline-none font-mono",
                        errors[def.key] ? "border-red-500" : dirty ? "border-primary" : "border-border",
                        globalOnlyBlocked && "opacity-50 cursor-not-allowed",
                      )}
                      placeholder={placeholderVal}
                      value={def.key in draft ? displayValue(draftVal) : storedStr}
                      onChange={(e) => setDraftValue(def.key, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !globalOnlyBlocked) save(def); }}
                      disabled={globalOnlyBlocked}
                      title={globalOnlyBlocked ? "Switch to Global scope to edit" : undefined}
                    />
                  )}
                  <button
                    type="button"
                    aria-label={`Copy ${def.key} value`}
                    title="Copy value"
                    className="shrink-0 p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                    onClick={() => void handleCopyValue(def)}
                  >
                    {copiedKey === def.key ? (
                      <Check className="h-3 w-3 text-green-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>

                {!isBool && (dirty || errors[def.key]) && (
                  <div className="flex items-center gap-2 justify-end flex-wrap">
                    {errors[def.key] && <span className="text-[10px] text-red-400 break-words">{errors[def.key]}</span>}
                    {dirty && !errors[def.key] && !globalOnlyBlocked && (
                      <button
                        type="button"
                        className="px-1.5 py-0.5 text-[10px] rounded bg-primary text-primary-foreground"
                        onClick={() => save(def)}
                      >
                        Save
                      </button>
                    )}
                    <button
                      type="button"
                      className="px-1.5 py-0.5 text-[10px] rounded bg-muted/50 hover:bg-muted text-muted-foreground"
                      onClick={() => {
                        setDraft((d) => { const n = { ...d }; delete n[def.key]; return n; });
                        setErrors((e) => { const n = { ...e }; delete n[def.key]; return n; });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                )}

                {isSet && !dirty && !globalOnlyBlocked && (
                  <div className="text-right">
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-red-400"
                      onClick={() => clearKey(def.key)}
                    >
                      clear
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          <div className="text-[10px] text-muted-foreground pt-1">
            Writes go through the live settings module (atomic file write) and apply on next session start or /reload — same semantics as /pi-config-settings.
          </div>
        </div>
      </div>
    </div>
  );
}
