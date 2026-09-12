/**
 * The customer-facing catalogue.
 *
 * The rules worth pinning are the ones that keep a catalogue an *enhancement*
 * to a form rather than a gate in front of one: a failed or empty catalogue
 * renders nothing at all and leaves the form below working, and selecting is
 * a reversible choice the visitor can see they have made.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogueBrowser, type CatalogueCard } from "./catalogue-browser";

const card = (id: string, name: string): CatalogueCard => ({
  id,
  image: { url: `/api/v1/public/media/${id}`, alt: name },
  values: [
    { key: "name", label: "Name", value: name },
    { key: "price", label: "Price", value: "120" },
  ],
});

function stubFetch(pages: { data: CatalogueCard[]; meta: { cursor: string | null } }[]) {
  let call = 0;
  // `init` is declared even though the stub ignores it: the assertions read it
  // back off the recorded calls.
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
    const page = pages[Math.min(call, pages.length - 1)]!;
    call += 1;
    return Promise.resolve(
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const props = {
  tenantSlug: "harbour",
  formSlug: "book-a-boat",
  selectedId: null,
  onSelect: vi.fn(),
  primaryColor: null,
};

describe("CatalogueBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a page of cards, naming each item and labelling its details", async () => {
    stubFetch([{ data: [card("a", "Pontoon"), card("b", "Kayak")], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    // The first value stands alone as the name; the rest carry their label,
    // because "120" on its own says nothing.
    expect(screen.getAllByText("Price: 120")).toHaveLength(2);
  });

  it("never sends cookies to the public endpoint", async () => {
    const fetchMock = stubFetch([{ data: [card("a", "Pontoon")], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: "omit" });
  });

  it("renders nothing when the catalogue is empty — the form below still works", async () => {
    stubFetch([{ data: [], meta: { cursor: null } }]);

    const { container } = render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing when the fetch fails, rather than an error the visitor can't act on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );

    const { container } = render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("reports a selection, and reports clearing it when the same card is clicked again", async () => {
    const user = userEvent.setup();
    stubFetch([{ data: [card("a", "Pontoon")], meta: { cursor: null } }]);
    const onSelect = vi.fn();

    const { rerender } = render(<CatalogueBrowser {...props} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Pontoon/ }));
    expect(onSelect).toHaveBeenCalledWith("a");

    rerender(<CatalogueBrowser {...props} selectedId="a" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /Pontoon/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: /Pontoon/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("tells the visitor what a selection means for the form below", async () => {
    stubFetch([{ data: [card("a", "Pontoon")], meta: { cursor: null } }]);

    const { rerender } = render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText(/Pick one to enquire/)).toBeInTheDocument());

    rerender(<CatalogueBrowser {...props} selectedId="a" />);
    expect(screen.getByText(/now fill in your details below/)).toBeInTheDocument();
  });

  it("pages with the cursor the server issued, appending rather than replacing", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([
      { data: [card("a", "Pontoon")], meta: { cursor: "CURSOR_1" } },
      { data: [card("b", "Kayak")], meta: { cursor: null } },
    ]);

    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Show more" }));

    await waitFor(() => expect(screen.getByText("Kayak")).toBeInTheDocument());
    expect(screen.getByText("Pontoon")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1]![0])).toContain("cursor=CURSOR_1");
    // Exhausted: no cursor came back, so there is nothing left to ask for.
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("shows a placeholder instead of a broken image for a record with no photo", async () => {
    stubFetch([{ data: [{ ...card("a", "Pontoon"), image: null }], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
