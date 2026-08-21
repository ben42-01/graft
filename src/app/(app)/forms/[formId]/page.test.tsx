/**
 * The form page. The two things worth pinning are the ones the server's
 * model makes easy to get wrong: publishing and the kill switch are separate
 * controls hitting separate endpoints, and a form may not drop a field its
 * entity marks required — a submission without it would be refused, so the
 * form would be permanently broken.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import FormPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ formId: "f1" }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));

const ENTITY = {
  id: "e1",
  name: "Customers",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Phone", type: "phone", required: false },
  ],
};

const DRAFT = {
  id: "f1",
  entityId: "e1",
  name: "Enquiries",
  slug: "enquiries",
  publicSlug: null,
  visibility: "public" as const,
  published: false,
  enabled: true,
  fields: [ENTITY.fields[0]],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubApi(form: Record<string, unknown> = DRAFT) {
  // `init` is declared even though the stub ignores it: the assertions below
  // read it back off the recorded calls.
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/entities/"))
      return Promise.resolve(jsonResponse({ data: ENTITY }));
    return Promise.resolve(jsonResponse({ data: form }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const callsTo = (mock: ReturnType<typeof stubApi>, fragment: string) =>
  mock.mock.calls.filter((call) => String(call[0]).includes(fragment));

describe("FormPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it("publishes a draft through the publish endpoint", async () => {
    const fetchMock = stubApi();
    const user = userEvent.setup();
    render(<FormPage />);

    await waitFor(() => expect(screen.getByText("Not live")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(callsTo(fetchMock, "/publish")).toHaveLength(1));
    expect(callsTo(fetchMock, "/publish")[0][1]).toMatchObject({ method: "POST" });
  });

  it("shows the public link and the kill switch once live", async () => {
    const fetchMock = stubApi({
      ...DRAFT,
      published: true,
      publicSlug: "acme/enquiries",
    });
    const user = userEvent.setup();
    render(<FormPage />);

    await waitFor(() => expect(screen.getByText("Live")).toBeInTheDocument());
    expect(screen.getByText(/\/f\/acme\/enquiries/)).toBeInTheDocument();

    // The kill switch is a PATCH of `enabled`, not an unpublish.
    await user.click(screen.getByRole("checkbox", { name: "Accepting submissions" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({ enabled: false });
    });
    expect(callsTo(fetchMock, "/unpublish")).toHaveLength(0);
  });

  it("refuses to save a form that drops a field its entity requires", async () => {
    stubApi();
    const user = userEvent.setup();
    render(<FormPage />);

    await waitFor(() => expect(screen.getByText("Not live")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "Name" }));

    expect(screen.getByText(/is required on the entity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("saves the chosen fields as key references, in the entity's order", async () => {
    const fetchMock = stubApi();
    const user = userEvent.setup();
    render(<FormPage />);

    await waitFor(() => expect(screen.getByText("Not live")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "Phone" }));
    await user.click(screen.getByRole("button", { name: /Save changes/ }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
        name: "Enquiries",
        fields: [{ key: "name" }, { key: "phone" }],
      });
    });
  });
});
