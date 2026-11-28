/**
 * WCAG AAA dark-theme contrast contract for PiDash and PiDiff (#1528).
 *
 * Ensures the rootcoz-aligned dark tokens in pidash-ui (.dark) and pidiff-ui
 * (:root) keep secondary/muted text at >= 7.0 contrast on all dark surfaces
 * while leaving pidash-ui light mode (:root) intact.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PIDASH_CSS_PATH = resolve(REPO_ROOT, "extensions/pidash/pidash-ui/src/styles.css");
const PIDIFF_CSS_PATH = resolve(REPO_ROOT, "extensions/pidiff/pidiff-ui/src/styles.css");
const SESSION_SIDEBAR_PATH = resolve(
  REPO_ROOT,
  "extensions/pidash/pidash-ui/src/components/SessionSidebar.tsx",
);
const INFO_BAR_PATH = resolve(
  REPO_ROOT,
  "extensions/pidash/pidash-ui/src/components/InfoBar.tsx",
);

const WCAG_AAA_RATIO = 7.0;

function extractCssBlock(css: string, selector: ":root" | ".dark"): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(".", "\\.");
  const blockMatch = withoutComments.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(blockMatch, `Expected ${selector} block in stylesheet`);

  const tokens: Record<string, string> = {};
  for (const match of blockMatch[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function parseHexRgb(hex: string): [number, number, number] {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  assert.ok(match, `Expected 6-digit hex color, got "${hex}"`);
  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ];
}

function srgbToLinear(channel255: number): number {
  const srgb = channel255 / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const pidashCss = readFileSync(PIDASH_CSS_PATH, "utf8");
const pidiffCss = readFileSync(PIDIFF_CSS_PATH, "utf8");
const pidashLight = extractCssBlock(pidashCss, ":root");
const pidashDark = extractCssBlock(pidashCss, ".dark");
const pidiffDark = extractCssBlock(pidiffCss, ":root");

const SHARED_DARK_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
] as const;

describe("pidash dark theme contrast", () => {
  it("meets WCAG AAA contrast for --muted-foreground on --background", () => {
    const ratio = contrastRatio(pidashDark["--muted-foreground"], pidashDark["--background"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("meets WCAG AAA contrast for --muted-foreground on --card", () => {
    const ratio = contrastRatio(pidashDark["--muted-foreground"], pidashDark["--card"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("meets WCAG AAA contrast for --muted-foreground on --muted", () => {
    const ratio = contrastRatio(pidashDark["--muted-foreground"], pidashDark["--muted"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("meets WCAG AAA contrast for --secondary-foreground on --secondary", () => {
    const ratio = contrastRatio(pidashDark["--secondary-foreground"], pidashDark["--secondary"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("meets WCAG AAA contrast for --foreground on --background", () => {
    const ratio = contrastRatio(pidashDark["--foreground"], pidashDark["--background"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("uses rootcoz border token in dark mode", () => {
    assert.equal(pidashDark["--border"], "#30363d");
    assert.equal(pidashDark["--sidebar-border"], "#30363d");
  });

  it("preserves light mode :root surface token in pidash-ui", () => {
    assert.equal(pidashLight["--background"], "oklch(1 0 0)");
    assert.equal(pidashLight["--foreground"], "oklch(0.145 0 0)");
  });

  it("preserves light mode :root muted text token in pidash-ui", () => {
    assert.equal(pidashLight["--muted-foreground"], "oklch(0.556 0 0)");
  });
});

describe("pidiff dark theme contrast", () => {
  it("meets WCAG AAA contrast for --muted-foreground on --background", () => {
    const ratio = contrastRatio(pidiffDark["--muted-foreground"], pidiffDark["--background"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("meets WCAG AAA contrast for --muted-foreground on --card", () => {
    const ratio = contrastRatio(pidiffDark["--muted-foreground"], pidiffDark["--card"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("meets WCAG AAA contrast for --muted-foreground on --muted", () => {
    const ratio = contrastRatio(pidiffDark["--muted-foreground"], pidiffDark["--muted"]);
    assert.ok(
      ratio >= WCAG_AAA_RATIO,
      `Expected ratio >= ${WCAG_AAA_RATIO}, got ${ratio.toFixed(2)}`,
    );
  });

  it("keeps pidiff :root dark palette synced with pidash .dark tokens", () => {
    for (const token of SHARED_DARK_TOKENS) {
      assert.equal(
        pidiffDark[token],
        pidashDark[token],
        `Expected pidiff ${token} to match pidash .dark`,
      );
    }
  });
});

describe("pidash component opacity dimmers", () => {
  it("avoids sub-50% opacity dimming on inactive session rows", () => {
    const sidebarSource = readFileSync(SESSION_SIDEBAR_PATH, "utf8");
    assert.doesNotMatch(sidebarSource, /\bopacity-35\b/);
    assert.match(sidebarSource, /!s\.active\s*&&\s*"opacity-65"/);
  });

  it("avoids /50 muted text dimmers on InfoBar status counters", () => {
    const infoBarSource = readFileSync(INFO_BAR_PATH, "utf8");
    assert.doesNotMatch(infoBarSource, /text-muted-foreground\/50/);
  });
});
