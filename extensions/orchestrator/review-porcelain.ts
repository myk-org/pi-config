/** Normalize git status --porcelain to path-only snapshot (ignores staging indicators). */
export function normalizePorcelain(stdout: string): string {
  return stdout.split("\n").map((line) => line.slice(3)).filter(Boolean).sort().join("\n");
}
