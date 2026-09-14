/**
 * GRAFT-25.2 Test Contract — the import wizard against a stubbed API.
 *
 * Every assertion is on what a person sees or on the exact request sent: the
 * gate renders from `/me`'s resolved features (AC1), the preview is a real
 * dry run whose body the commit replays (AC4, AC6), and every error code
 * renders as itself (AC9).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldLike } from "@/lib/entities/record-values";
import { ImportWizard, type ImportResultView } from "./import-wizard";

const MEDIA = "0000000000000000000000a1";

const FIELDS: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone" },
  { key: "photo", label: "Photo", type: "image" },
];

// "Full Name" matches no key or label, so it starts skipped; "Email" matches.
const CSV = "Full Name,Email,Notes\nAda,ada@qa.test,hi\n";

const result = (over: Partial<ImportResultView> = {}): ImportResultView => ({
  importId: "i1",
  dryRun: true,
  total: 200,
  imported: 188,
  rejected: Array.from({ length: 12 }, (_, i) => ({
    row: i * 10 + 3,
    field: "email",
    reason: `Invalid email on purpose ${i + 1}`,
  })),
  rejectedCount: 12,
  quotaRefused: 0,
  quota: { meter: "records", remaining: 5_000 },
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, details, requestId: "r1" } }, status);

type Routes = {
  ticket?: () => Promise<Response>;
  dryRun?: () => Promise<Response>;
  commit?: () => Promise<Response>;
};

function stubApi(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://bucket.test")) return new Response(null, { status: 200 });
    if (url.endsWith("/import-uploads")) {
      return routes.ticket
        ? routes.ticket()
        : json(
            {
              data: {
                mediaId: MEDIA,
                uploadUrl: "https://bucket.test/put",
                contentType: "text/csv",
                expiresInSeconds: 300,
              },
            },
            201,
          );
    }
    if (url.includes("/import-uploads/")) return json({ data: { id: MEDIA, status: "ready" } });
    if (url.endsWith("/imports")) {
      const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
      if (body.dryRun) return routes.dryRun ? routes.dryRun() : json({ data: result() }, 201);
      return routes.commit
        ? routes.commit()
        : json({ data: result({ dryRun: false, importId: "i2" }) }, 201);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const importCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/imports"))
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

function renderWizard(features: Record<string, boolean> | null = { csv_import: true }) {
  const onImported = vi.fn();
  render(
    <ImportWizard
      open
      onOpenChange={vi.fn()}
      entityId="e1"
      entityName="Customers"
      fields={FIELDS}
      features={features}
      onImported={onImported}
    />,
  );
  return { onImported, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

async function toMapping(user: User) {
  await user.upload(
    screen.getByLabelText("File to import"),
    new File([CSV], "people.csv", { type: "text/csv" }),
  );
  await screen.findByText(/3 columns found/);
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByLabelText("Field for column Full Name");
}

async function toPreview(user: User) {
  await toMapping(user);
  await user.selectOptions(screen.getByLabelText("Field for column Full Name"), "name");
  await user.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByText(/Nothing has been saved yet/);
}

const fileInput = () => document.querySelector('input[type="file"]');

// Each flow drives an upload, a mapping and up to two API calls through
// user-event in jsdom: about 2 s alone, and past the 5 s default when the whole
// file runs together. A ceiling on slow machines, not a wait on anything.
describe("ImportWizard", { timeout: 15_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC1 — Free sees the upgrade prompt naming Premium, and no file input", () => {
    stubApi();
    renderWizard({ csv_import: false });

    expect(screen.getByText("Batch import is a Premium feature")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(fileInput()).toBeNull();
  });

  it("AC1 — renders no file input before the entitlement has loaded", () => {
    stubApi();
    renderWizard(null);
    expect(fileInput()).toBeNull();
  });

  it("AC2 — the mapping step lists the file's columns against the entity's own fields", async () => {
    stubApi();
    const { user } = renderWizard();
    await toMapping(user);

    for (const column of ["Full Name", "Email", "Notes"]) {
      expect(screen.getByLabelText(`Field for column ${column}`)).toBeInTheDocument();
    }
    const options = Array.from(
      screen.getByLabelText("Field for column Notes").querySelectorAll("option"),
    ).map((option) => option.textContent);
    expect(options).toEqual([
      "Skip this column",
      "Name (required)",
      "Email (required)",
      "Phone",
    ]);
  });

  it("AC2 — the file goes to the bucket through the presigned PUT, without cookies", async () => {
    const fetchMock = stubApi();
    const { user } = renderWizard();
    await toMapping(user);

    const put = fetchMock.mock.calls.find(([url]) => String(url).startsWith("https://bucket"));
    expect(put?.[1]).toMatchObject({ method: "PUT", credentials: "omit" });
  });

  it("AC3 — an unmapped required field blocks the preview and names itself", async () => {
    const fetchMock = stubApi();
    const { user } = renderWizard();
    await toMapping(user);

    expect(screen.getByRole("alert")).toHaveTextContent("Name is required.");
    const next = screen.getByRole("button", { name: "Preview import" });
    expect(next).toBeDisabled();
    await user.click(next);
    expect(importCalls(fetchMock)).toHaveLength(0);
  });

  it("AC4, AC5 — the preview is a dry run listing every rejection, and the commit states the count", async () => {
    const fetchMock = stubApi();
    const { user } = renderWizard();
    await toPreview(user);

    expect(importCalls(fetchMock)).toEqual([
      {
        mediaId: MEDIA,
        format: "csv",
        mapping: { "Full Name": "name", Email: "email", Notes: null },
        dedupeKey: null,
        dryRun: true,
      },
    ]);
    for (let i = 1; i <= 12; i += 1) {
      expect(screen.getByText(`Invalid email on purpose ${i}`)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Import 188 rows" })).toBeEnabled();
  });

  it("AC5 — backing up to the mapping discards the preview and allows a change", async () => {
    stubApi();
    const { user } = renderWizard();
    await toPreview(user);

    await user.click(screen.getByRole("button", { name: "Back to mapping" }));
    const select = await screen.findByLabelText("Field for column Notes");
    await user.selectOptions(select, "phone");
    expect(select).toHaveValue("phone");
  });

  it("AC6 — the commit replays the preview's body with dryRun false, then shows the summary", async () => {
    const fetchMock = stubApi();
    const { user, onImported } = renderWizard();
    await toPreview(user);

    await user.click(screen.getByRole("button", { name: "Import 188 rows" }));
    await screen.findByText("Import finished.");

    const [dry, wet] = importCalls(fetchMock);
    expect(wet).toEqual({ ...dry, dryRun: false });
    expect(screen.getByText("Records you can still add").nextSibling).toHaveTextContent(
      "5,000",
    );
    expect(screen.getByText("Imported").nextSibling).toHaveTextContent("188");
    expect(screen.getByText("Not imported").nextSibling).toHaveTextContent("12");
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("AC7 — a partial import reads as partial, with the quota count and the upgrade path", async () => {
    stubApi({
      commit: async () =>
        json(
          {
            data: result({
              dryRun: false,
              imported: 158,
              rejectedCount: 42,
              quotaRefused: 30,
              quota: { meter: "records", remaining: 0 },
            }),
          },
          201,
        ),
    });
    const { user } = renderWizard();
    await toPreview(user);
    await user.click(screen.getByRole("button", { name: "Import 188 rows" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Only part of the file was imported.");
    expect(status).toHaveTextContent("158 rows imported. 30 valid rows could not be added");
    expect(
      screen.getByRole("link", { name: "Upgrade to import the rest" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Import finished.")).not.toBeInTheDocument();
  });

  it("AC8 — the commit control is disabled in flight, so a double click imports once", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = stubApi({
      commit: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const { user } = renderWizard();
    await toPreview(user);

    await user.dblClick(screen.getByRole("button", { name: "Import 188 rows" }));
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(importCalls(fetchMock).filter((body) => body.dryRun === false)).toHaveLength(1);

    release(json({ data: result({ dryRun: false }) }, 201));
    await screen.findByText("Import finished.");
  });

  describe("AC9 — errors surface as themselves", () => {
    const noGeneric = () => {
      expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(
        /FEATURE_NOT_AVAILABLE|ROW_LIMIT_EXCEEDED|VALIDATION_FAILED/,
      );
    };

    it("403 FEATURE_NOT_AVAILABLE turns the wizard into the upgrade prompt", async () => {
      stubApi({
        ticket: async () =>
          apiError(403, "FEATURE_NOT_AVAILABLE", "Batch import is not included", {
            feature: "csv_import",
          }),
      });
      const { user } = renderWizard();
      await user.upload(
        screen.getByLabelText("File to import"),
        new File([CSV], "people.csv", { type: "text/csv" }),
      );
      await screen.findByText(/3 columns found/);
      await user.click(screen.getByRole("button", { name: "Next" }));

      expect(await screen.findByText("Batch import is a Premium feature")).toBeInTheDocument();
      expect(fileInput()).toBeNull();
      noGeneric();
    });

    it("400 ROW_LIMIT_EXCEEDED names the file's rows, the plan's limit, and what to do", async () => {
      stubApi({
        dryRun: async () =>
          apiError(400, "ROW_LIMIT_EXCEEDED", "Too many rows", { limit: 10_000, rows: 12_500 }),
      });
      const { user } = renderWizard();
      await toMapping(user);
      await user.selectOptions(screen.getByLabelText("Field for column Full Name"), "name");
      await user.click(screen.getByRole("button", { name: "Preview import" }));

      const alert = await screen.findByText(/This file has 12,500 rows/);
      expect(alert).toHaveTextContent("up to 10,000 at a time. Split it into smaller files");
      expect(screen.getByRole("link", { name: "View plans" })).toBeInTheDocument();
      noGeneric();
    });

    it("400 VALIDATION_FAILED lists the server's own reasons", async () => {
      stubApi({
        dryRun: async () =>
          apiError(400, "VALIDATION_FAILED", "Invalid request body", {
            source: "body",
            fields: { "(file)": "The csv file has a quoted value that is never closed" },
          }),
      });
      const { user } = renderWizard();
      await toMapping(user);
      await user.selectOptions(screen.getByLabelText("Field for column Full Name"), "name");
      await user.click(screen.getByRole("button", { name: "Preview import" }));

      expect(
        await screen.findByText("The csv file has a quoted value that is never closed"),
      ).toBeInTheDocument();
      expect(screen.getByText(/can't be imported yet/)).toBeInTheDocument();
      noGeneric();
    });
  });

  it("refuses a file that is neither CSV nor JSON before uploading anything", async () => {
    const fetchMock = stubApi();
    renderWizard();
    // The input's `accept` would filter the file out before `change` fires;
    // this proves the wizard's own check, not the browser's.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(
      screen.getByLabelText("File to import"),
      new File(["x"], "sheet.xlsx", { type: "application/vnd.ms-excel" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Choose a .csv or .json file.")).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
