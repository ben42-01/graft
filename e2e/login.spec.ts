/**
 * GRAFT-18 Test Contract — the public `/login` page, driven through the
 * actual browser form (not `page.request.post`, which every other E2E spec
 * uses to bypass exactly the UI this issue adds). Runs against a seeded QA
 * stack (`npm run qa:full`), using the QA free-tier owner
 * (owner@qa-free.test / qa-fixture-password-2026, scripts/seed-qa.ts).
 *
 * Covers AC1 (unauthenticated -> /login with redirect preserved), AC2 (valid
 * login lands on the redirect target / AppShell), AC3 (invalid credentials ->
 * inline error, no navigation), AC6 (already-authenticated visit to /login
 * bounces to /home — GRAFT-19 moved the authenticated landing off the root
 * route), AC7 (open-redirect guard on the redirect param).
 */
import { expect, test } from "@playwright/test";

const EMAIL = "owner@qa-free.test";
const PASSWORD = "qa-fixture-password-2026";

test("AC1 — an unauthenticated visit to a guarded route lands on /login with the original path preserved", async ({
  page,
}) => {
  await page.goto("/dashboards");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboards/);
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("AC2 — valid credentials set the session and land on the redirect target's AppShell", async ({
  page,
}) => {
  await page.goto("/login?redirect=%2Fdashboards");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/dashboards$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

test("AC3 — invalid credentials show an inline error and never navigate away", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("wrong-password-entirely");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.getByTestId("form-error")).toHaveText(/invalid email or password/i);
  await expect(page).toHaveURL(/\/login/);
});

test("AC6 — an already-authenticated visitor hitting /login directly is bounced to /home", async ({
  page,
}) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/login");
  await expect(page).toHaveURL("/home");
});

test("AC7 — an absolute or protocol-relative redirect target is ignored in favor of /home", async ({
  page,
}) => {
  await page.goto("/login?redirect=https%3A%2F%2Fevil.com");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL("/home");
});
