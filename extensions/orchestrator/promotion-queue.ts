/**
 * Promotion queue — structured candidates for graduating memories into
 * skills, enforcement, or project rules.
 *
 * Storage: `.pi/memory/promotions.md` (human + agent readable).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export type PromotionDestination =
  | "memory"
  | "skill"
  | "enforcement"
  | "project_rule"
  | "discard";

export type PromotionStatus = "proposed" | "applied" | "rejected";

export interface PromotionCandidate {
  id: string;
  destination: PromotionDestination;
  text: string;
  category: string;
  reason: string;
  evidenceCount?: number;
  status: PromotionStatus;
  trigger?: string;
  action?: string;
  verifier?: string;
  skillName?: string;
  skillCreated?: boolean;
  createdAt: string;
}

const DESTINATIONS: PromotionDestination[] = [
  "memory",
  "skill",
  "enforcement",
  "project_rule",
  "discard",
];

const STATUSES: PromotionStatus[] = ["proposed", "applied", "rejected"];

export function getPromotionsPath(cwd: string): string {
  return join(cwd, ".pi", "memory", "promotions.md");
}

/** Stable id from destination + category + text (dedup key). */
export function promotionId(
  destination: PromotionDestination,
  category: string,
  text: string,
): string {
  return createHash("sha256")
    .update(`${destination}|${category}|${text}`)
    .digest("hex")
    .slice(0, 12);
}

export function formatPromotionBlock(c: PromotionCandidate): string {
  const lines = [
    `### ${c.id}`,
    `- destination: ${c.destination}`,
    `- status: ${c.status}`,
    `- category: ${c.category}`,
    `- text: ${c.text}`,
    `- reason: ${c.reason}`,
    `- created: ${c.createdAt}`,
  ];
  if (c.evidenceCount !== undefined) {
    lines.push(`- evidence_count: ${c.evidenceCount}`);
  }
  if (c.trigger) lines.push(`- trigger: ${c.trigger}`);
  if (c.action) lines.push(`- action: ${c.action}`);
  if (c.verifier) lines.push(`- verifier: ${c.verifier}`);
  if (c.skillName) lines.push(`- skill_name: ${c.skillName}`);
  if (c.skillCreated !== undefined) {
    lines.push(`- skill_created: ${c.skillCreated ? "true" : "false"}`);
  }
  return lines.join("\n") + "\n";
}

function parseField(block: string, key: string): string | undefined {
  const re = new RegExp(`^- ${key}: (.+)$`, "m");
  const m = block.match(re);
  return m?.[1]?.trim();
}

export function parsePromotionsMarkdown(content: string): PromotionCandidate[] {
  if (!content.trim()) return [];

  const chunks = content.split(/^### /m).filter((c) => c.trim());
  const results: PromotionCandidate[] = [];

  for (const chunk of chunks) {
    const lines = chunk.trim().split("\n");
    const id = lines[0]?.trim();
    if (!id) continue;

    const body = chunk;
    const destination = parseField(body, "destination") as PromotionDestination | undefined;
    const status = parseField(body, "status") as PromotionStatus | undefined;
    const category = parseField(body, "category");
    const text = parseField(body, "text");
    const reason = parseField(body, "reason");
    const createdAt = parseField(body, "created");

    if (!destination || !DESTINATIONS.includes(destination)) continue;
    if (!status || !STATUSES.includes(status)) continue;
    if (!category || !text || !reason || !createdAt) continue;

    const evidenceRaw = parseField(body, "evidence_count");
    const skillCreatedRaw = parseField(body, "skill_created");

    results.push({
      id,
      destination,
      status,
      category,
      text,
      reason,
      createdAt,
      evidenceCount: evidenceRaw !== undefined ? Number(evidenceRaw) : undefined,
      trigger: parseField(body, "trigger"),
      action: parseField(body, "action"),
      verifier: parseField(body, "verifier"),
      skillName: parseField(body, "skill_name"),
      skillCreated:
        skillCreatedRaw === undefined
          ? undefined
          : skillCreatedRaw === "true",
    });
  }

  return results;
}

export function loadPromotions(cwd: string): PromotionCandidate[] {
  const path = getPromotionsPath(cwd);
  if (!existsSync(path)) return [];
  try {
    return parsePromotionsMarkdown(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

export function writePromotions(cwd: string, candidates: PromotionCandidate[]): void {
  const path = getPromotionsPath(cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const header =
    "# Memory Promotion Queue\n\n" +
    "Candidates for graduating memories into skills, enforcement, or project rules.\n" +
    "Statuses: `proposed` → `applied` | `rejected`.\n" +
    "Never auto-write package or project rules — `project_rule` stays proposed until a human applies it.\n\n";

  const body = candidates.map(formatPromotionBlock).join("\n");
  writeFileSync(path, header + body, "utf-8");
}

/**
 * Append new candidates, skipping ids that already exist.
 * Returns how many were newly added.
 */
export function appendPromotions(
  cwd: string,
  incoming: PromotionCandidate[],
): number {
  const existing = loadPromotions(cwd);
  const seen = new Set(existing.map((c) => c.id));
  let added = 0;
  for (const c of incoming) {
    if (seen.has(c.id)) continue;
    existing.push(c);
    seen.add(c.id);
    added += 1;
  }
  if (added > 0) writePromotions(cwd, existing);
  return added;
}

export function updatePromotionStatus(
  cwd: string,
  id: string,
  status: PromotionStatus,
): boolean {
  return updatePromotionStatuses(cwd, [{ id, status }]) === 1;
}

/** Batch status updates — one load/write cycle. Returns how many ids were updated. */
export function updatePromotionStatuses(
  cwd: string,
  updates: { id: string; status: PromotionStatus }[],
): number {
  return updatePromotionCandidates(
    cwd,
    updates.map((u) => ({ id: u.id, patch: { status: u.status } })),
  );
}

/** Mutable fields only — identity keys cannot be patched. */
export type PromotionCandidatePatch = Partial<
  Omit<PromotionCandidate, "id" | "destination" | "text" | "category" | "createdAt">
>;

const IMMUTABLE_PROMOTION_KEYS = new Set([
  "id",
  "destination",
  "text",
  "category",
  "createdAt",
]);

/** Batch patch promotion candidates — one load/write. Returns how many ids were updated. */
export function updatePromotionCandidates(
  cwd: string,
  updates: { id: string; patch: PromotionCandidatePatch }[],
): number {
  if (updates.length === 0) return 0;
  const existing = loadPromotions(cwd);
  const byId = new Map(existing.map((c) => [c.id, c]));
  let n = 0;
  for (const u of updates) {
    const entry = byId.get(u.id);
    if (!entry) continue;
    const safePatch: PromotionCandidatePatch = {};
    for (const [key, value] of Object.entries(u.patch)) {
      if (IMMUTABLE_PROMOTION_KEYS.has(key)) continue;
      if (value === undefined) continue;
      (safePatch as Record<string, unknown>)[key] = value;
    }
    Object.assign(entry, safePatch);
    entry.id = u.id;
    n += 1;
  }
  if (n > 0) writePromotions(cwd, [...byId.values()]);
  return n;
}

export function listProposedPromotions(cwd: string): PromotionCandidate[] {
  return loadPromotions(cwd).filter((c) => c.status === "proposed");
}

/** Compact section for situation-report injection (~150 tokens). */
export function formatPromotionsForReport(
  cwd: string,
  maxItems: number = 5,
): string {
  const proposed = listProposedPromotions(cwd).slice(0, maxItems);
  if (proposed.length === 0) return "";

  const lines = proposed.map((c) => {
    const dest =
      c.destination === "project_rule"
        ? "project_rule (propose only)"
        : c.destination;
    return `- [${dest}] ${c.text}`;
  });

  const omitted = listProposedPromotions(cwd).length - proposed.length;
  if (omitted > 0) {
    lines.push(`- ... ${omitted} more proposed`);
  }

  return (
    `## Promotion Candidates\n` +
    `Open promotions in \`.pi/memory/promotions.md\` — apply safe ones; never auto-write package rules.\n` +
    lines.join("\n") +
    "\n"
  );
}
