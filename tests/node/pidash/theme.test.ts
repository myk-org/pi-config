/**
 * Theme selection is untested storage + document mutation (Qodo 694e713b).
 *
 * Every one of these paths can silently regress into "light theme on a dark
 * default", "choice forgotten after reload", or "blocked localStorage crashes
 * the boot" — none of which any other test in the suite would notice.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

type ThemeModule = typeof import("../../../extensions/pidash/pidash-ui/src/lib/theme.ts");

const STORAGE_KEY = "pidash-theme";

/** Minimal localStorage that can be made to throw, like a blocked origin. */
class FakeStorage {
  private readonly map = new Map<string, string>();
  constructor(private readonly throwOn: "get" | "set" | null = null) {}
  getItem(key: string): string | null {
    if (this.throwOn === "get") throw new Error("storage blocked");
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOn === "set") throw new Error("quota exceeded");
    this.map.set(key, value);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  raw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

function installDocument() {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const doc = {
    documentElement: {
      classList: {
        toggle(name: string, force?: boolean) {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
        contains(name: string) {
          return classes.has(name);
        },
      },
      style,
    },
  };
  (globalThis as Record<string, unknown>).document = doc;
  return { classes, style };
}

let theme: ThemeModule;

async function loadThemeModule(storage: FakeStorage): Promise<ThemeModule> {
  (globalThis as Record<string, unknown>).localStorage = storage;
  // Cache-busting query keeps each test on a fresh module instance.
  return (await import(
    `../../../extensions/pidash/pidash-ui/src/lib/theme.ts?case=${Math.random()}`
  )) as ThemeModule;
}

const originalDocument = (globalThis as Record<string, unknown>).document;
const originalStorage = (globalThis as Record<string, unknown>).localStorage;

beforeEach(() => {
  installDocument();
});
afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).localStorage = originalStorage;
});

describe("pidash theme", () => {
  it("defaults to dark when nothing is stored", async () => {
    theme = await loadThemeModule(new FakeStorage());
    assert.equal(theme.loadTheme(), "dark");
  });

  it("reads a persisted light choice", async () => {
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, "light");
    theme = await loadThemeModule(storage);
    assert.equal(theme.loadTheme(), "light");
  });

  it("treats an unknown stored value as dark", async () => {
    const storage = new FakeStorage();
    storage.setItem(STORAGE_KEY, "solarized");
    theme = await loadThemeModule(storage);
    assert.equal(theme.loadTheme(), "dark");
  });

  it("applyTheme toggles the dark class and the color scheme", async () => {
    theme = await loadThemeModule(new FakeStorage());
    const { classes, style } = installDocument();

    theme.applyTheme("light");
    assert.equal(classes.has("dark"), false);
    assert.equal(style.colorScheme, "light");

    theme.applyTheme("dark");
    assert.equal(classes.has("dark"), true);
    assert.equal(style.colorScheme, "dark");

    // idempotent: applying twice leaves the same state
    theme.applyTheme("dark");
    assert.equal(classes.has("dark"), true);
  });

  it("saveTheme persists the choice", async () => {
    const storage = new FakeStorage();
    theme = await loadThemeModule(storage);
    theme.saveTheme("light");
    assert.equal(storage.raw(STORAGE_KEY), "light");
  });

  it("setTheme applies AND persists", async () => {
    const storage = new FakeStorage();
    theme = await loadThemeModule(storage);
    const { classes } = installDocument();
    theme.setTheme("light");
    assert.equal(classes.has("dark"), false);
    assert.equal(storage.raw(STORAGE_KEY), "light");
  });

  it("survives blocked storage on read (defaults to dark)", async () => {
    theme = await loadThemeModule(new FakeStorage("get"));
    assert.equal(theme.loadTheme(), "dark");
  });

  it("survives blocked storage on write (theme still applies)", async () => {
    theme = await loadThemeModule(new FakeStorage("set"));
    const { classes } = installDocument();
    assert.doesNotThrow(() => theme.setTheme("light"));
    assert.equal(classes.has("dark"), false, "document still mutated");
  });
});
