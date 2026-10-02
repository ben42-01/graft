/**
 * How the BMS screens write money and dates — one place, so the board, the
 * order page and the customer list cannot disagree about what €12.50 looks
 * like.
 */

/** Minor units to a localised amount. An unknown currency code must not blank
 * a whole screen, so it falls back to a plain number and the code. */
export function formatMoney(
  minor: number,
  currency: string | null | undefined,
  options: { whole?: boolean } = {},
): string {
  const digits = options.whole ? 0 : 2;
  if (!currency) return (minor / 100).toFixed(digits);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      ...(options.whole ? { maximumFractionDigits: 0 } : {}),
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(digits)} ${currency}`;
  }
}

export function formatDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3 hours ago" — for feeds, where recency matters more than the clock. */
export function formatRelative(iso: string | Date, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

/** A short, human-sayable handle for an order — the tail of its id. */
export const orderNumber = (id: string): string => `#${id.slice(-6).toUpperCase()}`;
