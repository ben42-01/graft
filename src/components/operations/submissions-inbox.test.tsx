/**
 * The inbox — component coverage. A row has to answer "who, through which
 * form, and what did it become" and lead to the order it raised.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiSubmission } from "@/lib/bms/reads";
import { SubmissionsInbox } from "./submissions-inbox";

const submission = (over: Partial<ApiSubmission> = {}): ApiSubmission => ({
  id: "s1",
  createdAt: new Date().toISOString(),
  form: { id: "f1", name: "Fruit box order" },
  recordId: "r1",
  customer: {
    recordId: "r1",
    entityId: "e1",
    name: "Ada Lovelace",
    email: "ada@example.test",
    phone: null,
  },
  order: {
    id: "0000000000000000000a1b2c",
    status: "draft",
    currency: "EUR",
    totalMinor: 3_200,
    balanceMinor: 3_200,
  },
  ...over,
});

function stub(
  pages: { data: ApiSubmission[]; meta: { hasMore: boolean; cursor: string | null } }[],
) {
  const fetchMock = vi.fn();
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SubmissionsInbox", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says who ordered, through which form, and links to the order", async () => {
    stub([{ data: [submission()], meta: { hasMore: false, cursor: null } }]);
    render(<SubmissionsInbox />);

    const who = await screen.findByRole("link", { name: "Ada Lovelace" });
    expect(who).toHaveAttribute("href", "/operations/orders/0000000000000000000a1b2c");
    expect(screen.getByText(/ordered through Fruit box order/)).toBeInTheDocument();
    expect(screen.getByText(/ada@example\.test/)).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("links a submission that raised no order to its records instead", async () => {
    stub([{ data: [submission({ order: null })], meta: { hasMore: false, cursor: null } }]);
    render(<SubmissionsInbox />);

    expect(await screen.findByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      "/entities/e1",
    );
    expect(screen.getByText(/submitted Fruit box order/)).toBeInTheDocument();
  });

  it("still shows a submission whose record has been deleted", async () => {
    stub([
      {
        data: [submission({ customer: null, order: null })],
        meta: { hasMore: false, cursor: null },
      },
    ]);
    render(<SubmissionsInbox />);
    expect(await screen.findByText("Someone")).toBeInTheDocument();
  });

  it("pages older submissions with the server's cursor", async () => {
    const user = userEvent.setup();
    const fetchMock = stub([
      { data: [submission()], meta: { hasMore: true, cursor: "next-page" } },
      {
        data: [
          submission({
            id: "s2",
            customer: { ...submission().customer!, name: "Grace Hopper" },
          }),
        ],
        meta: { hasMore: false, cursor: null },
      },
    ]);
    render(<SubmissionsInbox />);

    await user.click(await screen.findByRole("button", { name: "Show older" }));

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument());
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=next-page");
    expect(screen.queryByRole("button", { name: "Show older" })).not.toBeInTheDocument();
  });

  it("as a feed, asks for a short page and offers no paging", async () => {
    const fetchMock = stub([{ data: [submission()], meta: { hasMore: true, cursor: "more" } }]);
    render(<SubmissionsInbox limit={6} />);

    await screen.findByText("Ada Lovelace");
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=6");
    expect(screen.queryByRole("button", { name: "Show older" })).not.toBeInTheDocument();
  });

  it("states an empty inbox and a failed read differently", async () => {
    stub([{ data: [], meta: { hasMore: false, cursor: null } }]);
    const { unmount } = render(<SubmissionsInbox />);
    expect(await screen.findByText("Nothing has come in yet")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    render(<SubmissionsInbox />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't load your submissions",
    );
  });
});
