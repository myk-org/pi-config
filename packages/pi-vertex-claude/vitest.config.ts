import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const piMonoRoot = process.env.PI_MONO_ROOT;
const alias = piMonoRoot
	? { "@earendil-works/pi-ai": resolve(piMonoRoot, "packages/ai/src/index.ts") }
	: {};

export default defineConfig({
	resolve: {
		alias,
	},
	test: {
		isolate: true,
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
});
