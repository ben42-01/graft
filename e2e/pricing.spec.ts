/**
 * GRAFT-19 Test Contract — the public pricing/marketing root and the Stripe
 * checkout wiring on it. Runs against a seeded QA stack (`npm run qa:full`),
 * using the fixed QA fixtures (`scripts/seed-qa.ts`, `docs/WORKFLOW.md`
 * §5.2).
 *
 * Covers AC1 (unauthenticated visit renders the marketing page, not a
 * redirect or 404), AC2 (tier data is a live import from
 * `src/server/tiers.ts`, not hardcoded numbers that can drift), AC3 (owner
 * checkout reaches the returned Stripe URL — the checkout API call is
 * stubbed at the network layer here since a real Stripe session would need
 * live keys; `src/server/services/billing.test.ts` and
 * `bruno/billing/checkout-authz.bru` already cover the endpoint itself),
 * AC4 (non-owner sees the existing FORBIDDEN surfaced inline), AC5
 * (anonymous visitor routed to /signup instead of hitting checkout), AC6/AC7
 * (billing/success and billing/cancel render, no 404).
 */
import { expect, test } from "@playwright/test";
import { FEATURES, TIER_FEATURES, TIER_LIMITS } from "../src/server/tiers";

const BILLING_OWNER_EMAIL = "owner@qa-billing.test";
const PREMIUM_MEMBER_EMAIL = "member@qa-premium.test";
const PASSWORD = "qa-fixture-password-2026";

test("AC1 — an unauthenticated visitor at / sees the marketing/pricing page", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("heading", { name: /run your business on graft/i }),
  ).toBeVisible();
  await expect(page.getByTestId("tier-free")).toBeVisible();
  await expect(page.getByTestId("tier-premium")).toBeVisible();

  // The 2026-08-21 UI refinement put Enterprise behind the audience toggle
  // (Individual / Team & Enterprise), so it is mounted but not on screen
  // until that tab is picked. The card's *data* is still asserted on first
  // paint by AC2 below, which reads attributes rather than visibility.
  await expect(page.getByTestId("tier-enterprise")).not.toBeVisible();
  await page.getByTestId("audience-team").click();
  await expect(page.getByTestId("tier-enterprise")).toBeVisible();
});

test("AC2 — the pricing section's limits and enterprise-only features match src/server/tiers.ts", async ({
  page,
}) => {
  await page.goto("/");

  for (const tier of ["free", "premium", "enterprise"] as const) {
    const limits = TIER_LIMITS[tier];
    for (const key of ["seats", "activeForms", "submissionsPerMonth"] as const) {
      const li = page.locator(`[data-testid="tier-${tier}-limits"] [data-limit="${key}"]`);
      await expect(li).toHaveAttribute("data-value", String(limits[key]));
    }

    const expectedFeatures = FEATURES.filter((f) => TIER_FEATURES[tier][f]);
    const renderedFeatures = await page
      .locator(`[data-testid="tier-${tier}-features"] [data-feature]`)
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-feature")));
    expect(new Set(renderedFeatures)).toEqual(new Set(expectedFeatures));
  }
});

test("AC3 — an authenticated owner's Subscribe click calls checkout and navigates to the returned URL", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: BILLING_OWNER_EMAIL, password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  const stubUrl = "https://checkout.stripe.example.test/session/qa-fixture";
  await page.route("**/api/v1/billing/checkout", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(JSON.parse(request.postData() ?? "{}")).toEqual({ plan: "monthly" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { url: stubUrl }, meta: { requestId: "qa-e2e" } }),
    });
  });
  await page.route(stubUrl, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" });
  });

  await page.goto("/");
  await page.getByTestId("subscribe-premium-monthly").click();
  await expect(page).toHaveURL(stubUrl);
});

test("AC4 — a non-owner's Subscribe click surfaces the existing owner-only FORBIDDEN inline", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: PREMIUM_MEMBER_EMAIL, password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/");
  await page.getByTestId("subscribe-premium-monthly").click();

  await expect(page.getByTestId("checkout-error")).toBeVisible();
  await expect(page.getByTestId("checkout-error")).toHaveText(/owner/i);
  await expect(page).toHaveURL("/");
});

test("AC5 — an anonymous visitor's Subscribe click routes to /signup, never hitting checkout", async ({
  page,
}) => {
  let checkoutCalled = false;
  await page.route("**/api/v1/billing/checkout", async (route) => {
    checkoutCalled = true;
    await route.continue();
  });

  await page.goto("/");
  await page.getByTestId("subscribe-premium-monthly").click();

  await expect(page).toHaveURL("/signup");
  expect(checkoutCalled).toBe(false);
});

test("AC8 — the authenticated app's home route still resolves at /home post-restructure", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: BILLING_OWNER_EMAIL, password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  const response = await page.goto("/home");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
});

test("AC6 — a Stripe success redirect renders a confirmation", async ({ page }) => {
  const response = await page.goto("/billing/success");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("heading", { name: /you.re subscribed/i })).toBeVisible();
});

test("AC7 — a Stripe cancel redirect renders a cancellation notice with a way back to pricing", async ({
  page,
}) => {
  const response = await page.goto("/billing/cancel");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("heading", { name: /checkout canceled/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /back to pricing/i })).toHaveAttribute(
    "href",
    "/#pricing",
  );
});
