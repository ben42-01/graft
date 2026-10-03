/**
 * The countries a tenant's connected Stripe account can be in — shared by the
 * payment editor's picker and the onboarding route that checks it.
 *
 * Accounts v2 needs the country when the account is created, and it can never
 * change afterwards (a tenant who chose wrong connects a different account).
 * The list is what Stripe answered for this platform on 2026-10-03: its
 * `country_specs`, less India, where a Standard-style account cannot take card
 * payments. Cross-border creation from the Irish platform was checked for
 * US, GB, JP, BR and AE.
 */
export const STRIPE_CONNECT_COUNTRIES = [
  "AE",
  "AT",
  "AU",
  "BE",
  "BG",
  "BR",
  "CA",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GI",
  "GR",
  "HK",
  "HR",
  "HU",
  "IE",
  "IT",
  "JP",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "MX",
  "MY",
  "NL",
  "NO",
  "NZ",
  "PL",
  "PT",
  "RO",
  "SE",
  "SG",
  "SI",
  "SK",
  "TH",
  "US",
] as const;

export type StripeConnectCountry = (typeof STRIPE_CONNECT_COUNTRIES)[number];

/** The platform's own country — what the picker starts on. */
export const DEFAULT_CONNECT_COUNTRY: StripeConnectCountry = "IE";

export const isStripeConnectCountry = (value: string): value is StripeConnectCountry =>
  (STRIPE_CONNECT_COUNTRIES as readonly string[]).includes(value);
