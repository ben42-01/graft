"use client";

/**
 * Booking mode — the control that turns a form's submissions into orders
 * against real capacity (src/server/services/booking-bridge.ts).
 *
 * Three things about its shape follow from the server's rules rather than
 * taste:
 *
 *   - **It is inert without a catalogue selection, and says so.** The resource
 *     a booking is *for* is the catalogue selection, so `resolveBooking`
 *     refuses a config without one. Offering the controls anyway and failing
 *     on save would make the builder guess what it got wrong.
 *   - **Only date fields are offered as the start and end.** The server checks
 *     the same thing; filtering the list here means the rule is visible before
 *     it is enforced, and a form with no date field gets told what to add.
 *   - **End field or fixed duration, never both.** A radio, not two inputs
 *     that quietly disagree — the server's `bookingSchema` rejects having both
 *     precisely because there would be no defensible answer at submit time.
 *
 * Saved with an explicit button, like every other panel here: this decides
 * what happens to a customer's money.
 */
import { useEffect, useState } from "react";
import { CalendarClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FieldLike } from "@/lib/entities/record-values";

/** Mirrors `RATE_BASES` in src/server/services/forms.ts. */
export const RATE_BASES = [
  { value: "hourly", label: "Per hour", rateKey: "hourly_rate" },
  { value: "daily", label: "Per day", rateKey: "daily_rate" },
  { value: "flat", label: "One flat price", rateKey: "flat_rate" },
] as const;

export type BookingView = {
  startKey: string;
  endKey: string | null;
  durationMinutes: number | null;
  quantityKey: string | null;
  rateBasis: (typeof RATE_BASES)[number]["value"];
  depositPercent: number | null;
};

const DEFAULT_DURATION_MINUTES = 60;

export function BookingEditor({
  booking,
  /** The fields of the entity this form writes to — where the dates live. */
  formFields,
  /** Whether the catalogue names a selection field; without it, booking is
   * impossible and the server will refuse it. */
  hasSelection,
  busy,
  onSave,
}: {
  booking: BookingView | null;
  formFields: FieldLike[];
  hasSelection: boolean;
  busy: boolean;
  onSave: (next: BookingView | null) => void;
}) {
  const dateFields = formFields.filter((field) => field.type === "date");
  const numberFields = formFields.filter((field) => field.type === "number");

  const [enabled, setEnabled] = useState(booking !== null);
  /**
   * Which of the two shapes this form is, tracked rather than derived from
   * `endKey`. Deriving it would make "range mode, end not chosen yet" and
   * "fixed mode" the same state, and the panel would flip modes under the
   * builder mid-edit. A form with two date fields is asking the visitor for
   * both, which is what a hire almost always is.
   */
  const [mode, setMode] = useState<"range" | "fixed">(
    booking
      ? booking.endKey !== null
        ? "range"
        : "fixed"
      : dateFields.length >= 2
        ? "range"
        : "fixed",
  );
  const [draft, setDraft] = useState<BookingView>(
    booking ?? {
      startKey: "",
      endKey: null,
      durationMinutes: DEFAULT_DURATION_MINUTES,
      quantityKey: null,
      rateBasis: "hourly",
      depositPercent: null,
    },
  );

  // Re-seed when the server's answer arrives or changes under us.
  useEffect(() => {
    setEnabled(booking !== null);
    if (booking) {
      setDraft(booking);
      setMode(booking.endKey !== null ? "range" : "fixed");
    }
  }, [booking]);

  const endFields = dateFields.filter((field) => field.key !== draft.startKey);
  const basis = RATE_BASES.find((option) => option.value === draft.rateBasis) ?? RATE_BASES[0];

  const fixedLength = mode === "fixed";
  const ready =
    hasSelection &&
    draft.startKey !== "" &&
    (fixedLength ? (draft.durationMinutes ?? 0) > 0 : draft.endKey !== null);

  // The two halves are mutually exclusive on the wire, whatever is left in
  // the draft from an earlier edit — `bookingSchema` rejects having both.
  const saved = (): BookingView => ({
    ...draft,
    endKey: fixedLength ? null : draft.endKey,
    durationMinutes: fixedLength ? draft.durationMinutes : null,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClockIcon className="size-4" aria-hidden="true" /> Bookings
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn each submission into a booking: the time is held against the item the visitor
          picked, and an order appears on your operations board. Without this, a submission is
          only a record.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {!hasSelection ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            Set up the catalogue first, including <strong>Record the choice in</strong>. A
            booking has to know which item it is for, and that is where the visitor&apos;s
            choice is recorded.
          </p>
        ) : null}

        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={enabled}
            disabled={!hasSelection}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          Take bookings with this form
        </label>

        {enabled && hasSelection ? (
          <>
            <div>
              <Label htmlFor="booking-start" className="mb-1 block text-xs">
                Booking starts at
              </Label>
              <Select
                value={draft.startKey}
                onValueChange={(value) =>
                  setDraft((prev) => ({
                    ...prev,
                    startKey: value,
                    // The start cannot also be the end; the server refuses it.
                    endKey: prev.endKey === value ? null : prev.endKey,
                  }))
                }
              >
                <SelectTrigger
                  id="booking-start"
                  aria-label="Booking starts at"
                  className="w-full"
                >
                  <SelectValue placeholder="Choose a date field…" />
                </SelectTrigger>
                <SelectContent>
                  {dateFields.map((field) => (
                    <SelectItem key={field.key} value={field.key}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {dateFields.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  This form&apos;s entity has no date field yet — add one, then put it on the
                  form.
                </p>
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium">And ends</legend>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="booking-length"
                  checked={!fixedLength}
                  onChange={() => setMode("range")}
                  disabled={endFields.length === 0}
                />
                when the visitor says
              </label>
              {!fixedLength ? (
                <div className="ml-6">
                  <Select
                    value={draft.endKey ?? ""}
                    onValueChange={(value) => setDraft((prev) => ({ ...prev, endKey: value }))}
                  >
                    <SelectTrigger aria-label="Booking ends at" className="w-full max-w-xs">
                      <SelectValue placeholder="Choose a date field…" />
                    </SelectTrigger>
                    <SelectContent>
                      {endFields.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="booking-length"
                  checked={fixedLength}
                  onChange={() => {
                    setMode("fixed");
                    setDraft((prev) => ({
                      ...prev,
                      durationMinutes: prev.durationMinutes ?? DEFAULT_DURATION_MINUTES,
                    }));
                  }}
                />
                after a fixed length
              </label>
              {fixedLength ? (
                <div className="ml-6 flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    className="w-28"
                    aria-label="Length in minutes"
                    value={draft.durationMinutes ?? ""}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        durationMinutes: Number(event.target.value) || null,
                      }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">minutes</span>
                </div>
              ) : null}
            </fieldset>

            <div>
              <Label htmlFor="booking-basis" className="mb-1 block text-xs">
                Charge
              </Label>
              <Select
                value={draft.rateBasis}
                onValueChange={(value) =>
                  setDraft((prev) => ({
                    ...prev,
                    rateBasis: value as BookingView["rateBasis"],
                  }))
                }
              >
                <SelectTrigger
                  id="booking-basis"
                  aria-label="Charge"
                  className="w-full max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RATE_BASES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                The price comes from each catalogue record&apos;s <code>{basis.rateKey}</code>{" "}
                field. A record without one is booked at zero rather than refused.
              </p>
            </div>

            <div>
              <Label htmlFor="booking-quantity" className="mb-1 block text-xs">
                How many (optional)
              </Label>
              <Select
                value={draft.quantityKey ?? "none"}
                onValueChange={(value) =>
                  setDraft((prev) => ({
                    ...prev,
                    quantityKey: value === "none" ? null : value,
                  }))
                }
              >
                <SelectTrigger
                  id="booking-quantity"
                  aria-label="How many"
                  className="w-full max-w-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Always one</SelectItem>
                  {numberFields.map((field) => (
                    <SelectItem key={field.key} value={field.key}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                A number field, for stock you hold several of — six kayaks out of fifty.
              </p>
            </div>

            <div>
              <Label htmlFor="booking-deposit" className="mb-1 block text-xs">
                Deposit (optional)
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="booking-deposit"
                  type="number"
                  min={1}
                  max={100}
                  className="w-28"
                  placeholder="None"
                  value={draft.depositPercent ?? ""}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      depositPercent: Number(event.target.value) || null,
                    }))
                  }
                />
                <span className="text-sm text-muted-foreground">% of the total</span>
              </div>
            </div>
          </>
        ) : null}

        <div>
          <Button
            type="button"
            size="sm"
            disabled={busy || (enabled && !ready)}
            onClick={() => onSave(enabled ? saved() : null)}
          >
            {busy ? "Saving…" : "Save bookings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
