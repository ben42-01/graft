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
 *   dotenv -e .env.dev -- tsx scripts/expire-trials.ts someone@example.com
 *
 * **With an email (manual testing only):** the trial of the workspaces that
 * account owns is expired right now, whether or not `trialEndsAt` has passed.
 * It runs the same `expireTrial()` path, so what you see is what a real expiry
 * does. Tenants that are not trialling are left alone.
 *
 * **Deliberately not wired to a schedule.** `.github/workflows/**` is a
 * protected path and this contract does not touch it; a follow-up chore issue
 * gives this job and `expireDueGracePeriods` a cron under co-review. Until
 * then it is run by hand, which is safe because it is idempotent: a downgraded
 * trial has its `trialEndsAt` cleared, so a second run selects nothing.
 *
 * Output is ids and counts only — never an email, never any other PII.
 */
import { ObjectId } from "mongodb";
import { getMongoClient } from "../src/server/db/mongo";
import {
  expireDueTrials,
  expireTrial,
  mongoBillingStore,
} from "../src/server/services/billing";
import { connect } from "./lib/db";

/** Force-expires the trials of every workspace `email` owns. Returns the count. */
async function expireTrialsForEmail(email: string): Promise<number> {
  const { client, db } = await connect();
  try {
    const user = await db
      .collection("users")
      .findOne({ email: email.trim().toLowerCase() }, { projection: { memberships: 1 } });
    if (!user) {
      console.error("[graft] no account with that email");
      process.exit(1);
    }
    const owned: { tenantId: unknown; roles?: string[] }[] = (user.memberships ?? []).filter(
      (m: { roles?: string[] }) => m.roles?.includes("owner"),
    );
    let expired = 0;
    for (const { tenantId } of owned) {
      const id = String(tenantId);
      const tenant = await db
        .collection("tenants")
        .findOne({ _id: new ObjectId(id) }, { projection: { "billing.trialEndsAt": 1 } });
      if (!tenant?.billing?.trialEndsAt) continue; // not trialling
      await expireTrial(id);
      await mongoBillingStore().setTrialEndsAt(id, null);
      console.log(`[graft] force-expired trial for tenant ${id}`);
      expired += 1;
    }
    return expired;
  } finally {
    await client.close();
  }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error(
      "[graft] MONGODB_URI is not set — run this via dotenv so it loads the right .env file",
    );
    process.exit(1);
  }

  const email = process.argv[2];
  if (email) {
    const count = await expireTrialsForEmail(email);
    console.log(`[graft] force-expired ${count} trial(s)`);
    await (await getMongoClient()).close();
    return;
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
