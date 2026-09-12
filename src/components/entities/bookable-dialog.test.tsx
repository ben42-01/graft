/**
 * Making a record bookable.
 *
 * The rules under test are the server's, surfaced early: strategy is a
 * creation-time choice and a fact afterwards, an individual asset is never
 * asked how many of it there are, and stopping bookings is a two-step that
 * says what it does and does not destroy.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookableDialog, type PoolView } from "./bookable-dialog";

const props = {
  open: true,
  onOpenChange: vi.fn(),
  entityId: "ent1",
  recordId: "rec1",
  recordLabel: "24ft Pontoon Boat",
  pool: null as PoolView | null,
  onSaved: vi.fn(),
};

const pool = (over: Partial<PoolView> = {}): PoolView => ({
  id: "pool1",
  entityId: "ent1",
  recordId: "rec1",
  strategy: "individual_asset",
  totalQuantity: 1,
  bufferMinutes: 30,
  ...over,
});

const ok = () => Promise.resolve({ ok: true, json: async () => ({ data: {} }) } as Response);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(ok);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Radix selects need a pointer-events shim under jsdom. */
async function choose(label: string, option: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const body = (call: number) =>
  JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

describe("BookableDialog — creating a pool", () => {
  it("does not ask how many of an individual asset there are", () => {
    render(<BookableDialog {...props} />);

    expect(screen.queryByLabelText(/how many/i)).not.toBeInTheDocument();
  });

  it("asks for a quantity once the resource is a stock of things", async () => {
    render(<BookableDialog {...props} />);

    await choose("What is it?", "A stock of identical things");
    expect(screen.getByLabelText(/how many/i)).toBeInTheDocument();
  });

  it("posts a new pool with the strategy and buffer chosen", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookableDialog {...props} />);

    const buffer = screen.getByLabelText(/time needed in between/i);
    await user.clear(buffer);
    await user.type(buffer, "30");
    await user.click(screen.getByRole("button", { name: /make bookable/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/inventory/pools");
    expect(body(0)).toEqual({
      entityId: "ent1",
      recordId: "rec1",
      strategy: "individual_asset",
      bufferMinutes: 30,
    });
  });

  it("sends the quantity only for a strategy that has one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookableDialog {...props} />);

    await choose("What is it?", "A stock of identical things");
    const quantity = screen.getByLabelText(/how many/i);
    await user.clear(quantity);
    await user.type(quantity, "50");
    await user.click(screen.getByRole("button", { name: /make bookable/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(body(0)).toMatchObject({ strategy: "pooled_quantity", totalQuantity: 50 });
  });

  it("will not save a stock of zero", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookableDialog {...props} />);

    await choose("What is it?", "A stock of identical things");
    await user.clear(screen.getByLabelText(/how many/i));

    expect(screen.getByRole("button", { name: /make bookable/i })).toBeDisabled();
  });

  it("surfaces the server's own message when the write is refused", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "That resource already has an inventory pool" } }),
    } as Response);
    render(<BookableDialog {...props} />);

    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole("button", { name: /make bookable/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already has an inventory pool/i,
    );
  });
});

describe("BookableDialog — an existing pool", () => {
  it("locks the strategy and explains why", () => {
    render(<BookableDialog {...props} pool={pool()} />);

    expect(screen.getByRole("combobox", { name: "What is it?" })).toBeDisabled();
    expect(screen.getByText(/cannot be changed/i)).toBeInTheDocument();
  });

  it("patches without the strategy, which the server refuses to change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookableDialog {...props} pool={pool()} />);

    const buffer = screen.getByLabelText(/time needed in between/i);
    await user.clear(buffer);
    await user.type(buffer, "45");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/inventory/pools/pool1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
    // Neither the strategy nor a quantity for an individually tracked asset,
    // both of which `updatePool` rejects.
    expect(body(0)).toEqual({ bufferMinutes: 45 });
  });

  it("sends a changed quantity for a pooled resource", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <BookableDialog
        {...props}
        pool={pool({ strategy: "pooled_quantity", totalQuantity: 50 })}
      />,
    );

    const quantity = screen.getByLabelText(/how many/i);
    await user.clear(quantity);
    await user.type(quantity, "60");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(body(0)).toMatchObject({ totalQuantity: 60 });
  });

  it("confirms before stopping bookings, and says history is kept", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookableDialog {...props} pool={pool()} />);

    await user.click(screen.getByRole("button", { name: /stop taking bookings/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/stay exactly as they are/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /yes, stop bookings/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/inventory/pools/pool1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
