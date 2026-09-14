"use client";

/**
 * A date (and optionally time) control that replaces `<input type="date">`.
 *
 * The native control is the browser's, which means it is a different control
 * in every browser, unreadable in some, and on desktop Chrome a segmented box
 * that has to be typed into in the machine's own field order. This is a
 * calendar: a month you can see, a day you click, and — when the field
 * carries a time — an explicit time next to it.
 *
 * It is a drop-in: the value in and out is the same `yyyy-MM-dd` /
 * `yyyy-MM-ddTHH:mm` string the native input produced, so every caller, and
 * the server's `z.coerce.date()`, is unaffected.
 *
 * Typing still works. A picker that can only be clicked is slower than the
 * control it replaced for anyone entering a date they already know, so the
 * trigger opens onto a calendar *and* the popover carries the text input the
 * keyboard-first user wants.
 */
import { useEffect, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  formatDateValue,
  parseDateValue,
  timeOf,
  toDateValue,
  withTimeOf,
} from "@/lib/entities/date-value";
import { cn } from "@/lib/utils";

export function DateField({
  id,
  value,
  onChange,
  withTime = false,
  disabled = false,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** True for a field that means a moment, not a day — a booking's start. */
  withTime?: boolean;
  disabled?: boolean;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseDateValue(value) ?? undefined;
  const label = formatDateValue(value);

  // What the text input shows while it is being typed into. Kept separate
  // from `value` so a half-typed date is not repeatedly reformatted under the
  // cursor, and re-seeded whenever the popover opens or the value changes.
  const [typed, setTyped] = useState(value.slice(0, 10));
  useEffect(() => {
    setTyped(value.slice(0, 10));
  }, [value]);

  const commitTyped = (raw: string) => {
    const parsed = parseDateValue(raw);
    if (!parsed) {
      // Nothing usable typed: clear on an empty box, otherwise leave the last
      // good value alone rather than destroying it over a typo.
      if (raw.trim() === "") onChange("");
      setTyped(value.slice(0, 10));
      return;
    }
    onChange(
      withTime
        ? withTimeOf(toDateValue(parsed), timeOf(value) || "09:00")
        : toDateValue(parsed),
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          name={name}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          className={cn(
            "w-full justify-start text-left font-normal",
            !label && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="size-4 shrink-0" aria-hidden="true" />
          {label || (withTime ? "Pick a date and time" : "Pick a date")}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto">
        <div className="flex items-center gap-2 border-b p-3">
          <Input
            aria-label="Type a date"
            value={typed}
            placeholder="yyyy-mm-dd"
            className="h-8"
            onChange={(event) => setTyped(event.target.value)}
            onBlur={(event) => commitTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitTyped(typed);
            }}
          />
          {withTime ? (
            <Input
              type="time"
              aria-label="Time"
              className="h-8 w-28"
              value={timeOf(value)}
              onChange={(event) => {
                const day = value.slice(0, 10) || toDateValue(new Date());
                onChange(withTimeOf(day, event.target.value));
              }}
            />
          ) : null}
        </div>

        <Calendar
          mode="single"
          autoFocus
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            if (!date) return;
            const day = toDateValue(date);
            // Changing the day must not discard a time already chosen; a
            // booking moved to Tuesday is still at ten o'clock.
            onChange(withTime ? withTimeOf(day, timeOf(value) || "09:00") : day);
            if (!withTime) setOpen(false);
          }}
        />

        <div className="flex justify-between gap-2 border-t p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            Clear
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
