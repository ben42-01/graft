/**
 * The plugin registry service — activation, deactivation and the catalogue
 * (GRAFT-14, docs/Graft.md §4.1, docs/TIERS.md §2.1 "Plugins enabled").
 *
 * Four things matter enough to call out:
 *
 *   - **A plugin is described entirely by its manifest** (src/server/plugins.ts,
 *     AC1). Enabling one provisions its declared `entities` and `forms` through
 *     the *normal* entities/forms APIs (`createEntity`/`createForm`) — there is
 *     no separate "plugin data" write path, so a provisioned entity is
 *     indistinguishable from one a tenant built by hand.
 *   - **Provisioning is idempotent, the same lifetime-counter convention
 *     entities.ts and forms.ts already use.** A first enable and a re-enable
 *     after disabling run the identical code path: `createEntity`/`createForm`
 *     is tried first, and the CONFLICT it throws for an existing key/slug is
 *     the signal that this tenant already has it — not an error to surface
 *     (AC1, AC2).
 *   - **Disabling only flips a flag.** No entity, form or record provisioned by
 *     a plugin is ever touched by disabling it — re-enabling finds them exactly
 *     as they were (AC2). Existing `plugins_enabled` rows (scripts/seed-qa.ts)
 *     predate the `enabled` field, so its absence reads as `true`; only an
 *     explicit `false` reads as disabled.
 *   - **Quota is reserved before the write, and never given back.** Enabling a
 *     plugin reserves the `plugins` meter exactly once per enable *transition*
 *     (not once per plugin, ever) — the same trade-off forms.ts's
 *     `active_forms`/`internal_forms` already accepts for publish/unpublish
 *     cycles (AC3). Tier eligibility is checked first, against the tenant's
 *     real entitlements, never `ctx.tier` (AC4 — see entitlements.ts).
 */
import { ObjectId, type Filter } from "mongodb";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { z } from "zod";
import {
  createEntity as createEntityDefault,
  getEntityByKey as getEntityByKeyDefault,
  type EntityView,
} from "./entities";
import { createForm as createFormDefault } from "./forms";
import { loadEntitlements as loadEntitlementsDefault, type Entitlements } from "./entitlements";
import { consumeQuota as consumeQuotaDefault, type Meter, type QuotaResult } from "./meters";
import { createRepository, type Repository } from "@/server/repositories/base";
import {
  findPlugin,
  PLUGIN_ID_PATTERN,
  PLUGIN_REGISTRY,
  tierEligible,
  type PluginManifest,
} from "@/server/plugins";
import type { Tier } from "@/server/tiers";

export const pluginIdParamSchema = z.object({
  pluginId: z.string().regex(PLUGIN_ID_PATTERN).max(64),
});

export type PluginEnabledDoc = {
  tenantId: ObjectId;
  pluginId: string;
  /** Optional so pre-existing fixture rows (scripts/seed-qa.ts) that predate
   * this field still read as enabled — see the module doc comment. */
  enabled?: boolean;
  config: Record<string, unknown>;
};

export type PluginView = {
  id: string;
  name: string;
  version: string;
  tier: Tier;
  /** Whether this tenant's tier permits enabling this plugin (AC4). */
  eligible: boolean;
  enabled: boolean;
};

/** No row at all means never enabled. A row with `enabled` absent predates
 * the field and reads as enabled (module doc); only an explicit `false`
 * reads as disabled. */
const isEnabled = (doc: Pick<PluginEnabledDoc, "enabled"> | null | undefined): boolean =>
  doc != null && doc.enabled !== false;

function toView(manifest: PluginManifest, enabled: boolean, tenantTier: Tier): PluginView {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier,
    eligible: tierEligible(tenantTier, manifest.tier),
    enabled,
  };
}

export type PluginDeps = {
  repo: Repository<PluginEnabledDoc>;
  entitlements: (ctx: Ctx) => Promise<Entitlements>;
  consumeQuota: (ctx: Ctx, meter: Meter, amount?: number) => Promise<QuotaResult>;
  createEntity: typeof createEntityDefault;
  getEntityByKey: typeof getEntityByKeyDefault;
  createForm: typeof createFormDefault;
};

const defaultRepo = createRepository<PluginEnabledDoc>("plugins_enabled");

function resolveDeps(overrides: Partial<PluginDeps> = {}): PluginDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    entitlements: overrides.entitlements ?? ((ctx) => loadEntitlementsDefault(ctx)),
    consumeQuota:
      overrides.consumeQuota ??
      ((ctx, meter, amount) => consumeQuotaDefault(ctx, meter, amount)),
    createEntity: overrides.createEntity ?? createEntityDefault,
    getEntityByKey: overrides.getEntityByKey ?? getEntityByKeyDefault,
    createForm: overrides.createForm ?? createFormDefault,
  };
}

const isConflict = (error: unknown): boolean =>
  error instanceof AppError && error.code === "CONFLICT";

/**
 * AC1, AC2, AC7 — provisions every entity, then every form, declared by the
 * manifest. `createEntity`/`createForm` is tried first; a CONFLICT (the key or
 * slug already exists for this tenant) means a prior enable already did the
 * work, which is success, not an error — this is what makes re-enabling after
 * a disable restore the same records rather than fail or duplicate them.
 */
async function provision(ctx: Ctx, manifest: PluginManifest, deps: PluginDeps): Promise<void> {
  const entityIdByKey = new Map<string, string>();

  for (const entity of manifest.entities) {
    let view: EntityView;
    try {
      view = await deps.createEntity(ctx, {
        key: entity.key,
        name: entity.name,
        fields: entity.fields,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await deps.getEntityByKey(ctx, entity.key);
      if (!existing) throw error;
      view = existing;
    }
    entityIdByKey.set(entity.key, view.id);
  }

  for (const form of manifest.forms) {
    const entityId = entityIdByKey.get(form.entityKey);
    // Guaranteed by pluginManifestSchema's superRefine — every form's
    // entityKey names an entity the same manifest declares.
    if (!entityId) continue;
    try {
      await deps.createForm(ctx, {
        entityId,
        name: form.name,
        slug: form.slug,
        visibility: form.visibility,
        fields: form.fields.map((key) => ({ key })),
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // Already provisioned by a prior enable (AC2) — nothing to do.
    }
  }
}

/** AC1, AC4 — the catalogue: every registered plugin, this tenant's enabled
 * state, and whether its tier permits enabling it. */
export async function listPlugins(
  ctx: Ctx,
  overrides: Partial<PluginDeps> = {},
): Promise<PluginView[]> {
  const deps = resolveDeps(overrides);
  const entitlements = await deps.entitlements(ctx);
  const docs = await deps.repo.find(ctx);
  const byPluginId = new Map(docs.map((doc) => [doc.pluginId, doc]));
  return PLUGIN_REGISTRY.map((manifest) =>
    toView(manifest, isEnabled(byPluginId.get(manifest.id)), entitlements.tier),
  );
}

/**
 * AC1, AC3, AC4, AC6, AC7 — tier eligibility is checked before quota, and
 * quota before the write, so a refusal on either front leaves nothing
 * provisioned and nothing charged. Already-enabled is a no-op, not a re-check
 * (the same ordering as forms.ts's `publishForm`).
 */
export async function enablePlugin(
  ctx: Ctx,
  pluginId: string,
  overrides: Partial<PluginDeps> = {},
): Promise<PluginView> {
  const deps = resolveDeps(overrides);
  const manifest = findPlugin(pluginId);
  if (!manifest) throw new AppError("NOT_FOUND", "Plugin not found");

  const existing = await deps.repo.findOne(ctx, { pluginId } as Filter<PluginEnabledDoc>);
  const entitlements = await deps.entitlements(ctx);

  if (isEnabled(existing)) return toView(manifest, true, entitlements.tier);

  if (!tierEligible(entitlements.tier, manifest.tier)) {
    throw new AppError("FORBIDDEN", "This plugin requires a higher plan tier.", {
      pluginId,
      requiredTier: manifest.tier,
      tenantTier: entitlements.tier,
    });
  }

  await deps.consumeQuota(ctx, "plugins");
  await provision(ctx, manifest, deps);

  if (existing) {
    await deps.repo.updateOne(ctx, { _id: existing._id } as Filter<PluginEnabledDoc>, {
      $set: { enabled: true },
    });
  } else {
    await deps.repo.insertOne(ctx, { pluginId, enabled: true, config: {} });
  }

  return toView(manifest, true, entitlements.tier);
}

/** AC2, AC6 — flips the flag only; every provisioned entity, form and record
 * is left exactly as it was. Idempotent: a plugin that was never enabled, or
 * is already disabled, is a no-op 200, not an error. */
export async function disablePlugin(
  ctx: Ctx,
  pluginId: string,
  overrides: Partial<PluginDeps> = {},
): Promise<PluginView> {
  const deps = resolveDeps(overrides);
  const manifest = findPlugin(pluginId);
  if (!manifest) throw new AppError("NOT_FOUND", "Plugin not found");

  const entitlements = await deps.entitlements(ctx);
  const existing = await deps.repo.findOne(ctx, { pluginId } as Filter<PluginEnabledDoc>);

  if (!existing || !isEnabled(existing)) return toView(manifest, false, entitlements.tier);

  await deps.repo.updateOne(ctx, { _id: existing._id } as Filter<PluginEnabledDoc>, {
    $set: { enabled: false },
  });

  return toView(manifest, false, entitlements.tier);
}
