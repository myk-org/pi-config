/**
 * Settings TUI — interactive editor for pi-config settings.
 *
 * /pi-config-settings opens a fullscreen overlay with a scrollable left
 * category sidebar, cross-category search, strict Global/Project scope
 * isolation, themed header/footer, colored source glyphs, and fuzzy pickers.
 */

import { createLogger } from "../shared/logger.js";
import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  type SelectItem,
  type SettingItem,
  SettingsList,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  EMPTY_VALUE_SENTINEL,
  SETTINGS_KEYS,
  type SettingsKeyDef,
  type SettingSource,
  type SettingsScope,
  type SettingsSourceSnapshot,
  clearSettingsCache,
  loadSettingsSourceSnapshot,
  resolveSettingForScope,
  getFilePathForScope,
  readSettingsFile,
  beginSettingsEditSession,
  endSettingsEditSession,
  parseSettingInput,
  updateSetting,
} from "./project-settings.js";
import { discoverAgents } from "./agents.js";
import {
  CATEGORIES,
  type CategoryDef,
  computeSidebarWindow,
  filterSettingsAcrossCategories,
  formatValue,
  getCategoryLabelForKey,
  isSecretNoChange,
  isSecretSettingKey,
  registerSettingsTuiCommand,
  resolveModelKeySubmenu,
  resolveSecretPrefill,
  sourceGlyph,
  type ModelSelectItem,
} from "./settings-tui-helpers.js";
import {
  OVERLAY_OPTS,
  borderSegment,
  padAnsi,
} from "./overlay-dashboard.js";
import {
  InputSubmenu,
  NumberInputSubmenu,
  PickerSubmenu,
  AgentOverridesSubmenu,
  StringListSubmenu,
  SelectSubmenu,
} from "./settings-tui-submenus.js";

// Re-export helpers for external consumers
const log = createLogger("settings_tui");
log.debug("settings-tui module loaded");

export {
  CATEGORIES,
  type CategoryDef,
  computeSidebarWindow,
  filterSettingsAcrossCategories,
  formatValue,
  getCategoryLabelForKey,
  isSecretSettingKey,
  maskSettingValue,
  parseRawValue,
  registerSettingsTuiCommand,
  isSecretNoChange,
  resolveSecretPrefill,
  sourceGlyph,
  filterModelsByProvider,
  resolveModelPickerProvider,
  resolveModelPickerItems,
  resolveModelKeySubmenu,
} from "./settings-tui-helpers.js";
export type { SettingSource };

// ── Provider/Model data helpers ─────────────────────────────────────

interface ProviderModelInfo {
  providers: SelectItem[];
  models: ModelSelectItem[];
}

function getProviderModelInfo(modelRegistry: ModelRegistry | undefined): ProviderModelInfo {
  if (!modelRegistry) return { providers: [], models: [] };

  const models = modelRegistry.getAvailable?.() || modelRegistry.getAll?.() || [];
  log.debug("getProviderModelInfo", { modelCount: models.length });

  const providerSet = new Set<string>();
  for (const m of models) {
    if (m.provider) {
      providerSet.add(m.provider);
    }
  }

  const providers: SelectItem[] = [...providerSet].sort().map((p) => ({
    value: p,
    label: p,
  }));

  const modelItems: ModelSelectItem[] = models.map((m) => ({
    value: m.id,
    label: m.id,
    description: m.provider,
  }));

  return { providers, models: modelItems };
}

// ── Available agent names (for agent_overrides) ─────────────────────

function getAvailableAgentNames(cwd: string): string[] {
  const { agents } = discoverAgents(cwd, "both");
  return agents.map((a) => a.name).sort();
}

// ── Label + in-place refresh (strictly scope-aware) ─────────────────

function formatItemLabel(
  key: string,
  source: SettingSource,
  theme: Theme,
  showCategoryTag: boolean,
  categoryLabel?: string,
  isGlobalOnlyInProject = false,
): string {
  if (isGlobalOnlyInProject) {
    const catSuffix = showCategoryTag ? ` [${categoryLabel ?? getCategoryLabelForKey(key)}]` : "";
    return theme.fg("dim", `${source} ${key}${catSuffix} (global-only)`);
  }
  const glyph = sourceGlyph(source, theme);
  if (!showCategoryTag) return `${glyph} ${key}`;
  const cat = categoryLabel ?? getCategoryLabelForKey(key);
  return `${glyph} ${key} ${theme.fg("dim", `[${cat}]`)}`;
}

function formatItemValue(
  key: string,
  value: unknown,
  def: SettingsKeyDef,
  theme: Theme,
  isGlobalOnlyInProject: boolean,
): string {
  const displayValue = formatValue(key, value, def);
  return isGlobalOnlyInProject ? theme.fg("dim", displayValue) : displayValue;
}

export function refreshItem(
  item: SettingItem,
  cwd: string,
  editScope: SettingsScope,
  theme: Theme,
  showCategoryTag = false,
  categoryLabel?: string,
): void {
  const def = SETTINGS_KEYS[item.id];
  if (!def) return;
  const resolved = resolveSettingForScope(cwd, item.id, editScope);
  if (!resolved) return;
  const isGlobalOnlyInProject = Boolean(def.global_only && editScope === "project");
  const displayValue = formatItemValue(item.id, resolved.value, def, theme, isGlobalOnlyInProject);
  // Mutate in-place — SettingsList stores items array by reference (verified in pi-tui source)
  item.label = formatItemLabel(item.id, resolved.source, theme, showCategoryTag, categoryLabel, isGlobalOnlyInProject);
  item.currentValue = displayValue;
}

// ── Build setting items for a single category ───────────────────────

export interface BuildCategoryItemsOptions {
  snapshot?: SettingsSourceSnapshot;
  getProviderModelInfo?: () => ProviderModelInfo;
  getAvailableAgents?: () => string[];
  showCategoryTag?: boolean;
  categories?: readonly CategoryDef[];
}

export function buildCategoryItems(
  categoryIndex: number,
  cwd: string,
  editScope: SettingsScope,
  theme: Theme,
  modelRegistry?: ModelRegistry,
  options?: BuildCategoryItemsOptions,
): SettingItem[] {
  const categories = options?.categories ?? CATEGORIES;
  const category = categories[categoryIndex];
  if (!category) return [];

  const items: SettingItem[] = [];
  const snapshot = options?.snapshot ?? loadSettingsSourceSnapshot(cwd);
  const showCategoryTag = options?.showCategoryTag === true;
  let pmInfoCache: ProviderModelInfo | undefined;
  const resolvePmInfo = (): ProviderModelInfo => {
    if (pmInfoCache === undefined) {
      pmInfoCache = options?.getProviderModelInfo
        ? options.getProviderModelInfo()
        : getProviderModelInfo(modelRegistry);
    }
    return pmInfoCache;
  };
  let agentsCache: string[] | undefined;
  const resolveAvailableAgents = (): string[] => {
    if (agentsCache === undefined) {
      agentsCache = options?.getAvailableAgents
        ? options.getAvailableAgents()
        : getAvailableAgentNames(cwd);
    }
    return agentsCache;
  };

  for (const key of category.keys) {
    const def = SETTINGS_KEYS[key];
    if (!def) continue;

    // Strictly respect active editScope: Global never leaks Project overrides.
    const resolved = resolveSettingForScope(cwd, key, editScope, snapshot);
    if (!resolved) continue;
    const isGlobalOnlyInProject = Boolean(def.global_only && editScope === "project");
    const displayValue = formatItemValue(key, resolved.value, def, theme, isGlobalOnlyInProject);

    const item: SettingItem = {
      id: key,
      label: formatItemLabel(key, resolved.source, theme, showCategoryTag, category.label, isGlobalOnlyInProject),
      currentValue: displayValue,
      description: [
        def.description,
        def.global_only ? "global-only" : "",
        def.env ? `env: ${def.env}` : "",
      ].filter(Boolean).join(" · "),
    };

    // Configure interaction based on type and key
    const isProviderKey = key === "agent_provider" || key === "internal_operations_provider";
    const isModelKey =
      key === "agent_model" ||
      key === "internal_operations_model" ||
      key === "advisor_model";

    if (isProviderKey && resolvePmInfo().providers.length > 0) {
      const pmInfo = resolvePmInfo();
      item.submenu = (current: string, done: (val?: string) => void): Component => {
        const normalizedCurrent = current === EMPTY_VALUE_SENTINEL ? "" : current.trim();
        return new PickerSubmenu(`Select provider for ${key}`, pmInfo.providers, theme, done, normalizedCurrent);
      };
    } else if (isModelKey && resolvePmInfo().models.length > 0) {
      const pmInfo = resolvePmInfo();
      // Resolve provider/models inside the callback strictly for editScope so
      // Global never picks up Project's provider and refreshes stay fresh.
      item.submenu = (current: string, done: (val?: string) => void): Component => {
        const normalizedCurrent = current === EMPTY_VALUE_SENTINEL ? "" : current.trim();
        const agentProviderVal = resolveSettingForScope(cwd, "agent_provider", editScope)?.value;
        const internalProviderVal = resolveSettingForScope(cwd, "internal_operations_provider", editScope)?.value;
        const submenu = resolveModelKeySubmenu(
          key,
          pmInfo.models,
          {
            agent_provider: typeof agentProviderVal === "string" ? agentProviderVal : "",
            internal_operations_provider: typeof internalProviderVal === "string" ? internalProviderVal : "",
          },
          normalizedCurrent,
        );
        // advisor_model: if picker list is empty, fall back to free-text input
        if (submenu.mode === "input") {
          log.debug("model picker empty — free-text fallback", { key, provider: submenu.provider });
          const hint = key === "advisor_model"
            ? "Enter provider/model-id (e.g. google/gemini-2.5-flash; empty = session model)"
            : "Enter new value (empty to clear)";
          return new InputSubmenu(key, current, hint, theme, done);
        }
        if (key === "advisor_model") {
          log.debug("model picker open", {
            key,
            provider: submenu.provider,
            count: submenu.models.length,
          });
        }
        const title = key === "advisor_model"
          ? "Select advisor model (provider/model-id)"
          : `Select model for ${key}`;
        return new PickerSubmenu(title, submenu.models, theme, done, normalizedCurrent);
      };
    } else {
      switch (def.type) {
        case "bool":
        case "bool_enable":
          item.values = ["true", "false"];
          break;

        case "bool_or_string":
          item.submenu = (current: string, done: (val?: string) => void): Component => {
            return new InputSubmenu(
              `${key} (bool or custom string)`,
              current,
              'Enter "true", "false", or a custom string',
              theme,
              done,
            );
          };
          break;

        case "string": {
          const enumValues = def.enum;

          if (enumValues && enumValues.length > 0) {
            item.submenu = (current: string, done: (val?: string) => void): Component => {
              return new SelectSubmenu(key, enumValues, current, theme, done);
            };
            break;
          }

          const isSecret = isSecretSettingKey(key, def);
          item.submenu = (current: string, done: (val?: string) => void): Component => {
            // Re-read secret scope info fresh on open so repeated edits never see stale state.
            const secretInfo = isSecret ? resolveSecretPrefill(key, editScope, cwd) : null;
            const prefill = secretInfo ? secretInfo.prefill : current;
            const hint = secretInfo
              ? secretInfo.hint
              : key === "advisor_model"
                ? "Enter provider/model-id (e.g. google/gemini-2.5-flash; empty = session model)"
                : "Enter new value (empty to clear)";
            return new InputSubmenu(key, prefill, hint, theme, (val?: string) => {
              if (isSecret && secretInfo && isSecretNoChange(val, secretInfo.scopeValue !== null)) {
                done(undefined);
                return;
              }
              done(val);
            });
          };
          break;
        }

        case "int":
        case "port":
        case "number":
          item.submenu = (current: string, done: (val?: string) => void): Component => {
            return new NumberInputSubmenu(key, current, def, theme, done);
          };
          break;

        case "string_list": {
          item.submenu = (_current: string, done: (val?: string) => void): Component => {
            // Read the SCOPE'S OWN list fresh at every open — never the merged
            // effective value and never a stale closure captured before a save.
            const scopeFile = getFilePathForScope(editScope, cwd);
            const raw = readSettingsFile(scopeFile);
            const scopeList = raw && Array.isArray(raw[key])
              ? (raw[key] as string[]).filter((e): e is string => typeof e === "string")
              : [];
            log.debug("settings_string_list_open", key, editScope, scopeList.length);
            return new StringListSubmenu(
              key === "restricted_folders" ? `${key} — folders` : `${key} — patterns`,
              scopeList,
              theme,
              done,
              key,
            );
          };
          break;
        }

        case "agent_overrides": {
          const pmInfo = resolvePmInfo();
          const availableAgents = resolveAvailableAgents();
          item.submenu = (_current: string, done: (val?: string) => void): Component => {
            // Strictly read the target scope's own overrides fresh on open so Project
            // edits never copy Global overrides and Global edits never see Project ones.
            const scopeFile = getFilePathForScope(editScope, cwd);
            const raw = readSettingsFile(scopeFile);
            const scopeOverrides =
              raw && typeof raw[key] === "object" && raw[key] !== null && !Array.isArray(raw[key])
                ? (raw[key] as Record<string, { provider?: string | null; model?: string | null }>)
                : {};
            log.debug("settings_agent_overrides_open", editScope, Object.keys(scopeOverrides).length);
            return new AgentOverridesSubmenu(
              "Agent overrides — per-agent provider/model",
              scopeOverrides,
              availableAgents,
              theme,
              done,
              pmInfo.providers,
              pmInfo.models,
            );
          };
          break;
        }

        case "lsp_servers": {
          item.submenu = (_current: string, done: (val?: string) => void): Component => {
            const scopeFile = getFilePathForScope(editScope, cwd);
            const raw = readSettingsFile(scopeFile);
            const scopeVal =
              raw && typeof raw[key] === "object" && raw[key] !== null && !Array.isArray(raw[key])
                ? JSON.stringify(raw[key])
                : "{}";
            return new InputSubmenu(
              key,
              scopeVal,
              'Enter JSON object mapping server id to {"command":"...","args":[...],"extensions":[".ext"]}',
              theme,
              done,
            );
          };
          break;
        }

        case "tool_permissions": {
          item.submenu = (_current: string, done: (val?: string) => void): Component => {
            const scopeFile = getFilePathForScope(editScope, cwd);
            const raw = readSettingsFile(scopeFile);
            const scopeRules =
              raw && typeof raw[key] === "object" && raw[key] !== null && !Array.isArray(raw[key])
                ? raw[key]
                : {};
            return new InputSubmenu(
              `${key} — JSON rules`,
              JSON.stringify(scopeRules),
              'Enter JSON rules, e.g. {"fetch_content":{"*":"ask","github.com":"allow"}} or {}',
              theme,
              done,
            );
          };
          break;
        }
      }
    }

    items.push(item);
  }

  return items;
}

// Keep buildSettingItems for cross-category search and backward compat / tests
export function buildSettingItems(
  cwd: string,
  editScope: SettingsScope,
  theme: Theme,
  modelRegistry?: ModelRegistry,
  options?: Pick<BuildCategoryItemsOptions, "showCategoryTag" | "categories" | "getAvailableAgents" | "getProviderModelInfo">,
): SettingItem[] {
  const categories = options?.categories ?? CATEGORIES;
  const snapshot = loadSettingsSourceSnapshot(cwd);
  let pmInfoCache: ProviderModelInfo | undefined;
  let agentsCache: string[] | undefined;
  const sharedOptions: BuildCategoryItemsOptions = {
    snapshot,
    categories,
    showCategoryTag: options?.showCategoryTag,
    getProviderModelInfo: options?.getProviderModelInfo ?? (() => (pmInfoCache ??= getProviderModelInfo(modelRegistry))),
    getAvailableAgents: options?.getAvailableAgents ?? (() => (agentsCache ??= getAvailableAgentNames(cwd))),
  };
  const all: SettingItem[] = [];
  for (let i = 0; i < categories.length; i++) {
    all.push(...buildCategoryItems(i, cwd, editScope, theme, modelRegistry, sharedOptions));
  }
  return all;
}

// ── Safe SettingsList state access ──────────────────────────────────
// SettingsList fields are TypeScript-private (compile-time only) — accessible at runtime.

// Exported for tests: the overlay's Tab/category-switch guard keys off
// hasActiveSubmenu (Qodo PR #950 R7 — switching tabs while a StringListSubmenu
// holds dirty edits would drop them).
export function getSettingsListState(list: SettingsList): {
  hasActiveSearch: boolean;
  hasActiveSubmenu: boolean;
  selectedIndex: number;
  displayItems: SettingItem[];
} {
  const raw = list as any;
  const searchInput = raw.searchInput;
  const hasActiveSearch = !!(searchInput && searchInput.getValue && searchInput.getValue().length > 0);
  const hasActiveSubmenu = !!raw.submenuComponent;
  const selectedIndex: number = raw.selectedIndex ?? 0;
  const displayItems: SettingItem[] = raw.searchEnabled ? (raw.filteredItems ?? raw.items) : (raw.items ?? []);
  return { hasActiveSearch, hasActiveSubmenu, selectedIndex, displayItems };
}

// ── Thin save/delete adapters over the deep settings store ──────

function saveChange(key: string, value: unknown, scope: SettingsScope, cwd: string) {
  return updateSetting(cwd, scope, key, value, { dedupeBackup: true });
}

function deleteFromScope(key: string, scope: SettingsScope, cwd: string) {
  return updateSetting(cwd, scope, key, undefined, { dedupeBackup: true });
}

// ── Settings overlay component ──────────────────────────────────

export interface SettingsOverlayOptions {
  categories?: readonly CategoryDef[];
}

export class SettingsOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private cwd: string;
  private modelRegistry: ModelRegistry | undefined;
  private editScope: SettingsScope;
  private categoryIndex: number;
  private focusPane: "sidebar" | "items";
  private categories: readonly CategoryDef[];
  private done: (value: undefined) => void;
  private notify: (msg: string, level: "info" | "error") => void;
  private onSettingChanged?: (key: string) => void;
  private searchInput: Input;
  private settingsList!: SettingsList;
  private currentItems: SettingItem[];
  private allSearchItemsCache: SettingItem[] | null;
  private cachedAvailableAgents?: string[];
  private statusBanner: { text: string; level: "warning" | "error" | "info" } | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    tui: TUI,
    theme: Theme,
    cwd: string,
    modelRegistry: ModelRegistry | undefined,
    initialScope: SettingsScope,
    done: (value: undefined) => void,
    notify: (msg: string, level: "info" | "error") => void,
    onSettingChanged?: (key: string) => void,
    options?: SettingsOverlayOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.cwd = cwd;
    this.modelRegistry = modelRegistry;
    this.editScope = initialScope;
    this.categoryIndex = 0;
    this.focusPane = "items";
    this.categories = options?.categories && options.categories.length > 0 ? options.categories : CATEGORIES;
    this.done = done;
    this.notify = notify;
    this.onSettingChanged = onSettingChanged;
    this.searchInput = new Input();
    this.currentItems = [];
    this.allSearchItemsCache = null;
    this.rebuild();
  }

  private get searchQuery(): string {
    return this.searchInput.getValue().trim();
  }

  private get hasRawSearch(): boolean {
    return this.searchInput.getValue().length > 0;
  }

  private getCategoryLabelFor(id: string): string {
    for (const cat of this.categories) {
      if (cat.keys.includes(id)) return cat.label;
    }
    return getCategoryLabelForKey(id);
  }

  private getAllSearchItems(): SettingItem[] {
    if (!this.allSearchItemsCache) {
      this.allSearchItemsCache = buildSettingItems(
        this.cwd,
        this.editScope,
        this.theme,
        this.modelRegistry,
        {
          categories: this.categories,
          showCategoryTag: true,
          getAvailableAgents: () => (this.cachedAvailableAgents ??= getAvailableAgentNames(this.cwd)),
        },
      );
    }
    return this.allSearchItemsCache;
  }

  private setStatusBanner(text: string, level: "warning" | "error" | "info"): void {
    this.statusBanner = { text, level };
  }

  private clearStatusBanner(): void {
    this.statusBanner = null;
  }

  private createSettingsList(items: SettingItem[], isSearchMode: boolean): SettingsList {
    const rows = this.tui.terminal.rows || 30;
    const maxVisible = Math.max(5, Math.min(20, rows - 13));

    return new SettingsList(
      items,
      maxVisible,
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        if (!(id in SETTINGS_KEYS)) return;
        const item = this.currentItems.find((i) => i.id === id);

        if (SETTINGS_KEYS[id]?.global_only && this.editScope === "project") {
          const msg = `${id} is global-only — press Tab to switch to Global scope`;
          log.debug("settings_global_only_blocked", { key: id, scope: this.editScope, action: "change" });
          this.setStatusBanner(msg, "warning");
          if (item) refreshItem(item, this.cwd, this.editScope, this.theme, isSearchMode, this.getCategoryLabelFor(id));
          this.invalidate();
          this.tui.requestRender();
          return;
        }

        const parsedResult = parseSettingInput(id, newValue);
        if (!parsedResult.ok) {
          const msg = `Invalid value for ${id}: ${parsedResult.error}`;
          this.setStatusBanner(msg, "error");
          this.notify(msg, "error");
          if (item) refreshItem(item, this.cwd, this.editScope, this.theme, isSearchMode, this.getCategoryLabelFor(id));
          this.invalidate();
          this.tui.requestRender();
          return;
        }
        const parsed = parsedResult.value;

        const result = saveChange(id, parsed, this.editScope, this.cwd);
        if (!result.ok) {
          const msg = result.reason === "corrupt"
            ? `Failed to save: settings file is corrupt (${result.file})`
            : `Failed to write settings: ${result.error || "unknown error"}`;
          this.setStatusBanner(msg, "error");
          this.notify(msg, "error");
          if (item) refreshItem(item, this.cwd, this.editScope, this.theme, isSearchMode, this.getCategoryLabelFor(id));
          this.invalidate();
          this.tui.requestRender();
          return;
        }
        this.clearStatusBanner();
        // Array-valued settings (e.g. dangerous_command_allowlist) log only
        // their entry COUNT — entries may contain inline credentials, and the
        // settings log must not copy them out of the settings file.
        const logValue = Array.isArray(parsed)
          ? `${parsed.length} entr${parsed.length === 1 ? "y" : "ies"} (values not logged)`
          : typeof parsed === "object" && parsed !== null
            ? `${Object.keys(parsed).length} rule(s) (values not logged)`
            : String(parsed).slice(0, 60);
        log.info("settings_changed", id, this.editScope, logValue);

        // When provider changes, auto-clear the paired model in the same scope
        if (id === "agent_provider") {
          saveChange("agent_model", "", this.editScope, this.cwd);
          const modelItem = this.currentItems.find((i) => i.id === "agent_model");
          if (modelItem) {
            refreshItem(modelItem, this.cwd, this.editScope, this.theme, isSearchMode, this.getCategoryLabelFor("agent_model"));
          }
        } else if (id === "internal_operations_provider") {
          saveChange("internal_operations_model", "", this.editScope, this.cwd);
          const modelItem = this.currentItems.find((i) => i.id === "internal_operations_model");
          if (modelItem) {
            refreshItem(
              modelItem,
              this.cwd,
              this.editScope,
              this.theme,
              isSearchMode,
              this.getCategoryLabelFor("internal_operations_model"),
            );
          }
        }

        // Invalidate cached cross-category items so toggling search shows fresh values.
        if (!isSearchMode) this.allSearchItemsCache = null;

        // Update label + value in-place strictly for the active scope.
        if (item) refreshItem(item, this.cwd, this.editScope, this.theme, isSearchMode, this.getCategoryLabelFor(id));
        this.onSettingChanged?.(id);
        this.invalidate();
        this.tui.requestRender();
      },
      () => this.done(undefined),
      { enableSearch: false },
    );
  }

  private rebuild(): void {
    const query = this.searchQuery;
    if (query.length > 0) {
      const allItems = this.getAllSearchItems();
      this.currentItems = filterSettingsAcrossCategories(
        allItems,
        query,
        (id) => this.getCategoryLabelFor(id),
      );
      this.settingsList = this.createSettingsList(this.currentItems, true);
    } else {
      // Provider/model metadata is resolved lazily per rebuild (never pinned for the whole overlay
      // visit) so models discovered asynchronously while the overlay is open appear on switch.
      this.currentItems = buildCategoryItems(
        this.categoryIndex,
        this.cwd,
        this.editScope,
        this.theme,
        this.modelRegistry,
        {
          categories: this.categories,
          showCategoryTag: false,
          getAvailableAgents: () => (this.cachedAvailableAgents ??= getAvailableAgentNames(this.cwd)),
        },
      );
      this.settingsList = this.createSettingsList(this.currentItems, false);
    }
    this.invalidate();
  }

  handleInput(data: string): void {
    // While a submenu (e.g. StringListSubmenu) is open, its local edits exist
    // ONLY in the submenu component — rebuilding would silently drop them.
    const state = getSettingsListState(this.settingsList);
    if (state.hasActiveSubmenu) {
      this.settingsList.handleInput?.(data);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Tab switches scope (Project <-> Global) and refreshes all displayed items immediately.
    if (matchesKey(data, Key.tab)) {
      this.editScope = this.editScope === "project" ? "global" : "project";
      this.allSearchItemsCache = null;
      this.clearStatusBanner();
      log.debug("settings_scope_toggled", { scope: this.editScope, query: this.searchQuery });
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    // ── Sidebar focus ──
    if (this.focusPane === "sidebar") {
      if (matchesKey(data, Key.escape)) {
        if (this.hasRawSearch) {
          this.searchInput.setValue("");
          this.clearStatusBanner();
          this.rebuild();
          this.tui.requestRender();
        } else {
          this.done(undefined);
        }
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.categoryIndex = (this.categoryIndex - 1 + this.categories.length) % this.categories.length;
        if (this.hasRawSearch) this.searchInput.setValue("");
        this.clearStatusBanner();
        this.rebuild();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        this.categoryIndex = (this.categoryIndex + 1) % this.categories.length;
        if (this.hasRawSearch) this.searchInput.setValue("");
        this.clearStatusBanner();
        this.rebuild();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.enter) || data === "l" || data === "/") {
        this.focusPane = "items";
        this.clearStatusBanner();
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.left) || data === "h") {
        return;
      }
      return;
    }

    // ── Items + cross-category search focus ──
    if (matchesKey(data, Key.escape)) {
      if (this.hasRawSearch) {
        this.searchInput.setValue("");
        this.clearStatusBanner();
        this.rebuild();
        this.tui.requestRender();
      } else {
        this.done(undefined);
      }
      return;
    }

    // Left arrow (when search is empty) switches focus to the left category sidebar.
    if (!this.hasRawSearch && matchesKey(data, Key.left)) {
      this.focusPane = "sidebar";
      this.clearStatusBanner();
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Delete key: remove setting from current scope (skip when search is active).
    if (matchesKey(data, Key.delete)) {
      if (!this.hasRawSearch) {
        const selectedItem = state.displayItems[state.selectedIndex];
        if (selectedItem) {
          if (SETTINGS_KEYS[selectedItem.id]?.global_only && this.editScope === "project") {
            const msg = `${selectedItem.id} is global-only — press Tab to switch to Global scope`;
            log.debug("settings_global_only_blocked", { key: selectedItem.id, scope: this.editScope, action: "delete" });
            this.setStatusBanner(msg, "warning");
            this.invalidate();
            this.tui.requestRender();
            return;
          }
          this.clearStatusBanner();
          const delResult = deleteFromScope(selectedItem.id, this.editScope, this.cwd);
          if (!delResult.ok) {
            const msg = delResult.reason === "corrupt"
              ? `Failed to delete: settings file is corrupt (${delResult.file})`
              : `Failed to delete: ${delResult.error || "unknown error"}`;
            this.setStatusBanner(msg, "error");
            this.notify(msg, "error");
          } else if (delResult.changed === false) {
            this.notify(`${selectedItem.id} is not set in ${this.editScope} scope`, "info");
          } else {
            this.notify(`Deleted ${selectedItem.id} from ${this.editScope} scope`, "info");
            this.allSearchItemsCache = null;
            refreshItem(
              selectedItem,
              this.cwd,
              this.editScope,
              this.theme,
              false,
              this.getCategoryLabelFor(selectedItem.id),
            );
            this.onSettingChanged?.(selectedItem.id);
          }
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
    }

    // List activation: block global_only edits directly on Project scope with an inline warning.
    if (matchesKey(data, Key.enter) || (data === " " && !this.hasRawSearch)) {
      const selectedItem = state.displayItems[state.selectedIndex];
      if (selectedItem && SETTINGS_KEYS[selectedItem.id]?.global_only && this.editScope === "project") {
        const msg = `${selectedItem.id} is global-only — press Tab to switch to Global scope`;
        log.debug("settings_global_only_blocked", { key: selectedItem.id, scope: this.editScope, action: "edit" });
        this.setStatusBanner(msg, "warning");
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.clearStatusBanner();
      this.settingsList.handleInput?.(data);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // List navigation goes directly to SettingsList and clears transient warnings.
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.pageDown)
    ) {
      this.clearStatusBanner();
      this.settingsList.handleInput?.(data);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // All other input edits the cross-category search query.
    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previousQuery) {
      this.clearStatusBanner();
      this.rebuild();
    } else {
      this.invalidate();
    }
    this.tui.requestRender();
  }

  private renderSidebarLines(sidebarWidth: number, bodyHeight: number, isSearchMode: boolean): string[] {
    const theme = this.theme;
    const total = this.categories.length;
    const needsScroll = total > bodyHeight;
    const listRows = needsScroll ? Math.max(1, bodyHeight - 1) : bodyHeight;
    const { start, end } = computeSidebarWindow(total, this.categoryIndex, listRows);

    const matchCounts = new Map<string, number>();
    if (isSearchMode) {
      for (const item of this.currentItems) {
        const cat = this.getCategoryLabelFor(item.id);
        matchCounts.set(cat, (matchCounts.get(cat) ?? 0) + 1);
      }
    }

    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const cat = this.categories[i];
      const isSelected = i === this.categoryIndex;
      const count = isSearchMode ? (matchCounts.get(cat.label) ?? 0) : cat.keys.length;
      const countText = `(${count})`;
      const cursor = isSelected
        ? (this.focusPane === "sidebar" ? theme.fg("accent", "❯") : theme.fg("dim", "▸"))
        : " ";

      // Layout: " " + cursor(1) + " " + label + padding + countText + " "
      const fixedWidth = 4 + countText.length;
      const maxLabelW = Math.max(4, sidebarWidth - fixedWidth);
      const rawLabel = truncateToWidth(cat.label, maxLabelW, "…");
      const padSpaces = Math.max(1, sidebarWidth - 3 - visibleWidth(rawLabel) - countText.length - 1);

      let styledLabel: string;
      let styledCount: string;
      if (isSelected && this.focusPane === "sidebar") {
        styledLabel = theme.fg("accent", theme.bold(rawLabel));
        styledCount = theme.fg("accent", countText);
      } else if (isSearchMode && count === 0) {
        styledLabel = theme.fg("dim", rawLabel);
        styledCount = theme.fg("dim", countText);
      } else if (isSelected && !isSearchMode) {
        styledLabel = theme.fg("accent", rawLabel);
        styledCount = theme.fg("dim", countText);
      } else if (isSearchMode && count > 0) {
        styledLabel = theme.fg("text", rawLabel);
        styledCount = theme.fg("accent", countText);
      } else {
        styledLabel = theme.fg("text", rawLabel);
        styledCount = theme.fg("dim", countText);
      }

      lines.push(` ${cursor} ${styledLabel}${" ".repeat(padSpaces)}${styledCount} `);
    }

    while (lines.length < listRows) lines.push("");

    if (needsScroll) {
      const upInd = start > 0 ? "▲" : " ";
      const downInd = end < total ? "▼" : " ";
      const status = `  ${upInd} ${this.categoryIndex + 1}/${total} ${downInd}`;
      lines.push(theme.fg("dim", truncateToWidth(status, sidebarWidth)));
    }

    return lines;
  }

  private renderRightPaneLines(rightWidth: number, bodyHeight: number, isSearchMode: boolean): string[] {
    const theme = this.theme;
    const lines: string[] = [];

    // Cross-category search input bar
    const searchPrefix = ` ${theme.fg("dim", "🔍")} `;
    const inputWidth = Math.max(8, rightWidth - 4);
    if (this.hasRawSearch) {
      const inputLine = this.searchInput.render(inputWidth)[0] ?? "";
      lines.push(truncateToWidth(`${searchPrefix}${inputLine}`, rightWidth));
    } else {
      const placeholder = this.focusPane === "items"
        ? theme.fg("dim", "Type to search all categories…")
        : theme.fg("dim", "Press → or / to search all categories…");
      lines.push(truncateToWidth(`${searchPrefix}${placeholder}`, rightWidth));
    }
    lines.push(theme.fg("border", "─".repeat(rightWidth)));

    if (isSearchMode && this.currentItems.length === 0) {
      lines.push(truncateToWidth(theme.fg("dim", `  No matching settings for "${this.searchQuery}"`), rightWidth));
    } else {
      const settingsLines = this.settingsList.render(rightWidth);
      for (const sl of settingsLines) {
        if (lines.length >= bodyHeight) break;
        lines.push(sl);
      }
    }

    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const rows = this.tui.terminal.rows || 30;
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];

    const currentCategory = this.categories[this.categoryIndex] ?? this.categories[0];
    const scopeLabel = this.editScope === "project" ? "Project" : "Global";
    const otherScope = this.editScope === "project" ? "Global" : "Project";
    const isSearchMode = this.searchQuery.length > 0;
    const state = getSettingsListState(this.settingsList);

    // ── Header: Title + active scope + mode summary ──
    const headerLeft = theme.fg("accent", theme.bold("Settings"));
    const scopeBadge = this.editScope === "project"
      ? theme.fg("success", theme.bold(`[${scopeLabel}]`))
      : theme.fg("accent", theme.bold(`[${scopeLabel}]`));
    const modeSummary = isSearchMode
      ? theme.fg("dim", `Search "${this.searchQuery}" · ${this.currentItems.length} match${this.currentItems.length === 1 ? "" : "es"} across ${this.categories.length} categories`)
      : theme.fg("dim", `${currentCategory?.label ?? ""} · Tab → ${otherScope}`);
    lines.push(truncateToWidth(`  ${headerLeft}  ${scopeBadge}  ${modeSummary}`, width));

    const divider = theme.fg("border", "│");
    const bodyHeight = Math.max(6, rows - (this.statusBanner ? 7 : 6));

    if (state.hasActiveSubmenu || innerWidth < 50) {
      // Submenu open (or ultra-narrow terminal): full inner width for comfortable editing
      const borderTitle = state.hasActiveSubmenu
        ? `Editing (${scopeLabel})`
        : isSearchMode
          ? `Search: "${this.searchQuery}" · ${scopeLabel} · ${this.currentItems.length} matches`
          : `${currentCategory?.label ?? "Settings"} · ${scopeLabel} · ${currentCategory?.keys.length ?? 0} keys`;
      lines.push(
        theme.fg("border", "╭") +
        borderSegment(theme, innerWidth, borderTitle) +
        theme.fg("border", "╮"),
      );

      const bodyLines = state.hasActiveSubmenu
        ? this.settingsList.render(innerWidth)
        : this.renderRightPaneLines(innerWidth, bodyHeight, isSearchMode);

      for (let i = 0; i < bodyHeight; i++) {
        lines.push(divider + padAnsi(bodyLines[i] ?? "", innerWidth) + divider);
      }

      lines.push(
        theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
      );
    } else {
      // Two-pane layout: scrollable left category sidebar + right settings/search pane
      const sidebarWidth = Math.max(18, Math.min(24, Math.floor(innerWidth * 0.25)));
      const rightWidth = Math.max(20, innerWidth - sidebarWidth - 1);

      const leftTitle = `Categories (${this.categories.length})`;
      const rightTitle = isSearchMode
        ? `Search: "${this.searchQuery}" · ${scopeLabel} · ${this.currentItems.length} match${this.currentItems.length === 1 ? "" : "es"}`
        : `${currentCategory?.label ?? "Settings"} · ${scopeLabel} · ${currentCategory?.keys.length ?? 0} keys`;

      lines.push(
        theme.fg("border", "╭") +
        borderSegment(theme, sidebarWidth, leftTitle) +
        theme.fg("border", "┬") +
        borderSegment(theme, rightWidth, rightTitle) +
        theme.fg("border", "╮"),
      );

      const sidebarLines = this.renderSidebarLines(sidebarWidth, bodyHeight, isSearchMode);
      const rightLines = this.renderRightPaneLines(rightWidth, bodyHeight, isSearchMode);

      for (let i = 0; i < bodyHeight; i++) {
        const left = padAnsi(sidebarLines[i] ?? "", sidebarWidth);
        const right = padAnsi(rightLines[i] ?? "", rightWidth);
        lines.push(divider + left + divider + right + divider);
      }

      lines.push(
        theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(sidebarWidth)) +
        theme.fg("border", "┴") +
        theme.fg("border", "─".repeat(rightWidth)) +
        theme.fg("border", "╯"),
      );
    }

    // ── Inline transient warning/status banner ──
    if (this.statusBanner) {
      const icon = this.statusBanner.level === "error"
        ? "✖"
        : this.statusBanner.level === "warning"
          ? "⚠"
          : "ℹ";
      const color = this.statusBanner.level === "error"
        ? "error"
        : this.statusBanner.level === "warning"
          ? "warning"
          : "accent";
      lines.push(truncateToWidth(`  ${theme.fg(color, `${icon} ${this.statusBanner.text}`)}`, width));
    }

    // ── Footer legend + context-aware hints ──
    const legend = `  ${theme.fg("success", "P")}=${theme.fg("dim", "project")}  ${theme.fg("accent", "G")}=${theme.fg("dim", "global")}  ${theme.fg("warning", "E")}=${theme.fg("dim", "env")}  ${theme.fg("dim", "D")}=${theme.fg("dim", "default")}`;
    lines.push(truncateToWidth(legend, width));
    const hints = this.focusPane === "sidebar"
      ? `  ↑↓/jk category · →/l/Enter items · / search · Tab: ${otherScope} · Esc close`
      : `  ← sidebar · ↑↓ navigate · Type to search all · Tab: ${otherScope} · Enter edit · Del remove · Esc close`;
    lines.push(truncateToWidth(theme.fg("dim", hints), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Main command handler ────────────────────────────────────────

async function openSettingsTui(ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
  log.info("settings_opened");
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/pi-config-settings requires TUI mode", "error");
    return;
  }

  const editScope: SettingsScope = "project";
  const cwd = ctx.cwd;
  const modelRegistry = ctx.modelRegistry;

  // Clear cached settings so TUI always shows fresh values
  clearSettingsCache();

  // One backup per visit, not per keystroke-saved value.
  beginSettingsEditSession();
  try {
    await ctx.ui.custom<undefined>(
      (tui, theme, _kb, done) =>
        new SettingsOverlay(
          tui,
          theme,
          cwd,
          modelRegistry,
          editScope,
          done,
          (msg, level) => ctx.ui.notify(msg, level),
          (key) => {
            try { pi?.events?.emit?.("orchestrator:settings-changed", { key, cwd }); } catch {}
          },
        ),
      OVERLAY_OPTS,
    );
  } finally {
    endSettingsEditSession();
  }
}

// ── Registration ────────────────────────────────────────────

export function registerSettingsTui(pi: ExtensionAPI): void {
  registerSettingsTuiCommand(pi, async (_args, ctx) => {
    await openSettingsTui(ctx, pi);
  });
}
