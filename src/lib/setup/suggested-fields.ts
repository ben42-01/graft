/**
 * The field shapes the guided flow starts each entity from.
 *
 * These are *roles*, not a vocabulary. The flow never asks anyone to call a
 * field `hourly_rate` or `name` so the engine can find it — the house rule
 * since booking rate and label became configured mappings is that the engine
 * is told which field plays a role, never left to guess from its key. What
 * these suggestions do is make sure the fields that can play those roles
 * *exist* by the time the form step asks which one does, so the dropdowns
 * there are never empty.
 *
 * Everything here is a starting point: each row is editable, removable and
 * renameable before the entity is created, exactly like an entity template.
 * The labels are generic on purpose — "Price", not "Day rate"; "Description",
 * not "Spec" — because the thing being set up could be anything.
 */
import type { OfferedFieldType } from "@/lib/entities/field-types";
import type { SetupIntent } from "./flow";

export type SuggestedField = {
  key: string;
  label: string;
  type: OfferedFieldType;
  required: boolean;
  /** Why it is here, shown as a hint. Empty for the self-evident ones. */
  note?: string;
};

/**
 * The key the chosen item lands in on a request record.
 *
 * The server owns this field's value: `resolveSelection` overwrites it and
 * refuses a selection outside the form's own catalogue. It still belongs in
 * the form's declared field list — the submission is validated against that
 * list *after* the selection is written into it — but the renderer never
 * draws an input for it. The flow creates it and says what it is for, rather
 * than leaving an unexplained column in the user's list.
 */
export const SELECTION_FIELD: SuggestedField = {
  key: "selected_item",
  label: "Chosen item",
  type: "text",
  required: false,
  note: "Filled in for you — which one they picked.",
};

/** The thing itself: what a record in the main list holds. */
export function suggestedResourceFields(intent: SetupIntent | null): SuggestedField[] {
  const base: SuggestedField[] = [
    { key: "name", label: "Name", type: "text", required: true },
    {
      key: "description",
      label: "Description",
      type: "text",
      required: false,
      note: "Shown to customers.",
    },
  ];

  if (intent === "list") return base;

  const shown: SuggestedField[] = [
    ...base,
    {
      key: "photo",
      label: "Photo",
      type: "image",
      required: false,
      // A picture is uploaded against a record that already exists, which is
      // why `fieldDefSchema` refuses a required one.
      note: "Added after the record exists, so it can never be required.",
    },
  ];

  if (intent === "enquiries") return shown;

  return [
    ...shown,
    {
      key: "price",
      label: "Price",
      type: "number",
      required: false,
      note: "What a booking of this is charged at. You choose the basis — per hour, per day, or flat — at the form step.",
    },
  ];
}

/**
 * The request: one record per person asking. This is the second entity, and
 * the one people do not expect — the record it creates *is* the customer, so
 * the contact details live here rather than in some separate customer list.
 */
export function suggestedRequestFields(intent: SetupIntent | null): SuggestedField[] {
  const contact: SuggestedField[] = [
    { key: "name", label: "Their name", type: "text", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "phone", label: "Phone", type: "phone", required: false },
  ];

  if (intent === "bookings") {
    return [
      ...contact,
      {
        key: "starts_at",
        label: "From",
        type: "date",
        required: true,
        note: "When the booking starts. Availability is checked against this.",
      },
      {
        key: "ends_at",
        label: "Until",
        type: "date",
        required: true,
        // Required because the booking engine treats a mapped end field as
        // mandatory: a blank one is refused at submit time, so an optional
        // "Until" is a box the form invites a visitor to skip and then
        // rejects them for skipping. Forms that would rather not ask map no
        // end field at all and take a fixed duration instead.
        note: "A booking needs both ends. If yours are always the same length, delete this and choose a fixed duration at the form step.",
      },
      SELECTION_FIELD,
    ];
  }

  return [
    ...contact,
    { key: "message", label: "Message", type: "text", required: false },
    SELECTION_FIELD,
  ];
}

/** A default name for the request entity, in the user's own noun. */
export function requestEntityName(thingLabel: string): string {
  const thing = thingLabel.trim();
  if (!thing) return "Requests";
  return `${thing} requests`;
}
