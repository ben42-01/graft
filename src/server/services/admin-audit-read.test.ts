/** The read side of the admin audit log. */
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import {
  buildAuditFilter,
  listAdminAudit,
  toAdminAuditRow,
  type AdminAuditDoc,
} from "./admin-audit-read";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));

const auditDoc = (n: number, over: Partial<AdminAuditDoc> = {}): AdminAuditDoc => ({
  _id: oid(n),
  actorUserId: oid(100),
  action: "admin.tenant.tier",
  targetTenantId: oid(900),
  requestId: `req-${n}`,
  at: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

describe("toAdminAuditRow", () => {
  it("resolves actor email and tenant name, and keeps only typed detail fields", () => {
    const row = toAdminAuditRow(
      auditDoc(1, {
        fromTier: "free",
        toTier: "premium",
        reason: "deal",
        changed: true,
        ok: "yes",
      }),
      new Map([[oid(100).toHexString(), "admin@example.test"]]),
      new Map([[oid(900).toHexString(), { name: "Acme", slug: "acme" }]]),
    );
    expect(row.actorEmail).toBe("admin@example.test");
    expect(row.targetTenantName).toBe("Acme");
    expect(row.details).toEqual({
      fromTier: "free",
      toTier: "premium",
      reason: "deal",
      changed: true,
    });
  });

  it("handles a row about no tenant", () => {
    const row = toAdminAuditRow(auditDoc(1, { targetTenantId: null }), new Map(), new Map());
    expect(row.targetTenantId).toBeNull();
    expect(row.targetTenantName).toBeNull();
    expect(row.actorEmail).toBeNull();
  });
});

describe("buildAuditFilter", () => {
  it("matches the action as a literal prefix and `writes` as rows with an outcome", () => {
    const filter = buildAuditFilter({ action: "admin.tenant", kind: "writes" });
    expect(filter.action).toEqual({ $regex: "^admin\\.tenant" });
    expect(filter.ok).toEqual({ $exists: true });
  });

  it("builds an inclusive date range", () => {
    const filter = buildAuditFilter({ from: "2026-09-01", to: "2026-09-02" });
    expect(filter.at).toEqual({ $gte: new Date("2026-09-01"), $lte: new Date("2026-09-02") });
  });
});

describe("listAdminAudit", () => {
  const store = {
    listAudit: async (_f: unknown, limit: number) => [auditDoc(2), auditDoc(1)].slice(0, limit),
    userEmails: async () => new Map<string, string>(),
    tenantLabels: async () => new Map(),
  };

  it("pages and serialises", async () => {
    const result = await listAdminAudit({ limit: "1" }, { store });
    expect(result.items).toHaveLength(1);
    expect(result.meta.hasMore).toBe(true);
  });

  it("refuses a free-text action that is not a dotted verb", async () => {
    await expect(listAdminAudit({ action: ".*" }, { store })).rejects.toBeInstanceOf(AppError);
  });
});
