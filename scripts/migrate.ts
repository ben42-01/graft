/**
 * Ordered migration runner (docs/WORKFLOW.md §5.5).
 *
 * Migrations are `.ts` files in /migrations named `NNN-description.ts`, each
 * exporting `up(db)`. Applied once, recorded in the `_migrations` collection.
 * This is the same mechanism dev, qa and prod use — production runs it as a
 * release job with the migrator user, before the app deploys.
 *
 *   npm run db:migrate          # apply pending
 *   npm run db:migrate:status   # list applied / pending
 */
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Db } from "mongodb";
import { connect } from "./lib/db";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const LEDGER = "_migrations";

type Migration = { id: string; file: string; up: (db: Db) => Promise<void> };

function discover(): { id: string; file: string }[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-.+\.ts$/.test(f))
    .sort()
    .map((f) => ({ id: f.replace(/\.ts$/, ""), file: join(MIGRATIONS_DIR, f) }));
}

async function load(entry: { id: string; file: string }): Promise<Migration> {
  const mod = await import(pathToFileURL(entry.file).href);
  if (typeof mod.up !== "function") {
    throw new Error(`migration ${entry.id} does not export an up(db) function`);
  }
  return { ...entry, up: mod.up };
}

async function main() {
  const command = process.argv[2] ?? "status";
  const { client, db } = await connect();

  try {
    const applied = new Set(
      (
        await db
          .collection(LEDGER)
          .find({}, { projection: { _id: 1 } })
          .toArray()
      ).map((doc) => String(doc._id)),
    );
    const all = discover();
    const pending = all.filter((m) => !applied.has(m.id));

    if (command === "status") {
      if (all.length === 0) {
        console.log("[graft] no migrations defined yet");
        return;
      }
      for (const m of all) {
        console.log(`  ${applied.has(m.id) ? "✓ applied" : "· pending"}  ${m.id}`);
      }
      console.log(`[graft] ${applied.size} applied, ${pending.length} pending`);
      return;
    }

    if (command !== "up") {
      console.error(`[graft] unknown command '${command}' — use 'up' or 'status'`);
      process.exit(1);
    }

    if (pending.length === 0) {
      console.log("[graft] nothing to migrate");
      return;
    }

    for (const entry of pending) {
      const migration = await load(entry);
      const startedAt = Date.now();
      console.log(`  → ${migration.id}`);
      await migration.up(db);
      await db.collection(LEDGER).insertOne({
        _id: migration.id as never,
        appliedAt: new Date(),
        durationMs: Date.now() - startedAt,
      });
      console.log(`  ✓ ${migration.id} (${Date.now() - startedAt}ms)`);
    }
    console.log(`[graft] applied ${pending.length} migration(s) to '${db.databaseName}'`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[graft] migration failed:", error);
  process.exit(1);
});
