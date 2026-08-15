/**
 * Drop + recreate the local database (docs/WORKFLOW.md §5.3).
 *
 * Guarded: refuses anything that isn't demonstrably a local docker stack. The
 * guard logic lives in src/server/db/uri-guard.ts and is unit tested — this
 * script is only the wiring.
 */
import { connect } from "./lib/db";
import { assertDestructiveTargetIsLocal } from "../src/server/db/uri-guard";

async function main() {
  const uri = process.env.MONGODB_URI;
  const guard = assertDestructiveTargetIsLocal(uri);

  if (!guard.safe) {
    console.error("\n[graft] REFUSING TO RESET DATABASE");
    console.error(`        reason: ${guard.reason}`);
    console.error("        reset-db only ever runs against a local docker stack.\n");
    process.exit(1);
  }

  const { client, db } = await connect();
  try {
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    if (collections.length === 0) {
      console.log(`[graft] '${db.databaseName}' is already empty`);
      return;
    }
    for (const { name } of collections) {
      if (name.startsWith("system.")) continue;
      await db.collection(name).drop();
      console.log(`  − dropped ${name}`);
    }
    console.log(
      `[graft] reset '${db.databaseName}' — run create-indexes + a seed to repopulate`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[graft] reset failed:", error);
  process.exit(1);
});
