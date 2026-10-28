/**
 * Command registration comparison.
 *
 * Discord hands back a command object with fields we never set (localizations,
 * empty choice arrays, echo booleans). Comparing raw JSON therefore reports
 * "changed" on every start, which reissues command ids — and a client caching
 * the old ids answers "This command is outdated" when tapped (live report).
 */
import { createLogger } from "../shared/logger.ts";

const log = createLogger("pidash-discord-commands");

export interface CommandComparison {
  changed: boolean;
  /** Names whose definition differs, bounded for logging. */
  differing: string[];
}

function canonicalOption(option: any): unknown {
  return {
    type: option.type ?? 3,
    name: option.name,
    description: option.description ?? "",
    required: option.required === true,
    autocomplete: option.autocomplete === true,
    choices: (option.choices ?? []).map((choice: any) => ({ name: choice.name, value: choice.value })),
    options: (option.options ?? []).map(canonicalOption),
  };
}

/**
 * The subset of a command Discord treats as its definition.
 *
 * `contexts` and `integration_types` are application-level: Discord returns them
 * for global commands and as null for guild commands. Including them for a guild
 * scope made every restart look changed, so the PUT reissued command ids and
 * clients answered "This command is outdated" (live report).
 */
export function canonicalCommandShape(command: any, options: { scopeFields?: boolean } = {}): string {
  const scopeFields = options.scopeFields ?? command.contexts != null;
  return JSON.stringify({
    name: command.name,
    description: command.description ?? "",
    type: command.type ?? 1,
    options: (command.options ?? []).map(canonicalOption),
    ...(scopeFields
      ? {
          contexts: [...(command.contexts ?? [])].sort(),
          integration_types: [...(command.integration_types ?? [])].sort(),
        }
      : {}),
    default_member_permissions: command.default_member_permissions ?? null,
  });
}

export function compareCommandPayloads(current: any[], desired: any[]): CommandComparison {
  const live = new Map<string, { shape: string; scopeFields: boolean }>();
  for (const command of current) {
    const scopeFields = command?.contexts != null;
    live.set(String(command?.name ?? "?"), { shape: canonicalCommandShape(command, { scopeFields }), scopeFields });
  }
  const wanted = new Map<string, string>();
  for (const command of desired) {
    const scopeFields = live.get(String(command?.name ?? "?"))?.scopeFields ?? true;
    wanted.set(String(command?.name ?? "?"), canonicalCommandShape(command, { scopeFields }));
  }
  const differing: string[] = [];
  for (const [name, shape] of wanted) {
    if (live.get(name)?.shape !== shape) differing.push(live.has(name) ? name : `+${name}`);
  }
  for (const name of live.keys()) {
    if (!wanted.has(name)) differing.push(`-${name}`);
  }
  if (differing.length) {
    const firstName = differing[0].replace(/^[+-]/, "");
    const liveShape = live.get(firstName)?.shape;
    const wantedShape = wanted.get(firstName);
    if (liveShape && wantedShape && liveShape !== wantedShape) {
      log.debug("command shape diff", { name: firstName, live: liveShape.slice(0, 400), wanted: wantedShape.slice(0, 400) });
    }
    log.debug("command payload differs", {
      current: current.length,
      desired: desired.length,
      added: differing.filter((name) => name.startsWith("+")).length,
      removed: differing.filter((name) => name.startsWith("-")).length,
    });
  }
  log.debug("command payload compared", { commands: current.length, differing: differing.length });
  return { changed: differing.length > 0, differing };
}
