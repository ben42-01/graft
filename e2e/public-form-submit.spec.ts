/**
 * First Playwright smoke test in the repo (GRAFT-10 Test Contract): load the
 * QA fixture public form, complete it and submit — the only path a member of
 * the public ever takes through this product without an account.
 *
 * Runs against a seeded QA stack (`npm run qa:full`), the same fixture
 * `bruno/forms/public-submit.bru` exercises over the API.
 */
import { expect, test } from "@playwright/test";

test("a visitor can load, complete and submit the QA public form", async ({ page }) => {
  await page.goto("/f/qa-free/qa-public-form");

  await expect(page.getByRole("heading", { name: "QA Public Form" })).toBeVisible();

  const name = `Playwright Smoke ${Date.now()}`;
  await page.getByLabel(/Name/).fill(name);
  await page.getByLabel(/Email/).fill("playwright-smoke@qa.test");
  await page.getByLabel(/Phone/).fill("+353 1 000 0098");

  // MIN_FILL_MS (public-forms.ts) — a real browser always clears this, but
  // the fixture form is fast to fill by script.
  await page.waitForTimeout(1600);

  await page.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("status")).toContainText("received");
});
