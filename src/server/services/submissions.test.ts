/**
 * The submissions inbox — unit coverage for the join that says, for each
 * submission, which form it came through, who sent it and what it raised.
 */
import { describe, expect, it } from "vitest";
import {
  addOrder,
  ctxFor,
  daysAgo,
  depsFor,
  emptyWorld,
  FORM_ID,
  OTHER_TENANT,
} from "@/server/testing/bms-fixtures";
import { listSubmissions } from "./submissions";

const ctx = ctxFor();

describe("listSubmissions", () => {
  it("lists submissions newest first with their form, customer and order", async () => {
    const world = emptyWorld();
    addOrder(world, { createdAt: daysAgo(2), totalMinor: 4_000 });
    const latest = addOrder(world, {
      createdAt: daysAgo(1),
      totalMinor: 6_000,
      status: "pending_payment",
      paid: [{ amountMinor: 1_500, at: daysAgo(1) }],
      data: { first_name: "Grace", email: "grace@example.test" },
    });

    const { items, meta } = await listSubmissions(ctx, {}, depsFor(world));

    expect(meta.hasMore).toBe(false);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      createdAt: daysAgo(1),
      form: { id: FORM_ID.toHexString(), name: "Fruit box order" },
      recordId: latest.customerRecordId!.toHexString(),
      customer: { name: "Grace", email: "grace@example.test" },
      order: {
        id: latest._id.toHexString(),
        status: "pending_payment",
        currency: "EUR",
        totalMinor: 6_000,
        balanceMinor: 4_500,
      },
    });
    expect(items[1].customer?.name).toBe("Ada Lovelace");
  });

  it("shows a submission that raised no order, and one whose record is gone", async () => {
    const world = emptyWorld();
    addOrder(world);
    world.submissions[0].orderId = null;
    world.records[0].deletedAt = new Date();

    const { items } = await listSubmissions(ctx, {}, depsFor(world));
    expect(items[0].order).toBeNull();
    expect(items[0].customer).toBeNull();
    expect(items[0].form.name).toBe("Fruit box order");
  });

  it("narrows to one form and pages", async () => {
    const world = emptyWorld();
    addOrder(world);
    addOrder(world);
    const deps = depsFor(world);

    expect(
      (await listSubmissions(ctx, { formId: "0000000000000000000000f9" }, deps)).items,
    ).toEqual([]);
    expect(
      (await listSubmissions(ctx, { formId: FORM_ID.toHexString() }, deps)).items,
    ).toHaveLength(2);

    const page = await listSubmissions(ctx, { limit: 1 }, deps);
    expect(page.items).toHaveLength(1);
    expect(page.meta.hasMore).toBe(true);
  });

  it("never shows another tenant's submissions", async () => {
    const world = emptyWorld();
    addOrder(world, { tenantId: OTHER_TENANT });
    expect((await listSubmissions(ctx, {}, depsFor(world))).items).toEqual([]);
  });

  it("refuses a form id that is not an id", async () => {
    await expect(
      listSubmissions(ctx, { formId: "nope" }, depsFor(emptyWorld())),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
