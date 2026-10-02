/**
 * Customers — unit coverage for the derivation that turns "an order points at
 * a record" into "this is who ordered".
 *
 * The properties tested hardest: identity is read by field type, the same
 * email across orders is one customer, another tenant's rows are never
 * joined in, and a deleted record leaves nobody named rather than a stale
 * copy.
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
import { memoryRepository } from "@/server/testing/memory-repository";
import type { FieldDef } from "./entities";
import {
  customerAnswers,
  customerIdentity,
  getCustomer,
  listCustomers,
  orderWithCustomer,
  resolveCustomerDeps,
  withCustomers,
} from "./customers";
import { toOrderView, type OrderDoc } from "./orders";

const ctx = ctxFor();

const field = (key: string, type: FieldDef["type"], label = key): FieldDef => ({
  key,
  label,
  type,
  required: false,
});

describe("customerIdentity", () => {
  it("joins first and last name and reads email and phone by field type", () => {
    const fields = [
      field("first_name", "text"),
      field("last_name", "text"),
      field("contact", "email"),
      field("tel", "phone"),
    ];
    expect(
      customerIdentity(fields, {
        first_name: " Ada ",
        last_name: "Lovelace",
        contact: "Ada@Example.Test",
        tel: "+49 30 1234",
      }),
    ).toEqual({ name: "Ada Lovelace", email: "ada@example.test", phone: "+49 30 1234" });
  });

  it("falls back to the first text field when nothing calls itself a name", () => {
    const fields = [field("who", "text", "Who is this for?"), field("comment", "text")];
    expect(customerIdentity(fields, { who: "Grace", comment: "ring twice" }).name).toBe(
      "Grace",
    );
  });

  it("recognises a name by its label, not only its key", () => {
    const fields = [field("comment", "text"), field("f1", "text", "Your name")];
    expect(customerIdentity(fields, { comment: "hello", f1: "Linus" }).name).toBe("Linus");
  });

  it("reports nothing rather than inventing a value", () => {
    expect(customerIdentity([field("qty", "number")], { qty: 3 })).toEqual({
      name: null,
      email: null,
      phone: null,
    });
    expect(customerIdentity([field("name", "text")], { name: "   " }).name).toBeNull();
  });
});

describe("customerAnswers", () => {
  it("labels answers and leaves out media ids, blanks and objects", () => {
    const fields = [
      field("name", "text", "Name"),
      field("gift", "checkbox", "Gift wrap"),
      field("photo", "image"),
      field("empty", "text"),
      field("blob", "text"),
      field("qty", "number", "How many"),
    ];
    expect(
      customerAnswers(fields, {
        name: "Ada",
        gift: false,
        photo: "000000000000000000000abc",
        empty: "",
        blob: { nested: true },
        qty: 2,
      }),
    ).toEqual([
      { key: "name", label: "Name", type: "text", value: "Ada" },
      { key: "gift", label: "Gift wrap", type: "checkbox", value: "No" },
      { key: "qty", label: "How many", type: "number", value: "2" },
    ]);
  });
});

describe("withCustomers", () => {
  it("names the customer and the form the order came through", async () => {
    const world = emptyWorld();
    const order = addOrder(world);
    const [view] = await withCustomers(ctx, [toOrderView(order)], depsFor(world));

    expect(view.customer).toMatchObject({
      recordId: order.customerRecordId!.toHexString(),
      name: "Ada Lovelace",
      email: "ada@example.test",
      phone: null,
    });
    expect(view.source).toMatchObject({
      formId: FORM_ID.toHexString(),
      formName: "Fruit box order",
    });
  });

  it("leaves a hand-drafted order without a source, and an anonymous one without a customer", async () => {
    const world = emptyWorld();
    const manual = addOrder(world, { viaForm: false });
    const anonymous = addOrder(world, { data: null });
    const views = await withCustomers(
      ctx,
      [manual, anonymous].map(toOrderView),
      depsFor(world),
    );

    expect(views[0].customer?.name).toBe("Ada Lovelace");
    expect(views[0].source).toBeNull();
    expect(views[1].customer).toBeNull();
    expect(views[1].source).toBeNull();
  });

  it("names nobody once the customer's record has been deleted", async () => {
    const world = emptyWorld();
    const order = addOrder(world);
    world.records[0].deletedAt = new Date();
    const [view] = await withCustomers(ctx, [toOrderView(order)], depsFor(world));
    expect(view.customer).toBeNull();
  });

  it("never joins another tenant's record onto an order", async () => {
    const world = emptyWorld();
    const foreign = addOrder(world, { tenantId: OTHER_TENANT });
    // Our order, pointed at their record — the join must come back empty.
    const ours = addOrder(world, { data: null });
    ours.customerRecordId = foreign.customerRecordId;

    const [view] = await withCustomers(ctx, [toOrderView(ours)], depsFor(world));
    expect(view.customer).toBeNull();
  });

  it("does no reads for an empty page", async () => {
    expect(await withCustomers(ctx, [], depsFor(emptyWorld()))).toEqual([]);
  });
});

describe("orderWithCustomer", () => {
  it("adds what the customer entered", async () => {
    const world = emptyWorld();
    const order = addOrder(world, {
      data: { first_name: "Ada", email: "ada@example.test", notes: "Leave at the door" },
    });
    const view = await orderWithCustomer(ctx, toOrderView(order), depsFor(world));
    expect(view.customer?.name).toBe("Ada");
    expect(view.answers.map((answer) => answer.label)).toEqual([
      "First name",
      "Email",
      "Anything else?",
    ]);
  });

  it("has no answers for an order with no customer", async () => {
    const world = emptyWorld();
    const order = addOrder(world, { data: null });
    const view = await orderWithCustomer(ctx, toOrderView(order), depsFor(world));
    expect(view.answers).toEqual([]);
  });
});

describe("listCustomers", () => {
  const trading = () => {
    const world = emptyWorld();
    const first = addOrder(world, {
      createdAt: daysAgo(40),
      totalMinor: 4_000,
      status: "completed",
      paid: [{ amountMinor: 4_000, at: daysAgo(40) }],
      data: { first_name: "Ada", email: "ada@example.test" },
    });
    addOrder(world, {
      createdAt: daysAgo(2),
      totalMinor: 6_000,
      paid: [{ amountMinor: 1_000, at: daysAgo(2) }],
      data: {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ADA@example.test",
        mobile: "0151",
      },
    });
    addOrder(world, {
      createdAt: daysAgo(1),
      totalMinor: 9_000,
      status: "cancelled",
      data: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.test" },
    });
    addOrder(world, {
      createdAt: daysAgo(5),
      totalMinor: 20_000,
      status: "draft",
      data: { first_name: "Grace", last_name: "Hopper" },
    });
    addOrder(world, { tenantId: OTHER_TENANT, data: { first_name: "Mallory" } });
    return { world, first };
  };

  it("groups orders that share an email into one customer", async () => {
    const { world, first } = trading();
    const { items, meta } = await listCustomers(ctx, {}, depsFor(world));

    expect(meta).toEqual({ total: 2, limit: 25, truncated: false });
    const ada = items.find((customer) => customer.email === "ada@example.test")!;
    expect(ada.orderCount).toBe(3);
    expect(ada.openOrderCount).toBe(1);
    // The id is the oldest record, so it does not move when they order again.
    expect(ada.id).toBe(first.customerRecordId!.toHexString());
    expect(ada.recordIds).toHaveLength(3);
    // The freshest details that are actually filled in.
    expect(ada.phone).toBe("0151");
    expect(ada.firstOrderAt).toEqual(daysAgo(40));
    expect(ada.lastOrderAt).toEqual(daysAgo(1));
  });

  it("totals money per currency and leaves cancelled orders out of it", async () => {
    const { world } = trading();
    const { items } = await listCustomers(ctx, { q: "ada" }, depsFor(world));
    expect(items[0].money).toEqual([
      { currency: "EUR", bookedMinor: 10_000, paidMinor: 5_000, outstandingMinor: 5_000 },
    ]);
  });

  it("keeps customers with no email apart, and never shows another tenant's", async () => {
    const { world } = trading();
    const { items } = await listCustomers(ctx, {}, depsFor(world));
    expect(items.map((customer) => customer.name)).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  it("searches name, email and phone, and sorts by spend or order count", async () => {
    const { world } = trading();
    const deps = depsFor(world);
    expect((await listCustomers(ctx, { q: "hopper" }, deps)).items).toHaveLength(1);
    expect((await listCustomers(ctx, { q: "0151" }, deps)).items[0].name).toBe("Ada Lovelace");
    expect((await listCustomers(ctx, { q: "nobody" }, deps)).items).toEqual([]);
    expect((await listCustomers(ctx, { sort: "spend" }, deps)).items[0].name).toBe(
      "Grace Hopper",
    );
    expect((await listCustomers(ctx, { sort: "orders" }, deps)).items[0].name).toBe(
      "Ada Lovelace",
    );
    expect((await listCustomers(ctx, { limit: 1 }, deps)).items).toHaveLength(1);
  });

  it("refuses a sort it does not know", async () => {
    await expect(
      listCustomers(ctx, { sort: "random" }, depsFor(emptyWorld())),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("getCustomer", () => {
  it("resolves any of a customer's record ids to the same profile", async () => {
    const world = emptyWorld();
    const older = addOrder(world, { createdAt: daysAgo(9) });
    const newer = addOrder(world, {
      createdAt: daysAgo(1),
      data: { first_name: "Ada", email: "ada@example.test", notes: "Ring twice" },
    });
    const deps = depsFor(world);

    const viaOld = await getCustomer(ctx, older.customerRecordId!.toHexString(), deps);
    const viaNew = await getCustomer(ctx, newer.customerRecordId!.toHexString(), deps);

    expect(viaOld.id).toBe(viaNew.id);
    expect(viaOld.orders.map((order) => order.id)).toEqual([
      newer._id.toHexString(),
      older._id.toHexString(),
    ]);
    expect(viaOld.orders[0].source?.formName).toBe("Fruit box order");
    // Answers come from the most recent submission.
    expect(viaOld.answers.at(-1)).toMatchObject({
      label: "Anything else?",
      value: "Ring twice",
    });
  });

  it("is not found for an unknown id, a record nobody ordered with, or another tenant's customer", async () => {
    const world = emptyWorld();
    const foreign = addOrder(world, { tenantId: OTHER_TENANT });
    const deps = depsFor(world);

    for (const id of ["0000000000000000000000aa", foreign.customerRecordId!.toHexString()]) {
      await expect(getCustomer(ctx, id, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("resolveCustomerDeps", () => {
  it("keeps the real repositories for anything not overridden", () => {
    const orders = memoryRepository<OrderDoc>("orders", []);
    const deps = resolveCustomerDeps({ orders });
    expect(deps.orders).toBe(orders);
    expect(deps.records.collectionName).toBe("records");
    expect(deps.submissions.collectionName).toBe("form_submissions");
  });
});
