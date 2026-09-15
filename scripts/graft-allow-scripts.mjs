#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger } from "../extensions/shared/install-logger.mjs";

const installHooks = ["preinstall", "install", "postinstall"];
const seen = new Set();
const allowed = new Set();

const installRoot = realpathSync(process.argv[3]);

const log = createLogger("graft-install");

function resolveDependency(packageDir, name) {
  let attempts = 0;
  for (let directory = packageDir; directory.startsWith(installRoot); directory = dirname(directory)) {
    attempts += 1;
    const dependency = directory === installRoot ? join(directory, name) : join(directory, "node_modules", name);
    if (existsSync(dependency) && !relative(installRoot, dependency).startsWith("..")) {
      log.debug({ event: "dependency_resolved", dependency: name, attempts });
      return dependency;
    }
    if (directory === installRoot) break;
  }
  log.debug({ event: "dependency_unresolved", dependency: name, attempts });
}

function inspect(packageDir) {
  const real = realpathSync(packageDir);
  if (seen.has(real)) return;
  seen.add(real);
  const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};
  if (installHooks.some(hook => scripts[hook]) || !("install" in scripts) && existsSync(join(real, "binding.gyp"))) allowed.add(manifest.name);
  const optional = manifest.optionalDependencies ?? {};
  for (const name of Object.keys({ ...manifest.dependencies, ...optional })) {
    const dependency = resolveDependency(real, name);
    if (!dependency) {
      if (name in optional) continue;
      throw new Error(`required Graft dependency is not installed: ${name}`);
    }
    inspect(dependency);
  }
}

inspect(process.argv[2]);
process.stdout.write([...allowed].sort().join(","));
