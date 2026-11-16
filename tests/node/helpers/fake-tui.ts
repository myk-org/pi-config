/**
 * The TUI / Theme / KeybindingsManager fakes every overlay harness needs, typed once.
 *
 * All three are classes with private state, so a structural fake cannot satisfy them; the single
 * cast per fake lives here instead of in each test (and each test used to invent its own). The
 * members below are the ones the overlay components actually call — `theme.fg`, `theme.bold`,
 * `tui.terminal.rows`, `tui.requestRender`, `keybindings.matches`.
 */
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** A theme that renders text unchanged, i.e. what an assertion on a rendered frame expects. */
export function fakeTheme(options: { fg?: (color: string, value: string) => string } = {}): Theme {
	const fg = options.fg ?? ((_color: string, value: string) => value);
	return { fg, bold: (value: string) => value } as unknown as Theme;
}

/** A TUI with a fixed terminal height and a no-op render request. */
export function fakeTui(options: { rows?: number; requestRender?: () => void } = {}): TUI {
	return {
		terminal: { rows: options.rows ?? 20 },
		requestRender: options.requestRender ?? (() => {}),
	} as unknown as TUI;
}

/** `tui.select.cancel` on `close` is the keybinding the overlay dashboards really check, so a
 *  test that presses a key the overlay ignores still closes instead of hanging the suite. */
export function fakeKeybindings(
	matches: (data: string, action: string) => boolean = (data, action) => action === "tui.select.cancel" && data === "close",
): KeybindingsManager {
	return { matches } as unknown as KeybindingsManager;
}
