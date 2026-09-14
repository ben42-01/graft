/**
 * GRAFT-25.2 Test Contract — the mapping step's own logic: one column to one
 * field, explicit skip, required-field detection, and column detection that
 * spells names the way the server's parser does.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldLike } from "@/lib/entities/record-values";
import {
  ImportMapping,
  detectColumns,
  formatOf,
  initialMapping,
  missingRequired,
  setColumnTarget,
} from "./import-mapping";

const FIELDS: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone" },
  { key: "photo", label: "Photo", type: "image" },
];

describe("detectColumns", () => {
  it("reads a CSV header by the server's rules: quoted, trimmed, blanks dropped", () => {
    const result = detectColumns('"Full Name", Email ,"Say ""hi""",\r\nAda,a@b.c,x,\n', "csv");
    expect(result).toEqual({ columns: ["Full Name", "Email", 'Say "hi"'] });
  });

  it("refuses a CSV with no header", () => {
    expect(detectColumns("\n", "csv")).toHaveProperty("error");
  });

  it("collects the keys of JSON records, and refuses anything that is not a list", () => {
    expect(detectColumns('[{"name":"Ada"},{"email":"a@b.c","name":"G"}]', "json")).toEqual({
      columns: ["name", "email"],
    });
    expect(detectColumns('{"name":"Ada"}', "json")).toHaveProperty("error");
    expect(detectColumns("{ nope", "json")).toHaveProperty("error");
  });

  it("tells the two formats apart by type or extension", () => {
    expect(formatOf({ name: "a.CSV", type: "" })).toBe("csv");
    expect(formatOf({ name: "a.json", type: "" })).toBe("json");
    expect(formatOf({ name: "a.xlsx", type: "application/vnd.ms-excel" })).toBeNull();
  });
});

describe("mapping rules", () => {
  it("starts columns that match a field's key or label mapped, and the rest skipped", () => {
    expect(initialMapping(["Name", "email", "Notes"], FIELDS)).toEqual({
      Name: "name",
      email: "email",
      Notes: null,
    });
  });

  it("never offers an image field as a target", () => {
    expect(initialMapping(["photo"], FIELDS)).toEqual({ photo: null });
  });

  it("maps a column to exactly one field: taking a field skips the column that had it", () => {
    const start = { A: "name", B: null };
    expect(setColumnTarget(start, "B", "name")).toEqual({ A: null, B: "name" });
  });

  it("an explicit skip is null, not an absent key", () => {
    const next = setColumnTarget({ A: "name" }, "A", null);
    expect(next).toEqual({ A: null });
    expect(Object.hasOwn(next, "A")).toBe(true);
  });

  it("names every required field no column maps to", () => {
    expect(missingRequired({ A: "name", B: null }, FIELDS).map((f) => f.key)).toEqual([
      "email",
    ]);
    expect(missingRequired({ A: "name", B: "email" }, FIELDS)).toEqual([]);
  });
});

describe("ImportMapping", () => {
  function renderMapping(mapping: Record<string, string | null>) {
    const onChange = vi.fn();
    render(
      <ImportMapping
        columns={Object.keys(mapping)}
        fields={FIELDS}
        mapping={mapping}
        onChange={onChange}
        dedupeKey={null}
        onDedupeKeyChange={vi.fn()}
      />,
    );
    return { onChange, user: userEvent.setup() };
  }

  it("lists the entity's own fields as targets, plus skip", () => {
    renderMapping({ "Full Name": null });
    const options = Array.from(
      screen.getByLabelText("Field for column Full Name").querySelectorAll("option"),
    ).map((option) => option.textContent);
    expect(options).toEqual([
      "Skip this column",
      "Name (required)",
      "Email (required)",
      "Phone",
    ]);
  });

  it("names the unmapped required field inline", () => {
    renderMapping({ "Full Name": "name" });
    expect(screen.getByRole("alert")).toHaveTextContent("Email is required.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Name is required.");
  });

  it("choosing skip reports the column as null", async () => {
    const { onChange, user } = renderMapping({ "Full Name": "name" });
    await user.selectOptions(screen.getByLabelText("Field for column Full Name"), "");
    expect(onChange).toHaveBeenCalledWith({ "Full Name": null });
  });
});
