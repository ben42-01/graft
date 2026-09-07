/**
 * "Download my data" — the portability/access request answered without a
 * support ticket (`/account/privacy`).
 *
 * It is assembled in the browser from the tenant-scoped endpoints the app
 * already uses — `/me`, `/entities`, each entity's records, `/dashboards`,
 * `/forms` — deliberately, rather than by adding an export endpoint. An
 * endpoint that serialises "everything belonging to a tenant" is a new
 * privileged read path and a new place for a tenant-isolation bug to hide;
 * this reads exactly what the signed-in user can already read, through the
 * same `ctx`-scoped routes, and therefore cannot see further than they can.
 *
 * The trade is that a very large workspace makes a lot of requests. Lists
 * are paged through with the API's own cursor (`meta.cursor`), capped at
 * `MAX_PAGES` per collection; if a cap is hit, the export says so in the
 * file rather than silently handing over a partial copy.
 */
import { VERSION as PRIVACY_VERSION } from "@/lib/legal/privacy";

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

type PageMeta = { limit: number; hasMore: boolean; cursor: string | null };

type Paged<T> = { items: T[]; truncated: boolean };

async function getJson<T>(path: string): Promise<{ data: T; meta?: PageMeta } | null> {
  try {
    const response = await fetch(path, { credentials: "include" });
    if (!response.ok) return null;
    return (await response.json()) as { data: T; meta?: PageMeta };
  } catch {
    return null;
  }
}

/** Follows `meta.cursor` until the API says there is no more, or the cap. */
async function getAll<T>(path: string): Promise<Paged<T>> {
  const items: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const cursorParam: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const url = `${path}${separator}limit=${PAGE_LIMIT}${cursorParam}`;
    const body: { data: T[]; meta?: PageMeta } | null = await getJson<T[]>(url);
    if (!body) break;
    items.push(...body.data);
    if (!body.meta?.hasMore || !body.meta.cursor) return { items, truncated: false };
    cursor = body.meta.cursor;
  }

  return { items, truncated: true };
}

type EntitySummary = { id: string; key: string; name: string };

export type WorkspaceExport = {
  exportedAt: string;
  privacyStatementVersion: string;
  /** Set when any collection hit `MAX_PAGES` — the copy is incomplete. */
  truncated: string[];
  account: unknown;
  entities: { entity: unknown; records: unknown[] }[];
  dashboards: unknown[];
  forms: unknown[];
};

export type ExportProgress = (message: string) => void;

export async function buildWorkspaceExport(
  onProgress: ExportProgress = () => {},
): Promise<WorkspaceExport> {
  const truncated: string[] = [];

  onProgress("Reading your account…");
  const me = await getJson<unknown>("/api/v1/me");

  onProgress("Reading your entities…");
  const entityPage = await getAll<EntitySummary>("/api/v1/entities");
  if (entityPage.truncated) truncated.push("entities");

  const entities: { entity: unknown; records: unknown[] }[] = [];
  for (const entity of entityPage.items) {
    onProgress(`Reading records in ${entity.name}…`);
    const records = await getAll<unknown>(`/api/v1/entities/${entity.id}/records`);
    if (records.truncated) truncated.push(`records:${entity.key}`);
    entities.push({ entity, records: records.items });
  }

  onProgress("Reading your dashboards and forms…");
  const dashboards = await getAll<unknown>("/api/v1/dashboards");
  if (dashboards.truncated) truncated.push("dashboards");
  const forms = await getAll<unknown>("/api/v1/forms");
  if (forms.truncated) truncated.push("forms");

  return {
    exportedAt: new Date().toISOString(),
    privacyStatementVersion: PRIVACY_VERSION,
    truncated,
    account: me?.data ?? null,
    entities,
    dashboards: dashboards.items,
    forms: forms.items,
  };
}
