import { describe, expect, it } from "vitest";
import { TIER_LIMITS } from "@/server/tiers";
import {
  PREMIUM_SEATS,
  PRICING,
  annualSavingLabel,
  formatPrice,
  seatsNote,
  type PricingConfig,
} from ".";

function withPrices(monthly: number, annual: number): PricingConfig {
  return {
    ...PRICING,
    premium: { ...PRICING.premium, monthly: { amount: monthly }, annual: { amount: annual } },
  };
}

describe("pricing config", () => {
  it("holds positive integer minor-unit amounts", () => {
    for (const amount of [
      PRICING.premium.monthly.amount,
      PRICING.premium.annual.amount,
      PRICING.enterprise.monthlyFrom,
    ]) {
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
    }
  });

  it("prices annual below twelve monthly payments", () => {
    expect(PRICING.premium.annual.amount).toBeLessThan(PRICING.premium.monthly.amount * 12);
  });
});

describe("formatPrice", () => {
  it("drops cents on whole amounts", () => {
    expect(formatPrice(1900)).toBe("€19");
    expect(formatPrice(29900)).toBe("€299");
  });

  it("keeps two decimals otherwise", () => {
    expect(formatPrice(19380)).toBe("€193.80");
  });
});

describe("annualSavingLabel", () => {
  it("says months free when the saving is whole months", () => {
    expect(annualSavingLabel(withPrices(1900, 19000))).toBe("2 months free");
    expect(annualSavingLabel(withPrices(1900, 20900))).toBe("1 month free");
  });

  it("falls back to a percentage, rounded down", () => {
    expect(annualSavingLabel(withPrices(1900, 19380))).toBe("Save 15%");
    expect(annualSavingLabel(withPrices(1900, 19400))).toBe("Save 14%");
  });

  it("is null when annual saves nothing", () => {
    expect(annualSavingLabel(withPrices(1900, 22800))).toBeNull();
  });
});

describe("seatsNote", () => {
  it("matches the enforced Premium seat limit", () => {
    expect(PREMIUM_SEATS).toBe(TIER_LIMITS.premium.seats);
    expect(seatsNote()).toBe(`Includes ${TIER_LIMITS.premium.seats} seats`);
  });

  it("handles one and unlimited", () => {
    expect(seatsNote(1)).toBe("Includes 1 seat");
    expect(seatsNote(null)).toBe("Includes unlimited seats");
  });
});
