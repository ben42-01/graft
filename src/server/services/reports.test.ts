/**
 * Reports — unit coverage (GRAFT-13 AC5): the Chart widget's data endpoint
 * refuses server-side, not just in the UI ("the lock is not client-only").
 */
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { QuotaResult } from "@/server/services/meters";
import { getMeterUsage } from "./reports";

const ctx: Ctx = createContext({
  requestId: "req-reports",
  tenantId: "000000000000000000000001",
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

const usage: QuotaResult = {
  meter: "records",
  period: "all",
  allowed: true,
  limit: 2000,
  used: 12,
  remaining: 1988,
  warned: false,
};

describe("getMeterUsage (AC5)", () => {
  it("refuses a Free tenant with FORBIDDEN before reading the meter", async () => {
    const can = vi.fn().mockResolvedValue(false);
    const peekQuota = vi.fn().mockResolvedValue(usage);

    await expect(getMeterUsage(ctx, "records", { can, peekQuota })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(peekQuota).not.toHaveBeenCalled();
  });

  it("returns the meter usage once `reports` is granted", async () => {
    const can = vi.fn().mockResolvedValue(true);
    const peekQuota = vi.fn().mockResolvedValue(usage);

    const result = await getMeterUsage(ctx, "records", { can, peekQuota });

    expect(can).toHaveBeenCalledWith(ctx, "reports");
    expect(result).toEqual(usage);
  });
});
