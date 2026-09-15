export function formatCompactTotal(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value).replace("K", "k");
}

export function formatExactTotal(value: number | undefined): string | undefined {
  return value?.toLocaleString("en-US");
}
