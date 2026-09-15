import { createLogger } from "./create-logger";

const log = createLogger("format-total");

export function formatCompactTotal(value: number | undefined): string | undefined {
  const path = value === undefined ? "absent" : value < 1_000 ? "exact" : "compact";
  log.debug("formatCompactTotal", path);
  if (value === undefined) return undefined;
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value).replace("K", "k");
}

export function formatExactTotal(value: number | undefined): string | undefined {
  log.debug("formatExactTotal", value === undefined ? "absent" : "present");
  return value?.toLocaleString("en-US");
}
