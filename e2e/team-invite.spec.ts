/**
 * GRAFT-33.3 Test Contract — the owner invites through the Team screen and a
 * second, anonymous browser context signs up through the link. Runs against a
 * seeded QA stack (`npm run qa:full`) as the qa-premium owner (15 seats).
 * Signup through an invite creates no session (the account is unverified), so
 * the assertion is on the owner's list: the newcomer is there as a Member.
 */
import { expect, test } from "@playwright/test";

test("the owner creates an invite link and a new person signs up through it as a Member", async ({
  page,
  browser,
}) => {
  const unique = Date.now();
  const email = `invitee-e2e-${unique}@qa.test`;

  await page.goto("/login?redirect=%2Faccount%2Fteam");
  await page.getByLabel("Email").fill("owner@qa-premium.test");
  await page.getByLabel("Password", { exact: true }).fill("qa-fixture-password-2026");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/account\/team$/);

  await page.getByRole("button", { name: "Invite someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByRole("button", { name: "Create link" }).click();
  const link = await dialog.getByLabel("Invite link").inputValue();
  expect(link).toContain("/invite/");
  await dialog.getByRole("button", { name: "Done" }).click();

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(new URL(link).pathname);
  await expect(guestPage.getByRole("heading", { name: /Join .* as Member/ })).toBeVisible();
  await guestPage.getByRole("link", { name: "Create account" }).click();
  await expect(guestPage.getByLabel("Business name")).toHaveCount(0);
  await guestPage.getByLabel("Email").fill(email);
  await guestPage
    .getByLabel("Password", { exact: true })
    .fill("a-perfectly-fine-password-2026");
  await guestPage.getByRole("button", { name: "Sign up" }).click();
  await expect(guestPage.getByText(/check your email/i)).toBeVisible();
  await guest.close();

  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: email });
  await expect(row).toContainText("Member");
});
