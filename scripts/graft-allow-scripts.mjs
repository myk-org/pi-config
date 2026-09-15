#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const installHooks = ["preinstall", "install", "postinstall"];
const seen = new Set();
const allowed = new Set();

const root = process.argv[2].split("/node_modules/", 1)[0] + "/node_modules";

function inspect(packageDir) {
  const real = realpathSync(packageDir);
  if (seen.has(real)) return;
  seen.add(real);
  const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};
  if (installHooks.some(hook => scripts[hook]) || !("install" in scripts) && existsSync(join(real, "binding.gyp"))) allowed.add(manifest.name);
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    let dependency = join(real, "node_modules", name);
    try { realpathSync(dependency); } catch { dependency = join(root, name); }
    inspect(dependency);
  }
}

inspect(process.argv[2]);
process.stdout.write([...allowed].sort().join(","));
