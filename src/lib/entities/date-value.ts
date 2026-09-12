/**
 * The string a date field holds, and how to get a `Date` in and out of it.
 *
 * The wire format is deliberately the one the native inputs used before the
 * picker replaced them — `yyyy-MM-dd`, or `yyyy-MM-ddTHH:mm` for a field that
 * carries a time. Everything downstream already understands it: the server
 * compiles a `date` field to `z.coerce.date()`, and a submission that used to
 * come from `<input type="date">` still validates identically. Changing the
 * control is then a change to the control alone.
 *
 * Local time throughout, never UTC. A booking at "10:00" means ten o'clock
 * where the business is, and formatting through an ISO string would shift it
 * by the offset — the bug that turns an early-morning hire into the previous
 * evening.
 */

const pad = (value: number): string => String(value).padStart(2, "0");

/** `yyyy-MM-dd`, optionally with `THH:mm`, from a real Date in local time. */
export function toDateValue(date: Date, withTime = false): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

/**
 * The Date a field's string names, or null when it holds nothing usable.
 *
 * Parsed by hand rather than by `new Date(value)`: that constructor reads a
 * bare `yyyy-MM-dd` as UTC midnight and a `yyyy-MM-ddTHH:mm` as local, so the
 * same field would land on different days depending on whether it carried a
 * time.
 */
export function parseDateValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
  );
  // Rejects the 31st of February and friends: the constructor rolls them over
  // rather than failing, so the round trip is the check.
  return date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) ? date : null;
}

/** The `HH:mm` half of a value, or "" when it has none. */
export function timeOf(value: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : "";
}

/**
 * The same day with a different clock time. Used by the time input, which must
 * not lose the chosen day — and by the calendar, which must not lose the
 * chosen time when the day changes.
 */
export function withTimeOf(value: string, time: string): string {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return value;
  return /^\d{2}:\d{2}$/.test(time) ? `${day}T${time}` : day;
}

/** How the chosen value reads on the trigger. Empty for nothing chosen. */
export function formatDateValue(value: string, locale?: string): string {
  const date = parseDateValue(value);
  if (!date) return "";

  const day = date.toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = timeOf(value);
  return time ? `${day} at ${time}` : day;
}
