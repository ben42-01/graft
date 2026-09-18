/**
 * GRAFT-27.3 Test Contract — the `/admin` console, end to end (AC1, AC2,
 * AC5, AC7). Runs against a seeded QA stack (`npm run qa:full`).
 *
 * Note (docs/BACKEND.md §7.3): Playwright is not yet wired into the CI gate,
 * so this spec is not what turns the build green — the component tests in
 * layout.test.tsx / tenant-table.test.tsx / tenant-detail.test.tsx are. This
 * spec is still required by the Test Contract and is written to actually
 * pass against a real QA stack.
 *
 * Fixtures (scripts/seed-qa.ts): `platform-admin@qa.test` is the one seeded
 * user with `isPlatformAdmin: true`; `owner@qa-platform.test` holds ordinary
 * tenant roles (`owner`, `admin`) and no platform flag — the exact "admin"
 * name collision the contract calls out. `qa-downgraded`
 * (000000000000000000000004) is the one seeded tenant with a non-empty
 * `readOnly` set and a `downgradedAt`, so the detail screen's fields render
 * real values.
 */
import { expect, test } from "@playwright/test";

const PASSWORD = "qa-fixture-password-2026";
const DOWNGRADED_TENANT_ID = "000000000000000000000004";

test("a seeded platform admin reaches /admin/tenants, searches, and opens a tenant's detail", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: "platform-admin@qa.test", password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  // AC1 — /admin redirects to /admin/tenants and the table renders.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Name" })).toBeVisible();

  // AC5 — search re-queries the server rather than filtering one page.
  await page.getByRole("searchbox", { name: "Search tenants" }).fill("downgraded");
  await expect(page.getByRole("link", { name: /downgraded/i })).toBeVisible();
  const rows = page.getByRole("row");
  await expect(rows).toHaveCount(2); // header + the one match

  // AC7 — opening a row shows the resolved limits and freeze list, no
  // Stripe identifier anywhere on the page.
  await page.getByRole("link", { name: /downgraded/i }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/tenants/${DOWNGRADED_TENANT_ID}$`));
  await expect(page.getByText("Resolved limits")).toBeVisible();
  await expect(page.getByText("Frozen (read-only) resources")).toBeVisible();
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/cus_|sub_/);
});

test("AC2 — a signed-in tenant owner (not a platform admin) is bounced from /admin/tenants to /", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: "owner@qa-platform.test", password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/admin/tenants");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/not an admin/i)).toHaveCount(0);
});
