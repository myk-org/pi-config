/**
 * Env for a test, controlled by the test — never inherited from the shell.
 *
 * `registerSubagentTool` early-returns when `PI_SUBAGENT_CHILD === "1"` (a child must not
 * spawn subagents), and so do a dozen other extensions. A suite that asserts parent
 * behaviour inherits the skipped registration whenever the ambient shell is itself a
 * subagent child, and the failure shows up as `undefined.execute` 20 tests later instead of
 * "the tool was never registered".
 *
 * Synchronous setup only: sets or deletes the variable, runs `fn`, then restores the
 * previous value immediately, including on throw. Async work is unsupported: this
 * process-global scope must never span an await or launch work that relies on it later.
 * `undefined` rather than `void` rejects Promise-returning callbacks in typed callers;
 * it cannot prevent detached async work or callers that bypass the type contract.
 */
export function withSubagentChildEnv(value: string | undefined, fn: () => undefined): void {
	const previous = process.env.PI_SUBAGENT_CHILD;
	if (value === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = value;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
}
