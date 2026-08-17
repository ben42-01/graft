import { getDb } from "@/server/db/mongo";
import { getRedis } from "@/server/db/redis";
import { env } from "@/env";
import { TIER_LIMITS, QUOTA_WARNING_RATIO, type Tier } from "@/server/tiers";

/**
 * Development status page. Not the product — moved off `/` by GRAFT-11.4,
 * which gave that route to the real authenticated home behind the app shell.
 * Still unauthenticated and still here so `npm run dev:full` ends with
 * visible proof that Mongo, Redis and the seed all worked.
 */
export const dynamic = "force-dynamic";

type TenantRow = {
  name: string;
  slug: string;
  tier: Tier;
  entities: number;
  records: number;
  forms: number;
  submissionsUsed: number;
};

async function loadStatus() {
  const checks = { mongo: false, redis: false };
  let tenants: TenantRow[] = [];
  let error: string | null = null;

  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    checks.mongo = true;

    const period = new Date().toISOString().slice(0, 7);
    const docs = await db.collection("tenants").find({}).sort({ name: 1 }).toArray();

    tenants = await Promise.all(
      docs.map(async (t) => {
        const [entities, records, forms, meter] = await Promise.all([
          db.collection("entity_defs").countDocuments({ tenantId: t._id }),
          db.collection("records").countDocuments({ tenantId: t._id }),
          db.collection("forms").countDocuments({ tenantId: t._id }),
          db.collection("usage_meters").findOne({
            tenantId: t._id,
            meter: "form_submissions",
            period,
          }),
        ]);
        return {
          name: String(t.name),
          slug: String(t.slug),
          tier: t.tier as Tier,
          entities,
          records,
          forms,
          submissionsUsed: Number(meter?.count ?? 0),
        };
      }),
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  try {
    await getRedis().ping();
    checks.redis = true;
  } catch {
    checks.redis = false;
  }

  return { checks, tenants, error };
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block size-2 rounded-full"
      style={{ background: ok ? "var(--color-graft-accent)" : "var(--color-graft-fail)" }}
    />
  );
}

export default async function Home() {
  const { checks, tenants, error } = await loadStatus();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Graft</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--color-graft-muted)" }}>
        Local development stack · APP_ENV={env().APP_ENV}
      </p>

      <section className="mt-8 flex gap-6 text-sm">
        <span className="flex items-center gap-2">
          <Dot ok={checks.mongo} /> MongoDB
        </span>
        <span className="flex items-center gap-2">
          <Dot ok={checks.redis} /> Redis
        </span>
        <a
          href="/api/ready"
          className="underline"
          style={{ color: "var(--color-graft-muted)" }}
        >
          /api/ready
        </a>
      </section>

      {error && (
        <pre
          className="mt-6 overflow-x-auto rounded-lg p-4 text-xs"
          style={{ background: "var(--color-graft-panel)", color: "var(--color-graft-fail)" }}
        >
          {error}
        </pre>
      )}

      <section className="mt-10">
        <h2
          className="text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--color-graft-muted)" }}
        >
          Seeded tenants
        </h2>

        {tenants.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--color-graft-muted)" }}>
            No tenants yet — run <code>npm run dev:seed</code>.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr style={{ color: "var(--color-graft-muted)" }}>
                  <th className="py-2 text-left font-normal">Tenant</th>
                  <th className="py-2 text-left font-normal">Tier</th>
                  <th className="py-2 text-right font-normal">Entities</th>
                  <th className="py-2 text-right font-normal">Records</th>
                  <th className="py-2 text-right font-normal">Forms</th>
                  <th className="py-2 text-right font-normal">Submissions</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => {
                  const cap = TIER_LIMITS[t.tier]?.submissionsPerMonth ?? null;
                  const ratio = cap ? t.submissionsUsed / cap : 0;
                  const color =
                    ratio >= 1
                      ? "var(--color-graft-fail)"
                      : ratio >= QUOTA_WARNING_RATIO
                        ? "var(--color-graft-warn)"
                        : "var(--color-graft-text)";
                  return (
                    <tr key={t.slug} style={{ borderTop: "1px solid var(--color-graft-line)" }}>
                      <td className="py-2">{t.name}</td>
                      <td className="py-2" style={{ color: "var(--color-graft-muted)" }}>
                        {t.tier}
                      </td>
                      <td className="py-2 text-right tabular-nums">{t.entities}</td>
                      <td className="py-2 text-right tabular-nums">
                        {t.records.toLocaleString()}
                      </td>
                      <td className="py-2 text-right tabular-nums">{t.forms}</td>
                      <td className="py-2 text-right tabular-nums" style={{ color }}>
                        {t.submissionsUsed.toLocaleString()}
                        {cap ? ` / ${cap.toLocaleString()}` : " / ∞"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-10 text-xs" style={{ color: "var(--color-graft-muted)" }}>
        docs/WORKFLOW.md · <code>npm run dev:reset</code> to drop and reseed
      </p>
    </main>
  );
}
