/**
 * The displayed plan prices, read from `pricing.json` so a price change is a
 * one-file edit instead of a hunt through every page that shows a figure.
 *
 * Stripe is what actually charges: Checkout only ever receives a price *ID*
 * (`STRIPE_PRICE_PREMIUM_MONTHLY` / `_ANNUAL`, src/server/services/billing.ts),
 * never an amount. So these numbers are copy, and they must equal the Stripe
 * prices those IDs point at — change both together (docs/STRIPE.md).
 *
 * Amounts are in minor units (cents). The annual price is stored as the exact
 * amount Stripe charges rather than derived from a discount percentage, so the
 * page can never round its way to a figure Stripe doesn't bill; the discount
 * label is derived from it instead.
 */
import { TIER_LIMITS } from "@/server/tiers";
import raw from "./pricing.json";

export type BillingPeriod = "monthly" | "annual";

export type PricingConfig = {
  currency: "EUR";
  premium: {
    monthly: { amount: number };
    annual: { amount: number };
  };
  enterprise: { monthlyFrom: number };
};

export const PRICING: PricingConfig = raw as PricingConfig;

/**
 * Seats Premium includes. Read from the plan limits the server enforces, not
 * from pricing.json, so the price card can never promise a different number
 * than the seat limit (it once said 5 while the limit was 15).
 */
export const PREMIUM_SEATS: number | null = TIER_LIMITS.premium.seats;

/** "Includes 15 seats" / "Includes unlimited seats". */
export function seatsNote(seats: number | null = PREMIUM_SEATS): string {
  if (seats === null) return "Includes unlimited seats";
  return `Includes ${seats} ${seats === 1 ? "seat" : "seats"}`;
}

const CURRENCY_SYMBOL: Record<PricingConfig["currency"], string> = { EUR: "€" };

/** `1900` → `"€19"`, `19380` → `"€193.80"` — whole amounts drop the cents. */
export function formatPrice(minor: number, config: PricingConfig = PRICING): string {
  const symbol = CURRENCY_SYMBOL[config.currency];
  const major = minor / 100;
  return Number.isInteger(major) ? `${symbol}${major}` : `${symbol}${major.toFixed(2)}`;
}

/**
 * What paying annually saves over twelve monthly payments: "2 months free"
 * when the saving is a whole number of months, otherwise "Save 15%"
 * (rounded down, so the claim never overstates the discount). Null when
 * annual isn't cheaper.
 */
export function annualSavingLabel(config: PricingConfig = PRICING): string | null {
  const monthly = config.premium.monthly.amount;
  const yearOfMonthly = monthly * 12;
  const saving = yearOfMonthly - config.premium.annual.amount;
  if (saving <= 0) return null;
  const monthsFree = saving / monthly;
  if (Number.isInteger(monthsFree)) {
    return monthsFree === 1 ? "1 month free" : `${monthsFree} months free`;
  }
  return `Save ${Math.floor((saving / yearOfMonthly) * 100)}%`;
}
