/**
 * Line-item pricing — the arithmetic behind "Dynamic Invoice Generation"
 * (docs/BMS_EXTENSION.md §2.2: base pricing, duration multipliers, add-ons).
 *
 * Deliberately pure and database-free. Every number an invoice shows is
 * produced here, so this is the file to read when a total looks wrong, and the
 * file to test when the rules change.
 *
 * Four things matter enough to call out:
 *
 *   - **Money is integer minor units, everywhere** (docs/BACKEND.md §2). No
 *     float arithmetic touches a total. Rates on a record are authored in
 *     *major* units, because that is what a human types into a form —
 *     `hourly_rate: 150` means €150.00 — so `toMinor` is the single boundary
 *     where that becomes 15000, and it rounds once, at the edge.
 *   - **Duration is billed in whole units, rounded up.** Four hours and one
 *     minute of a boat is five billable hours. Rounding down would let a
 *     customer take an extra 59 minutes for free; rounding to nearest would
 *     make the boundary a coin toss nobody can explain to a customer.
 *   - **A line item stores its own computed amount.** `amountMinor` is written
 *     onto the item rather than recomputed on read, so an invoice issued last
 *     March still says what it said last March even after the boat's rate
 *     changes. Recomputation on read is how historical documents start lying.
 *   - **Percentage deposits round down.** A 30% deposit on €99.99 is €29.99,
 *     not €30.00: the deposit is a part of a total, and a part that rounds up
 *     can exceed a sequence of parts that must sum to the whole.
 */
import { z } from "zod";
import { AppError } from "@/server/http/envelope";

/**
 * ISO 4217, uppercase. Not an enum of "the currencies we support": the tenant's
 * currency is chosen during onboarding from a far longer list, and hard-coding
 * a subset here would silently refuse a legitimate business.
 */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Expected a three-letter ISO 4217 currency code");

/**
 * What a line item is *for*. Kept coarse: this drives grouping and sign, not
 * accounting categories, which are a tenant concern and belong in their own
 * entity if they are ever needed.
 */
export const LINE_ITEM_KINDS = ["resource", "addon", "fee", "discount"] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];

/**
 * How a resource's base rate is expressed on its record. Read from the
 * record's own data, so a tenant that never sets one gets a zero-rated line
 * rather than a crash — a booking system that refuses to record a booking
 * because nobody filled in a price is worse than one that shows €0.00.
 */
export const RATE_KEYS = {
  hourly: "hourly_rate",
  daily: "daily_rate",
  flat: "flat_rate",
} as const;

export type RateBasis = keyof typeof RATE_KEYS;

export const lineItemSchema = z.object({
  kind: z.enum(LINE_ITEM_KINDS),
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().positive().max(100_000),
  /** Minor units. Negative only for a `discount`. */
  unitAmountMinor: z.number().int().min(-100_000_000).max(100_000_000),
  amountMinor: z.number().int(),
  /** Where the line came from, when it came from the inventory engine. */
  poolId: z.string().optional(),
  allocationId: z.string().optional(),
  recordId: z.string().optional(),
});

export type LineItem = z.infer<typeof lineItemSchema>;

/** A line item as a caller may supply it — the amount is ours to compute. */
export const lineItemInputSchema = lineItemSchema
  .omit({ amountMinor: true })
  .extend({ quantity: z.number().int().positive().max(100_000).default(1) });

export type LineItemInput = z.input<typeof lineItemInputSchema>;

const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Major units (what a human authored) to minor units (what we store).
 *
 * Rounds to the nearest minor unit exactly once. A rate of `12.345` is not a
 * price anyone means to charge, so it becomes 1235 rather than being refused —
 * but it happens here, at the single boundary, and never again downstream.
 *
 * Currencies without minor units (JPY, KRW) are deliberately *not* special-
 * cased: doing so correctly needs a currency-exponent table, and a wrong table
 * is worse than a consistent one. Amounts are stored in hundredths throughout;
 * a zero-decimal currency is a display concern.
 */
export function toMinor(major: number): number {
  if (!Number.isFinite(major)) {
    throw new AppError("VALIDATION_FAILED", "A price must be a finite number");
  }
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

export const toMajor = (minor: number): number => minor / MINOR_UNITS_PER_MAJOR;

/** Reads a rate off a record's `data`, tolerating a string a form produced. */
export function rateFromRecord(data: Record<string, unknown>, basis: RateBasis): number | null {
  const raw = data[RATE_KEYS[basis]];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Whole billable units of a booking, rounded **up** — see the module docs.
 * A zero-length range is one unit, not zero: someone still took the resource
 * off the market.
 */
export function billableUnits(startAt: Date, endAt: Date, basis: RateBasis): number {
  if (basis === "flat") return 1;
  const ms = Math.max(0, endAt.getTime() - startAt.getTime());
  const perUnit = basis === "hourly" ? 3_600_000 : 86_400_000;
  return Math.max(1, Math.ceil(ms / perUnit));
}

/** The single place `amountMinor` is derived, so it is derived one way. */
export const amountFor = (quantity: number, unitAmountMinor: number): number =>
  quantity * unitAmountMinor;

export function toLineItem(input: LineItemInput): LineItem {
  const parsed = lineItemInputSchema.parse(input);
  if (parsed.kind !== "discount" && parsed.unitAmountMinor < 0) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { unitAmountMinor: "Only a discount line may be negative" },
    });
  }
  if (parsed.kind === "discount" && parsed.unitAmountMinor > 0) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { unitAmountMinor: "A discount must be negative" },
    });
  }
  return { ...parsed, amountMinor: amountFor(parsed.quantity, parsed.unitAmountMinor) };
}

/**
 * The resource line for one booking: base rate × duration × quantity, as
 * §2.2's "Entity Base Pricing, duration multipliers, and add-ons" describes.
 *
 * The description is built here rather than by the caller so every invoice in
 * the system words the same thing the same way — "24ft Pontoon Boat × 4 hours"
 * — which is what makes a list of them scannable.
 */
export function resourceLineItem(input: {
  name: string;
  data: Record<string, unknown>;
  basis: RateBasis;
  startAt: Date;
  endAt: Date;
  /** How many of a pooled resource; always 1 for an individual asset. */
  quantity?: number;
  poolId?: string;
  allocationId?: string;
  recordId?: string;
}): LineItem {
  const units = billableUnits(input.startAt, input.endAt, input.basis);
  const rate = rateFromRecord(input.data, input.basis) ?? 0;
  const quantity = input.quantity ?? 1;

  // The *unit* is one booking of this resource for its whole duration, so the
  // duration multiplier lives in the unit price and `quantity` stays "how
  // many of them". An invoice that read "4 × €150" for a 4-hour hire of one
  // boat and "4 × €150" for a 1-hour hire of four boats would be ambiguous.
  const unitAmountMinor = toMinor(rate) * units;

  return {
    kind: "resource",
    description: describeResource(input.name, units, input.basis),
    quantity,
    unitAmountMinor,
    amountMinor: amountFor(quantity, unitAmountMinor),
    ...(input.poolId ? { poolId: input.poolId } : {}),
    ...(input.allocationId ? { allocationId: input.allocationId } : {}),
    ...(input.recordId ? { recordId: input.recordId } : {}),
  };
}

function describeResource(name: string, units: number, basis: RateBasis): string {
  if (basis === "flat") return name;
  const noun = basis === "hourly" ? "hour" : "day";
  return `${name} — ${units} ${noun}${units === 1 ? "" : "s"}`;
}

export type Totals = {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
};

/**
 * Totals over a whole line-item list. Discounts are already negative, so the
 * total is a plain sum; `discountMinor` is reported separately (as a positive
 * number) only because an invoice wants to show it on its own row.
 */
export function totalsFor(items: readonly LineItem[]): Totals {
  let subtotalMinor = 0;
  let discountMinor = 0;
  for (const item of items) {
    if (item.kind === "discount") discountMinor += -item.amountMinor;
    else subtotalMinor += item.amountMinor;
  }
  return {
    subtotalMinor,
    discountMinor,
    // Never below zero: a discount larger than the order is a data error, and
    // a negative total would become a refund nobody authorised.
    totalMinor: Math.max(0, subtotalMinor - discountMinor),
  };
}

export const depositSchema = z
  .object({
    /** Whole percent of the total. Mutually exclusive with `amountMinor`. */
    percent: z.number().int().min(1).max(100).optional(),
    /** A fixed deposit in minor units. */
    amountMinor: z.number().int().positive().optional(),
  })
  .refine((v) => (v.percent === undefined) !== (v.amountMinor === undefined), {
    message: "Specify either a percent or a fixed amount, not both",
  });

export type DepositInput = z.infer<typeof depositSchema>;

/**
 * The upfront half of §2.2's "Split & Deposit Payments". Rounds **down** (see
 * the module docs) and never exceeds the total — a deposit larger than the
 * order would leave a balance owed to the customer at confirmation time.
 */
export function depositFor(totalMinor: number, deposit: DepositInput | null): number {
  if (!deposit) return 0;
  const raw =
    deposit.percent !== undefined
      ? Math.floor((totalMinor * deposit.percent) / 100)
      : deposit.amountMinor!;
  return Math.min(Math.max(0, raw), totalMinor);
}

/** What is still owed after everything recorded as paid. Never negative. */
export const balanceMinor = (totalMinor: number, amountPaidMinor: number): number =>
  Math.max(0, totalMinor - amountPaidMinor);

/**
 * Display only — never used to compute anything. `Intl` is asked for the
 * currency's own formatting so a total reads the way the tenant's customers
 * expect, rather than being assembled from a symbol table we would maintain.
 */
export function formatMoney(minor: number, currency: string, locale = "en-IE"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(toMajor(minor));
}
