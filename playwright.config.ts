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
  // GRAFT-21: spec files share mutable QA fixture state (e.g. onboarding.spec.ts
  // and dashboard-widgets.spec.ts both touch owner@qa-free.test's one seeded
  // dashboard, 000000000000000000000047). Running them in parallel produced a
  // real cross-file race — flaky failures/timeouts, not app bugs — once this
  // suite was first run as a whole via `verify:full`. Serial execution trades
  // a slower suite for a suite that's actually deterministic against the
  // shared, non-isolated QA seed.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
