/**
 * Drops the old `(tenantId, slug)` unique index on `forms` so `create-indexes`
 * can recreate it with `partialFilterExpression: { deletedAt: null }`.
 *
 * Without the partial filter, a soft-deleted form (`deleteForm` only ever sets
 * `deletedAt` — src/server/repositories/base.ts) keeps occupying its slug
 * forever: `createForm`'s own duplicate check is scoped to live forms and
 * passes, but the raw Mongo unique index still sees the deleted row and
 * rejects the insert with a false "slug already exists" conflict. Recreating
 * a deleted form under its old name was therefore permanently stuck.
 *
 * `create-indexes` cannot fix this on its own — `createIndex` is only a no-op
 * when an identical index already exists; here the index name is the same
 * (`tenantId_1_slug_1`) but the options differ, which Mongo rejects outright.
 * The drop has to run first, as a release step, same as any other index
 * migration.
 */
import type { Db } from "mongodb";

export async function up(db: Db): Promise<void> {
  const forms = db.collection("forms");
  const existing = await forms.indexes();
  const stale = existing.find(
    (index) => index.name === "tenantId_1_slug_1" && !index.partialFilterExpression,
  );

  if (!stale) {
    console.log("    forms.tenantId_1_slug_1 already partial (or absent) — nothing to drop");
    return;
  }

  await forms.dropIndex("tenantId_1_slug_1");
  console.log(
    "    dropped forms.tenantId_1_slug_1 — create-indexes will recreate it as partial",
  );
}
