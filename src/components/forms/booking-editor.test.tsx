/**
 * Configuring booking mode.
 *
 * Every test here is about the same thing: this panel decides what happens to
 * a customer's money and a resource's calendar, so it must not offer a
 * configuration the server is going to refuse — no booking without a catalogue
 * selection, no start on a field that cannot hold a time, and never an end
 * field and a fixed duration at once.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BookingEditor, type BookingView } from "./booking-editor";
import type { FieldLike } from "@/lib/entities/record-values";

const formFields: FieldLike[] = [
  { key: "customer", label: "Customer", type: "text" },
  { key: "starts_at", label: "From", type: "date" },
  { key: "ends_at", label: "Until", type: "date" },
  { key: "people", label: "People", type: "number" },
];

/** The catalogue entity — what the rate and label mappings choose from. */
const resourceFields: FieldLike[] = [
  { key: "boat_name", label: "Boat", type: "text" },
  { key: "price_per_hour", label: "Price per hour", type: "number" },
];

const props = {
  booking: null as BookingView | null,
  formFields,
  resourceFields,
  hasSelection: true,
  busy: false,
  onSave: vi.fn(),
};

/** Radix selects need a pointer-events shim under jsdom. */
async function choose(label: string, option: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const enable = () =>
  userEvent
    .setup({ pointerEventsCheck: 0 })
    .click(screen.getByRole("checkbox", { name: /take bookings/i }));

describe("BookingEditor", () => {
  it("cannot be switched on without a catalogue selection, and says why", () => {
    render(<BookingEditor {...props} hasSelection={false} />);

    expect(screen.getByRole("checkbox", { name: /take bookings/i })).toBeDisabled();
    expect(screen.getByText(/set up the catalogue first/i)).toBeInTheDocument();
  });

  it("offers only date fields as the booking's start", async () => {
    render(<BookingEditor {...props} />);
    await enable();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("combobox", { name: "Booking starts at" }));

    expect(await screen.findByRole("option", { name: "From" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Until" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Customer" })).not.toBeInTheDocument();
  });

  it("saves a start-and-end config with no duration", async () => {
    const onSave = vi.fn();
    render(<BookingEditor {...props} onSave={onSave} />);
    await enable();

    await choose("Booking starts at", "From");
    await choose("Booking ends at", "Until");
    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole("button", { name: /save bookings/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        startKey: "starts_at",
        endKey: "ends_at",
        // The server refuses a config carrying both; the radio is what makes
        // that unrepresentable here.
        durationMinutes: null,
      }),
    );
  });

  it("saves a fixed-duration config with no end field", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookingEditor {...props} onSave={onSave} />);
    await enable();

    await choose("Booking starts at", "From");
    await user.click(screen.getByRole("radio", { name: /fixed length/i }));
    const minutes = screen.getByRole("spinbutton", { name: /length in minutes/i });
    await user.clear(minutes);
    await user.type(minutes, "90");
    await user.click(screen.getByRole("button", { name: /save bookings/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ endKey: null, durationMinutes: 90 }),
    );
  });

  it("never offers the start field as the end", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<BookingEditor {...props} />);
    await enable();

    await choose("Booking starts at", "From");
    await user.click(screen.getByRole("combobox", { name: "Booking ends at" }));

    expect(await screen.findByRole("option", { name: "Until" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "From" })).not.toBeInTheDocument();
  });

  it("cannot be saved until the whole window is described", async () => {
    render(<BookingEditor {...props} />);
    await enable();

    const save = () => screen.getByRole("button", { name: /save bookings/i });
    expect(save()).toBeDisabled();

    // A start with no end is a half-described booking, not a default the
    // panel should quietly fill in on the builder's behalf.
    await choose("Booking starts at", "From");
    expect(save()).toBeDisabled();

    await choose("Booking ends at", "Until");
    expect(save()).toBeEnabled();
  });

  it("turning booking mode off saves null rather than a half-filled config", async () => {
    const onSave = vi.fn();
    render(
      <BookingEditor
        {...props}
        booking={{
          startKey: "starts_at",
          endKey: "ends_at",
          durationMinutes: null,
          quantityKey: null,
          rateBasis: "hourly",
          rateKey: null,
          labelKey: null,
          depositPercent: null,
        }}
        onSave={onSave}
      />,
    );

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole("checkbox", { name: /take bookings/i }));
    await user.click(screen.getByRole("button", { name: /save bookings/i }));

    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("offers the catalogue entity's own fields as the rate and the name", async () => {
    const onSave = vi.fn();
    render(<BookingEditor {...props} onSave={onSave} />);
    await enable();

    await choose("Booking starts at", "From");
    await choose("Booking ends at", "Until");
    // Typed: only numbers can be a rate, only text can be a name. Offering a
    // text field as the rate is the mistake that used to price at zero.
    await choose("Price comes from", "Price per hour");
    await choose("Name the resource by", "Boat");

    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole("button", { name: /save bookings/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ rateKey: "price_per_hour", labelKey: "boat_name" }),
    );
  });

  it("warns that an unmapped rate prices every booking at zero", async () => {
    render(<BookingEditor {...props} />);
    await enable();

    expect(screen.getByText(/priced at zero/i)).toBeInTheDocument();
  });

  it("says what to do when the catalogue entity has nothing to price from", async () => {
    render(
      <BookingEditor {...props} resourceFields={[{ key: "n", label: "N", type: "text" }]} />,
    );
    await enable();

    expect(screen.getByRole("combobox", { name: "Price comes from" })).toBeDisabled();
    expect(screen.getByText(/no number field/i)).toBeInTheDocument();
  });
});
