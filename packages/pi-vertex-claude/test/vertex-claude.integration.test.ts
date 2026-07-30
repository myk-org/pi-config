import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

let streamVertexClaude: typeof import("../index.js").streamVertexClaude;

function hasAdcCredentials(): boolean {
	const adcPath =
		process.env.GOOGLE_APPLICATION_CREDENTIALS ??
		join(homedir(), ".config", "gcloud", "application_default_credentials.json");
	return existsSync(adcPath);
}

const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION;
const shouldRun = !!project && !!location && hasAdcCredentials();

describe.skipIf(!shouldRun)("Vertex Claude integration (ADC)", () => {
	beforeAll(async () => {
		vi.resetModules();
		vi.doUnmock("@earendil-works/pi-ai");
		const module = await import("../index.js");
		streamVertexClaude = module.streamVertexClaude;
	});

	it("streams a response", async () => {
		const model = {
			id: "claude-3-5-haiku@20241022",
			name: "Claude 3.5 Haiku (Vertex)",
			api: "vertex-claude-api",
			provider: "google-vertex-claude",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		} as const;

		const context = {
			messages: [{ role: "user", content: "Say hello in one sentence." }],
		};

		const stream = streamVertexClaude(model as any, context as any, { maxTokens: 64 });
		let sawDone = false;

		for await (const event of stream) {
			if (event.type === "done") {
				sawDone = true;
				break;
			}
			if (event.type === "error") {
				const message = event.error.errorMessage || "Vertex Claude stream error";
				throw new Error(message);
			}
		}

		expect(sawDone).toBe(true);
	});
});
