import { describe, expect, it } from "vitest";
import type { FieldLike } from "./record-values";
import { csvCell, exportColumns, exportFilename, recordsToCsv } from "./export-csv";
import { initialMapping } from "@/components/entities/import-mapping";

const FIELDS: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email" },
  { key: "joined", label: "Joined", type: "date" },
  { key: "vip", label: "VIP", type: "checkbox" },
  { key: "spend", label: "Spend", type: "number" },
  { key: "photo", label: "Photo", type: "image" },
];

describe("recordsToCsv", () => {
  it("is just the header row when there are no records, without image fields", () => {
    expect(recordsToCsv(FIELDS, [])).toBe("Name,Email,Joined,VIP,Spend\r\n");
  });

  it("writes one row per record, quoting and escaping where needed", () => {
    const csv = recordsToCsv(FIELDS, [
      {
        data: {
          name: 'Ada, "the" Countess',
          email: "ada@qa.test",
          joined: "2026-03-04T00:00:00.000Z",
          vip: true,
          spend: -12.5,
          photo: "0000000000000000000000a1",
        },
      },
      { data: { name: "Bob" } },
    ]);
    expect(csv).toBe(
      'Name,Email,Joined,VIP,Spend\r\n"Ada, ""the"" Countess",ada@qa.test,2026-03-04,Yes,-12.5\r\nBob,,,,\r\n',
    );
  });

  it("round-trips: every exported header maps back to its own field on import", () => {
    const headers = exportColumns(FIELDS).map((column) => column.header);
    const mapping = initialMapping(headers, FIELDS);
    expect(Object.values(mapping)).toEqual(["name", "email", "joined", "vip", "spend"]);
  });

  it("uses the key as the header when two labels collide", () => {
    const headers = exportColumns([
      { key: "home", label: "Phone", type: "phone" },
      { key: "work", label: "phone", type: "phone" },
    ]).map((column) => column.header);
    expect(headers).toEqual(["home", "work"]);
  });
});

describe("csvCell", () => {
  const text: FieldLike = { key: "n", label: "N", type: "text" };
  it("defuses spreadsheet formulas in text but not numbers", () => {
    expect(csvCell("=HYPERLINK(1)", text)).toBe("'=HYPERLINK(1)");
    expect(csvCell(-3, { key: "n", label: "N", type: "number" })).toBe("-3");
  });

  it("quotes multi-line long text whole and still defuses a leading formula", () => {
    const details: FieldLike = { key: "d", label: "D", type: "longtext" };
    expect(csvCell('Line one\nsaid "hi"', details)).toBe('"Line one\nsaid ""hi"""');
    expect(csvCell("=cmd|' /C calc'!A0\nmore", details)).toBe("\"'=cmd|' /C calc'!A0\nmore\"");
  });
});

describe("exportFilename", () => {
  it("names a template apart from an export", () => {
    expect(exportFilename("customers", false)).toBe("customers.csv");
    expect(exportFilename("customers", true)).toBe("customers-template.csv");
  });
});
