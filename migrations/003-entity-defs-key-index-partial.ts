/**
 * Drops the old `(tenantId, key)` unique index on `entity_defs` so
 * `create-indexes` can recreate it with `partialFilterExpression: { deletedAt: null }`.
 *
 * Same bug, same fix as 002 for form slugs: `deleteEntity` only sets
 * `deletedAt`, and `createEntity`'s duplicate pre-check is scoped to live
 * entities (the tenant repository adds `deletedAt: null`), but the raw unique
 * index still sees the deleted row. Recreating an entity under a key that was
 * once deleted — which is exactly what re-applying a workspace template does —
 * failed with a false "An entity with that key already exists".
 *
 * `createIndex` cannot change the options of an index with the same name
 * (`tenantId_1_key_1`), so the drop has to run first as a release step.
 */
import type { Db } from "mongodb";

export async function up(db: Db): Promise<void> {
  const entityDefs = db.collection("entity_defs");
  const existing = await entityDefs.indexes();
  const stale = existing.find(
    (index) => index.name === "tenantId_1_key_1" && !index.partialFilterExpression,
  );

  if (!stale) {
    console.log(
      "    entity_defs.tenantId_1_key_1 already partial (or absent) — nothing to drop",
    );
    return;
  }

  await entityDefs.dropIndex("tenantId_1_key_1");
  console.log(
    "    dropped entity_defs.tenantId_1_key_1 — create-indexes will recreate it as partial",
  );
}
