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

/**
 * GRAFT-30.3 — one cart submission end to end, against the GRAFT-30.2 seed
 * form (qa-premium/qa-premium-cart-shop, scripts/seed-qa.ts): cart mode, flat
 * prices, Sourdough loaf €5 and Veg box €22. Two loaves and a veg box make
 * one order with two lines, read back through the owner's orders API.
 */
test("a visitor can fill a cart and submit it as one two-line order", async ({ page }) => {
  await page.goto("/f/qa-premium/qa-premium-cart-shop");

  await page.getByRole("button", { name: "Add Sourdough loaf" }).click();
  const cart = page.getByRole("list", { name: "Cart items" });
  await cart.getByRole("button", { name: "Increase quantity of Sourdough loaf" }).click();
  await page.getByRole("button", { name: "Add Veg box" }).click();

  await expect(cart.getByRole("listitem")).toHaveCount(2);
  // The estimate the page shows: 2 × 5 + 1 × 22. Display only — never sent.
  await expect(page.getByText("Estimated total, confirmed at checkout")).toBeVisible();
  await expect(page.getByTestId("cart-estimate")).toContainText("32.00");

  await page.getByRole("button", { name: "Continue to your details" }).click();

  const customer = `Playwright Cart ${Date.now()}`;
  await page.getByLabel(/Customer/).fill(customer);
  const day = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  for (const [label, time] of [
    ["Starts", "09:00"],
    ["Ends", "13:00"],
  ] as const) {
    await page.getByRole("button", { name: label }).click();
    await page.getByLabel("Type a date").fill(day);
    await page.getByLabel("Type a date").press("Enter");
    await page.getByLabel("Time").fill(time);
    await page.getByRole("button", { name: "Done" }).click();
  }

  // MIN_FILL_MS, as above.
  await page.waitForTimeout(1600);

  const [submission] = await Promise.all([
    page.waitForRequest((request) => request.url().includes("/submissions")),
    page.getByRole("button", { name: "Submit" }).click(),
  ]);
  // Sourdough loaf and Veg box (recordCartLoaf, recordCartVegBox), and nothing
  // about money.
  expect(submission.postDataJSON()._cart).toEqual([
    { recordId: "000000000000000000000038", quantity: 2 },
    { recordId: "000000000000000000000039", quantity: 1 },
  ]);
  await expect(page.getByRole("status")).toContainText("received");

  // Read the order back as the shop's owner.
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: "owner@qa-premium.test", password: "qa-fixture-password-2026" },
  });
  expect(login.ok()).toBeTruthy();
  const auth = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };

  // QA Cart Orders (entityPremiumCartOrders): the record this submission became.
  const filter = encodeURIComponent(JSON.stringify({ customer }));
  const records = await page.request.get(
    `/api/v1/entities/00000000000000000000001d/records?filter=${filter}`,
    { headers: auth },
  );
  const [record] = (await records.json()).data;
  expect(record).toBeTruthy();

  const orders = await page.request.get("/api/v1/orders?limit=20", { headers: auth });
  const mine = (await orders.json()).data.filter(
    (order: { customerRecordId: string }) => order.customerRecordId === record.id,
  );
  expect(mine).toHaveLength(1);
  expect(mine[0].lineItems).toHaveLength(2);
});
