import { defineConfig, devices } from "@playwright/test";

/**
 * First Playwright wiring in the repo (GRAFT-10 Test Contract). Targets the
 * QA app the same way Bruno does (`APP_URL`, docs/WORKFLOW.md §4.3) — no dev
 * server is spun up here; run against a seeded QA stack the way
 * `scripts/with-qa-app.ts` runs the Bruno suite (`npm run qa:full` in one
 * terminal, `npm run test:e2e` in another, or wrap it the same way once CI
 * wiring is its own issue).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
