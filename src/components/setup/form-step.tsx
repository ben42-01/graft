"use client";

/**
 * The last step: one public form, wired to both entities, published.
 *
 * Everything asked here is a *mapping* — which of your fields means "when it
 * starts", which one holds the price, which one is the name to print on the
 * order. None of it is a naming convention the user has to obey, because the
 * conventions were the bug: a tenant who called their rate field `price` used
 * to get every booking priced at zero with nothing reported. The dropdowns
 * are built from fields that demonstrably exist, so a mapping that is wrong
 * is a mapping nobody could have chosen.
 *
 * It creates the form through `POST /api/v1/forms` and publishes through
 * `POST /api/v1/forms/:id/publish` — the ordinary endpoints, so the form's
 * own page can take over the moment this step is done.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RATE_BASES } from "@/components/forms/booking-editor";
import { toIdentifier } from "@/lib/entities/field-types";
import { SELECTION_FIELD } from "@/lib/setup/suggested-fields";
import type { SetupIntent } from "@/lib/setup/flow";
import type { FieldLike } from "@/lib/entities/record-values";

/** What a catalogue card shows. Six is the server's cap; the first few text
 * fields are the ones worth showing, and it is all editable afterwards. */
const CATALOGUE_FIELD_LIMIT = 6;

export type CreatedForm = { id: string; publicSlug: string | null; published: boolean };

type Mapping = {
  startKey: string;
  endKey: string;
  rateKey: string;
  labelKey: string;
  rateBasis: (typeof RATE_BASES)[number]["value"];
};

const NONE = "__none__";

export function FormStep({
  intent,
  thingLabel,
  resourceEntityId,
  resourceFields,
  requestEntityId,
  requestFields,
  created,
  onCreated,
  onPublished,
}: {
  intent: SetupIntent;
  thingLabel: string;
  resourceEntityId: string;
  resourceFields: FieldLike[];
  requestEntityId: string;
  requestFields: FieldLike[];
  created: CreatedForm | null;
  onCreated: (form: CreatedForm) => void;
  onPublished: (form: CreatedForm) => void;
}) {
  const booking = intent === "bookings";
  const [name, setName] = useState(
    booking ? `Book ${thingLabel.toLowerCase()}` : `Ask about ${thingLabel.toLowerCase()}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateFields = useMemo(
    () => requestFields.filter((field) => field.type === "date"),
    [requestFields],
  );
  const numberFields = useMemo(
    () => resourceFields.filter((field) => field.type === "number"),
    [resourceFields],
  );
  const textFields = useMemo(
    () => resourceFields.filter((field) => field.type === "text"),
    [resourceFields],
  );
  const imageField = resourceFields.find((field) => field.type === "image") ?? null;
  const selectionField =
    requestFields.find((field) => field.key === SELECTION_FIELD.key) ??
    requestFields.find((field) => field.type === "text") ??
    null;

  const [mapping, setMapping] = useState<Mapping>(() => ({
    startKey: dateFields[0]?.key ?? "",
    endKey: dateFields[1]?.key ?? NONE,
    rateKey: numberFields[0]?.key ?? NONE,
    labelKey: textFields[0]?.key ?? NONE,
    rateBasis: "hourly",
  }));

  const patch = (next: Partial<Mapping>) => setMapping((prev) => ({ ...prev, ...next }));

  /**
   * The reason this cannot be created yet, in the user's terms. Booking mode
   * is refused server-side without a catalogue selection and a start date, so
   * saying it here means the failure arrives before the click rather than
   * after it.
   */
  const endField =
    mapping.endKey === NONE
      ? null
      : (requestFields.find((field) => field.key === mapping.endKey) ?? null);

  const invalid = !name.trim()
    ? "Give the form a name."
    : !selectionField
      ? "The requests list needs a text field for the chosen item."
      : booking && !mapping.startKey
        ? "Add a date field to the requests list, so a booking has a start time."
        : booking && mapping.rateKey === NONE
          ? "Choose which field holds the price, or bookings will be raised at zero."
          : booking && endField && !endField.required
            ? // A mapped end is mandatory to the booking engine, which has no
              // second answer for "until when" — so an optional one is a box
              // the form invites a visitor to skip and then rejects them for
              // skipping, naming a field it called optional.
              `Make "${endField.label}" required on the requests list, or pick a fixed duration instead — a booking with no end cannot be worked out.`
            : null;

  async function create() {
    if (invalid || !selectionField) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/forms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId: requestEntityId,
          name: name.trim(),
          slug: toIdentifier(name).replace(/_/g, "-") || "requests",
          visibility: "public",
          // The selection key belongs in this list even though no visitor
          // ever fills it in. A submission is validated against the *form's*
          // field list, and `resolveSelection` writes the chosen record into
          // `data` under this key before that check runs — leave it out and
          // every submission is refused as an unrecognised key. The renderer
          // is what hides it from the visitor, not its absence here.
          fields: requestFields.map((field) => ({ key: field.key })),
          catalogue: {
            entityId: resourceEntityId,
            fields: resourceFields
              .filter((field) => field.type !== "image")
              .slice(0, CATALOGUE_FIELD_LIMIT)
              .map((field) => field.key),
            imageField: imageField?.key ?? null,
            selectionKey: selectionField.key,
          },
          booking: booking
            ? {
                startKey: mapping.startKey,
                endKey: mapping.endKey === NONE ? null : mapping.endKey,
                durationMinutes: mapping.endKey === NONE ? 60 : null,
                rateBasis: mapping.rateBasis,
                rateKey: mapping.rateKey === NONE ? null : mapping.rateKey,
                labelKey: mapping.labelKey === NONE ? null : mapping.labelKey,
              }
            : null,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        { data: CreatedForm } | { error: { message: string } } | null;

      if (!response.ok || !body || "error" in body) {
        setError(body && "error" in body ? body.error.message : "We couldn't create the form.");
        return;
      }
      onCreated(body.data);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/forms/${created.id}/publish`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as
        { data: CreatedForm } | { error: { message: string } } | null;
      if (!response.ok || !body || "error" in body) {
        setError(
          body && "error" in body ? body.error.message : "We couldn't publish the form.",
        );
        return;
      }
      onPublished(body.data);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const publicUrl =
      created.publicSlug && typeof window !== "undefined"
        ? `${window.location.origin}/f/${created.publicSlug}`
        : null;

    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckIcon className="size-4 text-graft-green" aria-hidden="true" />
            {name} exists
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {created.published
              ? "It is live. Anyone with the link can use it."
              : "It is not live yet — publishing gives it a public link."}
          </p>
          {created.published && publicUrl ? (
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-4"
            >
              {publicUrl}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          {created.published ? null : (
            <Button type="button" disabled={busy} onClick={() => void publish()}>
              {busy ? "Publishing…" : "Publish it"}
            </Button>
          )}
          <Link
            href={`/forms/${created.id}`}
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            Open the form&apos;s page
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="max-w-sm">
        <Label htmlFor="setup-form-name" className="mb-1 block text-xs">
          Form name
        </Label>
        <Input
          id="setup-form-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {booking ? (
        <div className="flex flex-col gap-4 rounded-lg border p-4">
          <div>
            <p className="text-sm font-medium">Which of your fields mean what</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Nothing is found by its name — you say which field plays each part, so a field
              called anything at all works.
            </p>
          </div>

          <MappingRow
            id="map-start"
            label="Booking starts at"
            hint="A date on the requests list."
            value={mapping.startKey}
            options={dateFields}
            onChange={(value) => patch({ startKey: value })}
          />
          <MappingRow
            id="map-end"
            label="Booking ends at"
            hint="Leave unset for a fixed hour-long slot."
            value={mapping.endKey}
            options={dateFields.filter((field) => field.key !== mapping.startKey)}
            allowNone
            noneLabel="No end field — one hour"
            onChange={(value) => patch({ endKey: value })}
          />
          <MappingRow
            id="map-rate"
            label="Price comes from"
            hint={`A number on your ${thingLabel.toLowerCase()}.`}
            value={mapping.rateKey}
            options={numberFields}
            allowNone
            noneLabel="Nothing — bookings are free"
            onChange={(value) => patch({ rateKey: value })}
          />
          <div className="max-w-sm">
            <Label htmlFor="map-basis" className="mb-1 block text-xs">
              And that price is
            </Label>
            <Select
              value={mapping.rateBasis}
              onValueChange={(value) => patch({ rateBasis: value as Mapping["rateBasis"] })}
            >
              <SelectTrigger id="map-basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RATE_BASES.map((basis) => (
                  <SelectItem key={basis.value} value={basis.value}>
                    {basis.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <MappingRow
            id="map-label"
            label="Name on the order"
            hint="What the customer sees they booked."
            value={mapping.labelKey}
            options={textFields}
            allowNone
            noneLabel="Leave it generic"
            onChange={(value) => patch({ labelKey: value })}
          />
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="button" disabled={busy || invalid !== null} onClick={() => void create()}>
          {busy ? "Creating…" : "Create the form"}
        </Button>
        <p className="text-xs text-muted-foreground">
          {invalid ?? "You publish it on the next screen, once you have seen it."}
        </p>
      </div>
    </div>
  );
}

function MappingRow({
  id,
  label,
  hint,
  value,
  options,
  allowNone = false,
  noneLabel = "Not set",
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  options: FieldLike[];
  allowNone?: boolean;
  noneLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="max-w-sm">
      <Label htmlFor={id} className="mb-1 block text-xs">
        {label}
      </Label>
      <Select value={value || NONE} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Pick a field" />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
          {options.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {field.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
