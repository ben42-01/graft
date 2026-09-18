/**
 * GET /api/v1/admin/tenants/:tenantId — one tenant's tier and billing state
 * (GRAFT-27.2 AC5, AC6).
 *
 * Read-only, like everything in this contract: the one mutation is GRAFT-27.4.
 * The same three non-behaviours as the list route apply — no `createRepository`,
 * no `ctx.tenantId` filter (AC10), no tier gate, and the inherited `^/api/v1/`
 * rate-limit row keyed on the admin's own tenant and user (see the note in
 * ../route.ts before "fixing" that).
 *
 * `:tenantId` is the tenant the read is *about*, never a scope the caller
 * proved a right to: authority comes from the platform flag alone. It is also
 * what goes on the audit row as `targetTenantId` (AC9) — recorded as the
 * subject of the action, not used as a filter.
 *
 * ## Why the gate runs before the 400
 *
 * The id is *shape-checked* first but only *rejected* after `assertPlatformAdmin`
 * has passed. Rejecting first would answer a non-admin with `400
 * VALIDATION_FAILED` for a malformed id and `404` for a well-formed one, which
 * tells them the path is real and parses its input — precisely the oracle the
 * 404-not-403 decision exists to close (src/server/auth/platform-admin.ts).
 * So a non-admin gets the same 404 for every id, valid or not (AC7), and only a
 * platform admin ever sees the 400 (AC6).
 *
 * A malformed id is therefore audited with `targetTenantId: null` — there is no
 * tenant it could honestly name, and `recordAdminAction` would throw on
 * non-hex. The admin's call still happened and is still recorded.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { AppError, jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { adminTenantParamsSchema, getAdminTenant } from "@/server/services/admin-tenants";

export const dynamic = "force-dynamic";

type Params = { tenantId: string };

export const GET = route<Params>(async (request, { requestId, log, params, context }) => {
  const ctx = await context();

  const parsed = adminTenantParamsSchema.safeParse(params);
  const targetTenantId = parsed.success ? parsed.data.tenantId : null;

  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.tenants.read",
    targetTenantId,
    log,
  });

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request params", {
      source: "params",
      fields: { tenantId: "Expected a 24-character id" },
    });
  }

  return jsonOk(await getAdminTenant(parsed.data.tenantId), requestId);
});
