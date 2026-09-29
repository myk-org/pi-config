/**
 * Guard against publishing a lockfile from a library package.
 *
 * `@myk-org/pi-sidecar` shipped `npm-shrinkwrap.json` in its tarball. npm honours a
 * shipped shrinkwrap, so consumers never re-resolved their transitive tree and kept
 * installing the versions the shrinkwrap pinned — here `pi-orchestrator-config@4.3.14`,
 * `transformers@4.2.0`, `adm-zip@0.6.0` and `sharp@0.34.5`, all carrying open
 * advisories. The package.json looked correct from our side while the lockfile
 * silently overrode it.
 *
 * A shrinkwrap or lockfile belongs to an application. A library must never publish one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../../extensions/shared/logger.ts";

const log = createLogger("packaging-test");

// tests/node/packaging -> repo root
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** Filenames that pin a resolved dependency tree. */
const LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

interface Manifest {
	name: string;
	files?: string[];
}

/** Every workspace package that gets published to a registry. */
const PUBLISHED_MANIFESTS = [
	"package.json",
	"packages/pi-sidecar/package.json",
	"packages/pi-vertex-claude/package.json",
];

describe("published package lockfiles", () => {
	for (const manifestPath of PUBLISHED_MANIFESTS) {
		const manifest = JSON.parse(
			readFileSync(join(repoRoot, manifestPath), "utf-8"),
		) as Manifest;

		it(`${manifest.name} publishes no lockfile`, () => {
			const shipped = (manifest.files ?? []).filter((entry) => {
				const bare = entry.replace(/^!/, "").replace(/^\.\//, "");
				return LOCKFILES.includes(bare);
			});
			log.debug("checked manifest files for lockfiles", { manifestPath, shipped });
			assert.deepEqual(
				shipped,
				[],
				`remove ${shipped.join(", ")} from files — a published lockfile pins consumers' transitive tree and silently overrides this package's own manifests`,
			);
		});
	}
});
