/**
 * GRAFT-18 Test Contract — the public `/signup` page. Runs against a seeded
 * QA stack (`npm run qa:full`). Covers AC4 (valid signup shows the
 * verify-email confirmation instead of redirecting into the app) and AC5
 * (an email already in use surfaces the existing CONFLICT inline).
 */
import { expect, test } from "@playwright/test";

test("AC4 — a valid signup calls the API, creates no client session, and shows the verify-email confirmation", async ({
  page,
}) => {
  const unique = Date.now();
  await page.goto("/signup");
  await page.getByLabel("Business name").fill(`Signup E2E ${unique}`);
  await page.getByLabel("Email").fill(`signup-e2e-${unique}@qa.test`);
  await page.getByLabel("Password").fill("a-perfectly-fine-password-2026");
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByText(/check your email/i)).toBeVisible();
  await expect(page).toHaveURL(/\/signup/);

  // No session was created client-side — /me still reports unauthenticated.
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(401);
});

test("AC5 — signing up with an email already in use surfaces the CONFLICT inline", async ({
  page,
}) => {
  await page.goto("/signup");
  await page.getByLabel("Business name").fill("Duplicate Business E2E");
  await page.getByLabel("Email").fill("owner@qa-free.test");
  await page.getByLabel("Password").fill("a-perfectly-fine-password-2026");
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByTestId("form-error")).toHaveText(/already exists/i);
  await expect(page).toHaveURL(/\/signup/);
});
