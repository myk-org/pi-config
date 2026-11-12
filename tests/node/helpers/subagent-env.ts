/**
 * Env for a test, controlled by the test — never inherited from the shell.
 *
 * `registerSubagentTool` early-returns when `PI_SUBAGENT_CHILD === "1"` (a child must not
 * spawn subagents), and so do a dozen other extensions. A suite that asserts parent
 * behaviour inherits the skipped registration whenever the ambient shell is itself a
 * subagent child, and the failure shows up as `undefined.execute` 20 tests later instead of
 * "the tool was never registered".
 *
 * Sets the variable (or deletes it for `undefined`), runs `fn`, and restores the PREVIOUS
 * value. `fn` may be sync or async; an async `fn` is restored only after it settles, so the
 * value cannot leak into whatever runs next.
 */
export function withSubagentChildEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T>;
export function withSubagentChildEnv<T>(value: string | undefined, fn: () => T): T;
export function withSubagentChildEnv<T>(value: string | undefined, fn: () => T | Promise<T>): T | Promise<T> {
	const previous = process.env.PI_SUBAGENT_CHILD;
	const restore = () => {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	};
	if (value === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = value;
	let result: T | Promise<T>;
	try {
		result = fn();
	} catch (error) {
		restore();
		throw error;
	}
	if (result && typeof (result as Promise<T>).then === "function") return (result as Promise<T>).finally(restore);
	restore();
	return result;
}
