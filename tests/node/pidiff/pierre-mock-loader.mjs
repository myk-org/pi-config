import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const repo = join(dir, "../../..");
const uiSrc = join(repo, "extensions/pidiff/pidiff-ui/src");
const sharedUi = join(repo, "extensions/shared/ui");

const mocks = {
  "@pierre/diffs/react": pathToFileURL(join(dir, "mocks/pierre-diffs-react.mjs")).href,
  "@pierre/trees/react": pathToFileURL(join(dir, "mocks/pierre-trees-react.mjs")).href,
  "@pierre/trees": pathToFileURL(join(dir, "mocks/pierre-trees.mjs")).href,
  "@ui/button": pathToFileURL(join(dir, "mocks/ui-button.mjs")).href,
  "@ui/separator": pathToFileURL(join(dir, "mocks/ui-separator.mjs")).href,
  "@/components/ui/switch": pathToFileURL(join(dir, "mocks/ui-switch.mjs")).href,
};

function existingFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function aliasUrl(specifier) {
  let base;
  if (specifier.startsWith("@/")) base = join(uiSrc, specifier.slice(2));
  else if (specifier.startsWith("@ui/")) base = join(sharedUi, specifier.slice(4));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existingFile(c)) return pathToFileURL(c).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const mapped = mocks[specifier];
  if (mapped) return { shortCircuit: true, url: mapped };
  const aliased = aliasUrl(specifier);
  if (aliased) return { shortCircuit: true, url: aliased };
  return nextResolve(specifier, context);
}
