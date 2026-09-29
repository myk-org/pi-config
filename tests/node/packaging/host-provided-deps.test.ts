/**
 * Manifest guard for host-provided pi packages.
 *
 * Pi 0.99.0 warns when an extension package lists a host-provided module in
 * `dependencies` (dist/core/resource-loader.js, collectExtensionPackageWarnings).
 * A physical copy bypasses pi's extension module mapping in compiled ESM and
 * creates duplicate runtime modules, so the invariant is enforced here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Mirrors HOST_PROVIDED_EXTENSION_PACKAGES in pi's resource-loader. */
const HOST_PROVIDED = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);

const IMPORT_RE = /from\s+["']([^"'.][^"']*)["']/g;

interface PackageUnderTest {
	manifest: string;
	sources: string[];
}

interface Manifest {
	name: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

const PACKAGES: PackageUnderTest[] = [
	{ manifest: "package.json", sources: ["extensions", "scripts"] },
	{ manifest: "packages/pi-vertex-claude/package.json", sources: ["packages/pi-vertex-claude"] },
];

/** Bare specifiers imported by a package's TypeScript sources. */
function importedHostPackages(sources: string[]): Set<string> {
	const found = new Set<string>();
	for (const source of sources) {
		for (const entry of readdirSync(join(repoRoot, source), {
			recursive: true,
			encoding: "utf-8",
			withFileTypes: true,
		})) {
			const parent = entry.parentPath ?? source;
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			// node_modules holds third-party declarations we did not author
			if (parent.split(/[/\\]/).includes("node_modules")) continue;
			const code = readFileSync(join(parent, entry.name), "utf-8");
			for (const match of code.matchAll(IMPORT_RE)) {
				const specifier = match[1];
				if (HOST_PROVIDED.has(specifier)) found.add(specifier);
			}
		}
	}
	return found;
}

describe("host-provided pi packages", () => {
	for (const { manifest: manifestPath, sources } of PACKAGES) {
		const manifest = JSON.parse(
			readFileSync(join(repoRoot, manifestPath), "utf-8"),
		) as Manifest;
		const imported = importedHostPackages(sources);

		it(`${manifest.name} declares no host-provided package in dependencies`, () => {
			const offenders = Object.keys(manifest.dependencies ?? {}).filter(
				(name) => HOST_PROVIDED.has(name),
			);
			assert.deepEqual(
				offenders,
				[],
				`move ${offenders.join(", ")} to peerDependencies with a "*" range — a physical copy bypasses the extension loader`,
			);
		});

		it(`${manifest.name} declares every host-provided package it imports as a peer with "*"`, () => {
			assert.ok(imported.size > 0, "expected the sources to import at least one host package");
			for (const name of imported) {
				assert.equal(
					manifest.peerDependencies?.[name],
					"*",
					`${name} is imported but not declared in peerDependencies with a "*" range`,
				);
			}
		});
	}
});
