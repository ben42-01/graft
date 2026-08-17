/**
 * Dashboard composer smoke test (GRAFT-13 AC4 Test Contract): add a widget,
 * move it, reload, confirm placement. Runs against a seeded QA stack
 * (`npm run qa:full`) — the QA Dashboard fixture (scripts/seed-qa.ts,
 * 000000000000000000000047) starts with exactly one widget, "Record List".
 *
 * Authenticates via the login API directly (no login UI exists yet) so the
 * browser context picks up the same httpOnly session cookies a real sign-in
 * would set.
 */
import { expect, test } from "@playwright/test";

const DASHBOARD_ID = "000000000000000000000047";

test("adding, moving and reloading a dashboard's widgets survives the round trip", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: "owner@qa-free.test", password: "qa-fixture-password-2026" },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto(`/dashboards/${DASHBOARD_ID}`);

  const widgets = page.locator('[data-testid^="widget-"]');
  await expect(widgets).toHaveCount(1);
  await expect(widgets.getByText("Record List")).toBeVisible();

  // AC4 — add a KPI widget (the composer's default config for "kpi" carries
  // its own label, "Records used").
  await page.getByRole("combobox", { name: "Widget type" }).click();
  await page.getByRole("option", { name: "KPI" }).click();
  await page.getByRole("button", { name: "Add widget" }).click();

  await expect(widgets).toHaveCount(2);
  await expect(widgets.getByText("Records used")).toBeVisible();

  // AC4 — move: drag the newly-added widget (now second) onto the first slot.
  await widgets.nth(1).dragTo(widgets.nth(0));
  await expect(widgets.first()).toContainText("Records used");

  // AC4 — the layout survives a reload.
  await page.reload();
  await expect(widgets).toHaveCount(2);
  await expect(widgets.first()).toContainText("Records used");
});
