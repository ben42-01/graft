/**
 * The order form — component coverage. What is pinned: the amounts are the
 * server's to compute (only description, quantity and unit price go up), a
 * discount is sent negative however it was typed, and a booked line goes back
 * exactly as it arrived.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blankLine,
  lineError,
  OrderEditor,
  previewTotal,
  saveOrder,
  toEditorLine,
  toLineInput,
  type EditorLine,
  type OrderDraft,
} from "./order-editor";

const line = (over: Partial<EditorLine> = {}): EditorLine => ({
  ...blankLine(),
  description: "Veg box",
  quantity: "3",
  price: "22.00",
  ...over,
});

const draft = (over: Partial<OrderDraft> = {}): OrderDraft => ({
  currency: "EUR",
  customerRecordId: "",
  depositPercent: "",
  notes: "",
  lines: [blankLine()],
  ...over,
});

const booked = {
  kind: "resource" as const,
  description: "24ft Pontoon Boat",
  quantity: 1,
  unitAmountMinor: 60_000,
  poolId: "pool-1",
  allocationId: "alloc-1",
  recordId: "rec-1",
};

function stubCustomers() {
  const customers = [
    {
      id: "rec-ada",
      entityId: "e1",
      name: "Ada Lovelace",
      email: "ada@example.test",
      phone: null,
      recordIds: ["rec-ada", "rec-ada-2"],
      orderCount: 2,
      openOrderCount: 0,
      money: [],
      firstOrderAt: "2026-05-01T09:00:00.000Z",
      lastOrderAt: "2026-06-01T09:00:00.000Z",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: customers })))),
  );
}

describe("line helpers", () => {
  it("sends description, quantity and unit price — never an amount", () => {
    expect(toLineInput(line())).toEqual({
      kind: "resource",
      description: "Veg box",
      quantity: 3,
      unitAmountMinor: 2_200,
    });
  });

  it("sends a discount negative, and accepts a comma as the decimal mark", () => {
    expect(toLineInput(line({ kind: "discount", quantity: "1", price: "5,50" }))).toMatchObject(
      {
        kind: "discount",
        unitAmountMinor: -550,
      },
    );
  });

  it("sends a booked line back exactly as it arrived, whatever the fields say", () => {
    const editor = { ...toEditorLine(booked), description: "tampered", price: "1" };
    expect(editor.locked).not.toBeNull();
    expect(toLineInput(editor)).toEqual(booked);
    expect(lineError(editor)).toBeNull();
  });

  it("leaves an ordinary existing line editable, with its price in major units", () => {
    const editor = toEditorLine({
      kind: "fee",
      description: "Delivery",
      quantity: 1,
      unitAmountMinor: 450,
    });
    expect(editor.locked).toBeNull();
    expect(editor.price).toBe("4.50");
  });

  it("names what is wrong with a line", () => {
    expect(lineError(line({ description: " " }))).toBe("Describe the item");
    expect(lineError(line({ quantity: "1.5" }))).toBe("Quantity must be a whole number");
    expect(lineError(line({ quantity: "0" }))).toBe("Quantity must be a whole number");
    expect(lineError(line({ price: "" }))).toBe("Enter a price");
    expect(lineError(line({ price: "abc" }))).toBe("Enter a price");
    expect(lineError(line({ price: "0" }))).toBeNull();
  });

  it("previews the total the way the server will price it", () => {
    const lines = [
      line(),
      line({ kind: "fee", quantity: "1", price: "4.50" }),
      line({ kind: "discount", quantity: "1", price: "5" }),
      line({ description: "" }), // unfinished — not counted
    ];
    expect(previewTotal(lines)).toBe(6_550);
    expect(previewTotal([line({ kind: "discount", quantity: "1", price: "999" })])).toBe(0);
  });
});

describe("OrderEditor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("submits the lines as typed and the customer chosen", async () => {
    stubCustomers();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_draft: OrderDraft): Promise<string | null> => null);
    render(
      <OrderEditor mode="create" initial={draft()} backHref="/back" onSubmit={onSubmit} />,
    );

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Who is it for?" }),
      await screen.findByRole("option", { name: /Ada Lovelace/ }),
    );
    await user.type(screen.getByRole("textbox", { name: "Line 1 description" }), "Fruit box");
    await user.clear(screen.getByRole("textbox", { name: "Line 1 quantity" }));
    await user.type(screen.getByRole("textbox", { name: "Line 1 quantity" }), "2");
    await user.type(screen.getByRole("textbox", { name: "Line 1 unit price" }), "35");
    expect(screen.getByText(/70\.00/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create order" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent.customerRecordId).toBe("rec-ada");
    expect(sent.lines.map(toLineInput)).toEqual([
      { kind: "resource", description: "Fruit box", quantity: 2, unitAmountMinor: 3_500 },
    ]);
  });

  it("does not submit an unfinished order, and says which line is wrong", async () => {
    stubCustomers();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => null);
    render(
      <OrderEditor mode="create" initial={draft()} backHref="/back" onSubmit={onSubmit} />,
    );

    await user.click(screen.getByRole("button", { name: "Create order" }));

    expect(screen.getByText("Describe the item")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("adds and removes lines, but never the last one", async () => {
    stubCustomers();
    const user = userEvent.setup();
    render(<OrderEditor mode="create" initial={draft()} backHref="/back" onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Remove line 1" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add a line" }));
    expect(screen.getByRole("textbox", { name: "Line 2 description" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove line 2" }));
    expect(
      screen.queryByRole("textbox", { name: "Line 2 description" }),
    ).not.toBeInTheDocument();
  });

  it("shows a booked line locked, keeps the order's customer selected, and hides currency on an edit", async () => {
    stubCustomers();
    render(
      <OrderEditor
        mode="edit"
        initial={draft({ customerRecordId: "rec-ada-2", lines: [toEditorLine(booked)] })}
        backHref="/back"
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("1 × 24ft Pontoon Boat")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Line 1 description" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Booked items hold capacity/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Currency")).not.toBeInTheDocument();
    // The order points at Ada's *second* record; the select still shows Ada.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Who is it for?" })).toHaveValue("rec-ada"),
    );
  });

  it("shows the server's reason when the save is refused, and lets it be retried", async () => {
    stubCustomers();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => "Only a draft order can be edited.");
    render(
      <OrderEditor
        mode="edit"
        initial={draft({ lines: [line()] })}
        backHref="/back"
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a draft order can be edited.",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});

describe("saveOrder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the saved order's id", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { id: "o1" } }), { status: 201 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveOrder("POST", "/api/v1/orders", { a: 1 })).toEqual({ id: "o1" });
  });

  it("returns the server's message on a refusal, and a plain one when there is none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "Nope" } }), { status: 409 }),
        ),
      ),
    );
    expect(await saveOrder("PATCH", "/x", {})).toEqual({ error: "Nope" });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    expect(await saveOrder("PATCH", "/x", {})).toEqual({
      error: "We couldn't save that order. Please try again.",
    });
  });
});
