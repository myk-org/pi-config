/**
 * Map ACPX discovery results → full createProvider Model[].
 * Kept separate from index.ts so unit tests do not load runtime/stream code.
 */

import { buildRuntimeModel } from "../shared/create-runtime-provider.js";
import {
	fillRuntimeModelFromCatalog,
	type ModelsDevCatalog,
} from "../shared/models-dev.js";

export function modelIdToDisplayName(modelId: string): string {
	// Strip bracket suffixes for display: gpt-5.4[context=272k,...] -> Gpt 5.4
	const bracketIdx = modelId.indexOf("[");
	const baseName = bracketIdx >= 0 ? modelId.substring(0, bracketIdx) : modelId;
	return baseName
		.replace(/-/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function mapAcpxDiscoveredModels(
	agent: string,
	modelIds: readonly string[],
	catalog?: ModelsDevCatalog | null,
): ReturnType<typeof buildRuntimeModel>[] {
	const provider = `acpx-${agent}`;
	if (modelIds.length === 0) {
		return [
			buildRuntimeModel({
				id: `${agent}:default`,
				name: `${agent} (default)`,
				api: "acpx",
				provider,
			}),
		];
	}
	return modelIds.map((m) =>
		buildRuntimeModel(
			fillRuntimeModelFromCatalog(
				{
					id: `${agent}:${m}`,
					name: `${modelIdToDisplayName(m)} (${agent})`,
					api: "acpx",
					provider,
				},
				catalog,
				agent,
				m,
			),
		),
	);
}
