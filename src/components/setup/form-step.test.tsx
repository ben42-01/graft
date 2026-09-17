/**
 * The last step of a guided run — what it actually sends.
 *
 * The payload is the contract here: a booking form that goes live with the
 * rate unmapped prices every booking at zero, and one whose chosen-item field
 * is offered to the visitor lets them name the resource themselves. Both are
 * silent failures, so both are asserted on the request body rather than on
 * what the screen says.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormStep } from "./form-step";
import type { FieldLike } from "@/lib/entities/record-values";

const resourceFields: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "description", label: "Description", type: "text", required: false },
  { key: "photo", label: "Photo", type: "image", required: false },
  { key: "price", label: "Price", type: "number", required: false },
];

const requestFields: FieldLike[] = [
  { key: "name", label: "Their name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "starts_at", label: "From", type: "date", required: true },
  // Required, like the flow creates it: a mapped end is mandatory to the
  // booking engine, so an optional one is refused at configuration time.
  { key: "ends_at", label: "Until", type: "date", required: true },
  { key: "selected_item", label: "Chosen item", type: "text", required: false },
];

const props = {
  thingLabel: "Kilns",
  resourceEntityId: "0000000000000000000000e1",
  resourceFields,
  requestEntityId: "0000000000000000000000e2",
  requestFields,
  created: null,
  onCreated: vi.fn(),
  onPublished: vi.fn(),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ data: { id: "f1", publicSlug: null, published: false } }),
    } as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const sentBody = () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

/** Only present in booking mode with a rate field mapped — picks one so the
 * rest of these tests can submit without every one of them re-asserting the
 * separate "no default rate basis" rule covered below. */
async function chooseRateBasis(label = "Per hour") {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const trigger = screen.queryByRole("combobox", { name: /and that price is/i });
  if (!trigger) return;
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: label }));
}

async function submit() {
  await chooseRateBasis();
  await userEvent
    .setup({ pointerEventsCheck: 0 })
    .click(screen.getByRole("button", { name: /create the form/i }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

describe("FormStep — booking runs", () => {
  it("maps the rate and the label to real fields rather than leaving them to convention", async () => {
    render(<FormStep {...props} intent="bookings" />);
    await submit();

    const body = sentBody();
    expect(body.booking.rateKey).toBe("price");
    expect(body.booking.labelKey).toBe("name");
  });

  it("maps the dates from the requests list, where the visitor fills them in", async () => {
    render(<FormStep {...props} intent="bookings" />);
    await submit();

    const body = sentBody();
    expect(body.booking.startKey).toBe("starts_at");
    expect(body.booking.endKey).toBe("ends_at");
    // The server refuses both an end field and a duration.
    expect(body.booking.durationMinutes).toBeNull();
  });

  it("points the catalogue at the other list and names where the choice lands", async () => {
    render(<FormStep {...props} intent="bookings" />);
    await submit();

    const body = sentBody();
    expect(body.entityId).toBe(props.requestEntityId);
    expect(body.catalogue.entityId).toBe(props.resourceEntityId);
    expect(body.catalogue.selectionKey).toBe("selected_item");
    expect(body.catalogue.imageField).toBe("photo");
  });

  it("keeps the chosen item in the form's field list, or every submission 400s", async () => {
    // The server validates a submission against the form's own field list
    // *after* writing the catalogue selection into it. A form that omits the
    // key the selection lands in refuses every submission it ever receives
    // with "Unrecognized key(s): selected_item". The visitor never sees an
    // input for it — the renderer filters it out — but the form must declare
    // it.
    render(<FormStep {...props} intent="bookings" />);
    await submit();

    const keys = sentBody().fields.map((field: { key: string }) => field.key);
    expect(keys).toContain("selected_item");
    expect(keys).toContain("email");
  });

  it("refuses to create a priced-at-zero booking form silently", async () => {
    render(
      <FormStep
        {...props}
        intent="bookings"
        resourceFields={resourceFields.filter((field) => field.type !== "number")}
      />,
    );

    expect(screen.getByRole("button", { name: /create the form/i })).toBeDisabled();
    expect(screen.getByText(/raised at zero/i)).toBeInTheDocument();
  });

  it("refuses to create a booking form with no rate basis chosen", () => {
    // The exact "$3K for a hotel room" bug: leaving this on a silent default
    // would let an hourly rate get applied to what was actually a nightly
    // price, or the reverse.
    render(<FormStep {...props} intent="bookings" />);

    expect(screen.getByRole("button", { name: /create the form/i })).toBeDisabled();
    expect(screen.getByText(/per hour, per day, or a flat fee/i)).toBeInTheDocument();
  });

  it("says what is missing when the requests list has no date on it", async () => {
    render(
      <FormStep
        {...props}
        intent="bookings"
        requestFields={requestFields.filter((field) => field.type !== "date")}
      />,
    );

    expect(screen.getByRole("button", { name: /create the form/i })).toBeDisabled();
    expect(screen.getByText(/add a date field/i)).toBeInTheDocument();
  });
});

describe("FormStep — enquiry runs", () => {
  it("creates a catalogue form with no booking config at all", async () => {
    render(<FormStep {...props} intent="enquiries" />);
    await submit();

    const body = sentBody();
    expect(body.booking).toBeNull();
    expect(body.catalogue.selectionKey).toBe("selected_item");
  });

  it("asks nothing about rates, because nothing is being priced", () => {
    render(<FormStep {...props} intent="enquiries" />);
    expect(screen.queryByLabelText(/price comes from/i)).not.toBeInTheDocument();
  });
});

describe("FormStep — after creation", () => {
  it("publishes through the ordinary endpoint, and only then claims to be live", async () => {
    render(
      <FormStep
        {...props}
        intent="enquiries"
        created={{ id: "f1", publicSlug: null, published: false }}
      />,
    );

    expect(screen.getByText(/not live yet/i)).toBeInTheDocument();
    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole("button", { name: /publish it/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/forms/f1/publish");
  });
});

describe("FormStep — an end the visitor could leave blank", () => {
  it("refuses to map an optional end field, which the engine would reject at submit time", () => {
    render(
      <FormStep
        {...props}
        intent="bookings"
        requestFields={requestFields.map((field) =>
          field.key === "ends_at" ? { ...field, required: false } : field,
        )}
      />,
    );

    expect(screen.getByRole("button", { name: /create the form/i })).toBeDisabled();
    expect(screen.getByText(/cannot be worked out/i)).toBeInTheDocument();
  });

  it("is happy with no end field at all, because that is a fixed-duration booking", async () => {
    render(
      <FormStep
        {...props}
        intent="bookings"
        requestFields={requestFields.filter((field) => field.key !== "ends_at")}
      />,
    );

    await submit();
    const body = sentBody();
    expect(body.booking.endKey).toBeNull();
    expect(body.booking.durationMinutes).toBe(60);
  });
});
