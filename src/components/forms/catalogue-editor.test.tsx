/**
 * Configuring catalogue mode.
 *
 * Every test here is about the same thing: publishing a catalogue makes tenant
 * data readable by anonymous visitors, so nothing gets published by accident.
 * Fields start unticked, changing the browsed entity drops the field list, and
 * the two entity choices stay separate questions.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CatalogueEditor, MAX_CATALOGUE_FIELDS, type EntityOption } from "./catalogue-editor";
import type { FieldLike } from "@/lib/entities/record-values";

const items: EntityOption = {
  id: "cat1",
  name: "Rental Items",
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "price", label: "Price", type: "number" },
    { key: "cost", label: "Cost price", type: "number" },
    { key: "photo", label: "Photo", type: "image" },
  ],
};

const bookings: EntityOption = {
  id: "sub1",
  name: "Bookings",
  fields: [
    { key: "customer", label: "Customer", type: "text" },
    { key: "chosen_item", label: "Chosen item", type: "text" },
    { key: "when", label: "When", type: "date" },
  ],
};

const props = {
  catalogue: null,
  entities: [items, bookings],
  submissionFields: bookings.fields as FieldLike[],
  busy: false,
  onSave: vi.fn(),
};

/** Radix selects need a pointer-events shim under jsdom. */
async function choose(label: string, option: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("CatalogueEditor", () => {
  it("is off until asked for, and saves null to turn it off again", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<CatalogueEditor {...props} onSave={onSave} />);

    expect(screen.queryByRole("combobox", { name: "Records to show" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save catalogue" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("publishes nothing by default — every field starts unticked", async () => {
    const user = userEvent.setup();

    render(<CatalogueEditor {...props} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));
    await choose("Records to show", "Rental Items");

    const group = screen.getByRole("group");
    for (const box of within(group).getAllByRole("checkbox")) {
      expect(box).not.toBeChecked();
    }
  });

  it("says plainly what ticking a field means", async () => {
    const user = userEvent.setup();

    render(<CatalogueEditor {...props} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));
    await choose("Records to show", "Rental Items");

    expect(screen.getByText(/Anyone with the link can see these/)).toBeInTheDocument();
    expect(screen.getByText(/stays private, including anything you add/)).toBeInTheDocument();
  });

  it("offers only image fields as the picture, and says so when there are none", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<CatalogueEditor {...props} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));
    await choose("Records to show", "Rental Items");

    await user.click(screen.getByRole("combobox", { name: "Picture" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["No picture", "Photo"]);
  });

  it("offers only text fields of the form's own entity for the selection", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<CatalogueEditor {...props} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));
    await choose("Records to show", "Rental Items");

    await user.click(screen.getByRole("combobox", { name: "Record the choice in" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    // "Customer" and "Chosen item" are text on Bookings; "When" is a date and
    // "Name" belongs to the *browsed* entity, so neither is offered.
    expect(options).toEqual(["Don't record it", "Customer", "Chosen item"]);
  });

  it("drops the field list when the browsed entity changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onSave = vi.fn();

    render(<CatalogueEditor {...props} onSave={onSave} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));
    await choose("Records to show", "Rental Items");
    await user.click(screen.getByRole("checkbox", { name: "Price" }));

    // Keys belong to the old entity; carrying them over would publish whatever
    // happens to share a name on the new one.
    await choose("Records to show", "Bookings");
    await user.click(screen.getByRole("button", { name: "Save catalogue" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fields: [] }));
  });

  it("stops at the field cap rather than silently dropping the extras", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const many: EntityOption = {
      id: "cat2",
      name: "Many",
      fields: Array.from({ length: MAX_CATALOGUE_FIELDS + 2 }, (_, i) => ({
        key: `f${i}`,
        label: `Field ${i}`,
        type: "text",
      })),
    };

    render(<CatalogueEditor {...props} entities={[many]} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));
    await choose("Records to show", "Many");

    const boxes = within(screen.getByRole("group")).getAllByRole("checkbox");
    for (let i = 0; i < MAX_CATALOGUE_FIELDS; i += 1) await user.click(boxes[i]!);

    expect(
      screen.getByText(`Details to show (${MAX_CATALOGUE_FIELDS}/${MAX_CATALOGUE_FIELDS})`),
    ).toBeInTheDocument();
    expect(boxes[MAX_CATALOGUE_FIELDS]).toBeDisabled();
  });

  it("cannot be saved on without an entity to browse", async () => {
    const user = userEvent.setup();

    render(<CatalogueEditor {...props} />);
    await user.click(screen.getByRole("checkbox", { name: /Show a catalogue/ }));

    expect(screen.getByRole("button", { name: "Save catalogue" })).toBeDisabled();
  });

  it("re-seeds from the server's answer", () => {
    render(
      <CatalogueEditor
        {...props}
        catalogue={{
          entityId: "cat1",
          fields: ["name", "price"],
          imageField: "photo",
          pageSize: 12,
          selectionKey: "chosen_item",
        }}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /Show a catalogue/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Name" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Cost price" })).not.toBeChecked();
  });
});
