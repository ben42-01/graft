/**
 * GRAFT-26 — the runnable entry point for trial expiry (docs/TIERS.md §3).
 *
 * A tenant that signed up got 14 days of Premium with no card. When
 * `billing.trialEndsAt` passes, this job routes them through the same
 * `expireTrial()` → `applyDowngradePolicy()` path a cancelled subscription
 * takes: back to Free, data retained, features locked, over-limit resources
 * read-only, nothing ever deleted.
 *
 *   dotenv -e .env.dev -- tsx scripts/expire-trials.ts
 *
 * **Deliberately not wired to a schedule.** `.github/workflows/**` is a
 * protected path and this contract does not touch it; a follow-up chore issue
 * gives this job and `expireDueGracePeriods` a cron under co-review. Until
 * then it is run by hand, which is safe because it is idempotent: a downgraded
 * trial has its `trialEndsAt` cleared, so a second run selects nothing.
 *
 * Output is ids and counts only — never an email, never any other PII.
 */
import { getMongoClient } from "../src/server/db/mongo";
import { expireDueTrials } from "../src/server/services/billing";

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error(
      "[graft] MONGODB_URI is not set — run this via dotenv so it loads the right .env file",
    );
    process.exit(1);
  }

  const startedAt = Date.now();
  const expired = await expireDueTrials();
  console.log(`[graft] expired ${expired} lapsed trial(s) in ${Date.now() - startedAt}ms`);

  await (await getMongoClient()).close();
}

main().catch(async (error) => {
  console.error("[graft] trial expiry failed:", error);
  process.exit(1);
});
