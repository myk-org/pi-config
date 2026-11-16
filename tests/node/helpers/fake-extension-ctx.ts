/**
 * A `ctx` for tests of UI-bearing commands and handlers.
 *
 * `ExtensionCommandContext` is large (session manager, model registry, twenty UI methods), and the
 * extension code under test reads only a few of them. The UI members a caller passes are typed by
 * the real `ExtensionUIContext`, so a handler that changes how it calls `ui.notify` / `ui.custom`
 * / `ui.input` fails to compile against these fakes instead of silently drifting.
 */
import type {
	ExtensionCommandContext,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { fakeKeybindings, fakeTheme, fakeTui } from "./fake-tui.js";

export function fakeCommandCtx(
	ui: Partial<ExtensionUIContext>,
	options: { hasUI?: boolean; cwd?: string } = {},
): ExtensionCommandContext {
	return {
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? process.cwd(),
		ui: ui as ExtensionUIContext,
	} as unknown as ExtensionCommandContext;
}

export type FakeOverlayComponent = Component & { dispose?(): void };

/** The real `ui.custom` factory, with the TUI/Theme/KeybindingsManager arguments it is given. */
export type FakeCustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => FakeOverlayComponent | Promise<FakeOverlayComponent>;

export interface FakeCustomHooks {
	/** Runs once the component is built, before any key is fed. */
	onOpen?(component: FakeOverlayComponent): void;
	/** Runs before each key is fed, with the number of keys already delivered. */
	onKey?(key: string, delivered: number, component: FakeOverlayComponent): void;
	/** Runs when the component closes, with the number of keys it had received. */
	onClose?(delivered: number): void;
}

/**
 * The body of a fake `ui.custom`: builds the component with the fakes, feeds it `keys`, and
 * resolves when the dashboard calls `done` — which is how the real dialog closes.
 *
 * Generic over `T` on purpose: `ui.custom` is generic, so a non-generic fake would have to lie
 * about the result type. Call sites write `<T,>(factory: FakeCustomFactory<T>) => fakeCustom(...)`
 * and let `satisfies ExtensionUIContext["custom"]` check the shape.
 */
export function fakeCustom<T>(
	factory: FakeCustomFactory<T>,
	keys: readonly string[],
	hooks: FakeCustomHooks = {},
): Promise<T> {
	let delivered = 0;
	let done!: (result: T) => void;
	const closed = new Promise<T>((resolve) => {
		done = (value) => {
			hooks.onClose?.(delivered);
			resolve(value);
		};
	});
	// Opened first, keys after: the dashboard closes synchronously from inside `handleInput`.
	const opened = Promise.resolve(factory(fakeTui(), fakeTheme(), fakeKeybindings(), done)).then((component) => {
		hooks.onOpen?.(component);
		for (const key of keys) {
			hooks.onKey?.(key, delivered, component);
			delivered += 1;
			component.handleInput?.(key);
		}
	});
	return opened.then(() => closed);
}
