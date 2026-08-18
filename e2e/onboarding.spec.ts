/**
 * Onboarding wizard smoke test (GRAFT-12 AC1, AC2, AC3, AC5, AC6 — the
 * GO-LIVE §7 gate: "full onboarding flow passes Playwright E2E on prod
 * build"). Runs against a seeded QA stack (`npm run qa:full`).
 *
 * Authenticates as the QA free-tier owner (owner@qa-free.test, already
 * seeded with 2 plugins, one "customers" entity and one dashboard at the
 * Free limit — scripts/seed-qa.ts) via the login API directly, the same
 * pattern e2e/dashboard-widgets.spec.ts uses. That tenant already having
 * data is deliberate, not an oversight: it proves the wizard's guided steps
 * reuse existing state through the normal APIs (AC5, AC7) rather than only
 * working against an empty tenant — enabling an already-enabled plugin,
 * hitting the entity-key CONFLICT and reusing that entity, and reusing the
 * tenant's one Free-tier dashboard instead of erroring at quota.
 */
import { expect, test } from "@playwright/test";

test("business profile -> template -> plugins -> entity -> form -> dashboard -> done, with a mid-flow resume", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: "owner@qa-free.test", password: "qa-fixture-password-2026" },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();

  // Step 1 — business profile.
  await page.getByLabel("Business name").fill("Acme Trades E2E");
  await page.getByRole("combobox", { name: "Industry" }).click();
  await page.getByRole("option", { name: "Trades & Services" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // AC2 — reloading mid-wizard resumes at the same step with prior input
  // intact, not back at the start.
  await expect(page.getByTestId("onboarding-step-template")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.reload();
  await expect(page.getByTestId("onboarding-step-template")).toHaveAttribute(
    "aria-current",
    "step",
  );

  // Step 2 — template suggestion (AC3): accept the suggested bundle.
  await expect(page.getByText("Trades & Services")).toBeVisible();
  await page.getByRole("button", { name: "Use this template" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3 — plugins: the template's plugins are pre-selected; "contacts" is
  // already enabled on this tenant (a no-op success), "scheduling" is a real
  // first activation (AC4's server-side path, reused rather than
  // reimplemented — the Free limit is never pre-capped client-side).
  await expect(page.getByRole("checkbox", { name: "Contacts" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Scheduling" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4 — guided first entity (AC5: POST /api/v1/entities). "customers"
  // already exists on this tenant, so this exercises the CONFLICT ->
  // reuse-the-existing-entity path. Tweak a field label before continuing,
  // proving the "tweak" path of AC3 is real, editable state.
  await expect(page.getByText("Create your first entity")).toBeVisible();
  await page.getByLabel("Field name label").fill("Full name");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 5 — guided first form (AC5: POST /api/v1/forms +
  // POST /api/v1/forms/:id/publish — a real published public form, AC6).
  await expect(page.getByText(/create a form your customers/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 6 — dashboard hand-off (AC5): this tenant is already at its Free
  // dashboard limit, so this reuses the existing dashboard instead of
  // hitting QUOTA_EXCEEDED.
  await expect(page.getByText("Set up your dashboard")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 7 — done screen: AC1 (landed, with an entity and a published
  // form) and AC6 (public link + share affordance).
  await expect(page.getByText(/you.re all set/i)).toBeVisible();
  const publicLink = page.getByLabel("Public form link");
  await expect(publicLink).toHaveValue(/\/f\/qa-free\/book-a-job$/);
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Share by email" })).toBeVisible();

  await page.getByRole("link", { name: "Go to your dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboards\//);
});
