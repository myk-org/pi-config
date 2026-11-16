/**
 * A complete `Model` for tests that hand a model to production code.
 *
 * `Model` carries a dozen required fields (cost tables, input modalities, context limits) that
 * a test does not care about, so the defaults live here once instead of being re-cast at every
 * call site. Overrides are typed, so a test that invents a field the real `Model` does not have
 * fails to compile.
 */
import type { Model } from "@earendil-works/pi-ai";

export function fakeModel(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "native",
		baseUrl: "http://localhost",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
		reasoning: false,
		...overrides,
	} as Model<any>;
}
