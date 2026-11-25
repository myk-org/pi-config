/**
 * Compile-time regression guard (#1394) checked by `npm run typecheck` via
 * `packages/pi-vertex-claude/tsconfig.json`.
 *
 * Ensures `streamVertexClaude` stays assignable to a `ProviderConfig.streamSimple`
 * whose `TranscriptContext` carries a foreign `unique symbol` brand (simulating
 * duplicate `@earendil-works/pi-ai` installs). Restoring a branded `TranscriptContext`
 * parameter on `streamVertexClaude` makes `npm run typecheck` fail with TS2322.
 */
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { streamVertexClaude } from "../index.ts";

declare const foreignTranscriptContextBrand: unique symbol;

type ForeignTranscriptContext = {
	messages: TranscriptContext["messages"];
	readonly [foreignTranscriptContextBrand]: true;
};

type ForeignProviderStreamSimple = (
	model: Parameters<typeof streamVertexClaude>[0],
	context: ForeignTranscriptContext,
	options?: Parameters<typeof streamVertexClaude>[2],
) => ReturnType<typeof streamVertexClaude>;

export const verifyForeignTranscriptContextAssignable = (
	fn: typeof streamVertexClaude,
): ForeignProviderStreamSimple => fn;
