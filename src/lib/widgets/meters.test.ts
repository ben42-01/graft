/**
 * Pins the client-side meter catalog against the server's `METERS` — the
 * composer offers these as KPI/Chart targets, and a key the server doesn't
 * know would be rejected by the widget config schema at PATCH time.
 */
import { describe, expect, it } from "vitest";
import { METERS } from "@/server/services/meters";
import { WIDGET_METERS } from "./meters";

describe("WIDGET_METERS", () => {
  it("offers exactly the meters the server defines", () => {
    expect(WIDGET_METERS.map((entry) => entry.meter).sort()).toEqual(
      Object.keys(METERS).sort(),
    );
  });
});
