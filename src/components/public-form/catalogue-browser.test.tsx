/**
 * The customer-facing catalogue.
 *
 * The rules worth pinning are the ones that keep a catalogue an *enhancement*
 * to a form rather than a gate in front of one: a failed or empty catalogue
 * renders nothing and leaves the form below working, selecting is a reversible
 * choice the visitor can see they made, and a large catalogue is browsed a
 * page at a time — in one row, or by search — never laid out all at once.
 */
import { useState } from "react";
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

type Page = {
  data: CatalogueCard[];
  meta: { cursor: string | null; searchLabel?: string | null };
};

function stubFetch(pages: Page[]) {
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

const urls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.map(([input]) => String(input));

const props = {
  tenantSlug: "harbour",
  formSlug: "book-a-boat",
  selectedId: null,
  onSelect: vi.fn(),
  primaryColor: null,
};

/** The browser with its selection actually held, the way the form holds it. */
function Selectable() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return <CatalogueBrowser {...props} selectedId={selectedId} onSelect={setSelectedId} />;
}

describe("CatalogueBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a page of cards in one row, naming each item and labelling its details", async () => {
    stubFetch([{ data: [card("a", "Pontoon"), card("b", "Kayak")], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Items" }).children).toHaveLength(2);
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

  it("fetches the next page only when the visitor moves on, with the server's cursor, appending", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([
      { data: [card("a", "Pontoon")], meta: { cursor: "CURSOR_1" } },
      { data: [card("b", "Kayak")], meta: { cursor: null } },
    ]);

    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Next items" }));

    await waitFor(() => expect(screen.getByText("Kayak")).toBeInTheDocument());
    expect(screen.getByText("Pontoon")).toBeInTheDocument();
    expect(urls(fetchMock)[1]).toContain("cursor=CURSOR_1");

    // Exhausted: no cursor came back, so moving on asks for nothing more.
    await user.click(screen.getByRole("button", { name: "Next items" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers search only when the server says there is a field to search", async () => {
    stubFetch([{ data: [card("a", "Pontoon")], meta: { cursor: null, searchLabel: null } }]);
    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("searches the server rather than what is loaded, replacing the row", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([
      {
        data: [card("a", "Pontoon"), card("b", "Barge")],
        meta: { cursor: "CURSOR_1", searchLabel: "Name" },
      },
      { data: [card("z", "Kayak 900")], meta: { cursor: null, searchLabel: "Name" } },
    ]);

    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());

    await user.type(screen.getByRole("searchbox", { name: "Search by name" }), "kayak");

    await waitFor(() => expect(screen.getByText("Kayak 900")).toBeInTheDocument());
    expect(screen.queryByText("Pontoon")).not.toBeInTheDocument();
    const searched = urls(fetchMock).at(-1)!;
    expect(searched).toContain("q=kayak");
    expect(searched).not.toContain("cursor=");
  });

  it("says when nothing matches, and keeps the search box", async () => {
    const user = userEvent.setup();
    stubFetch([
      { data: [card("a", "Pontoon")], meta: { cursor: null, searchLabel: "Name" } },
      { data: [], meta: { cursor: null, searchLabel: "Name" } },
    ]);

    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    await user.type(screen.getByRole("searchbox"), "zzz");

    expect(await screen.findByText("Nothing matches “zzz”.")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("zzz");
  });

  it("keeps the chosen item named after a search replaces the row, and lets it be cleared", async () => {
    const user = userEvent.setup();
    stubFetch([
      { data: [card("a", "Pontoon")], meta: { cursor: null, searchLabel: "Name" } },
      { data: [card("z", "Kayak 900")], meta: { cursor: null, searchLabel: "Name" } },
    ]);

    render(<Selectable />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Pontoon/ }));

    await user.type(screen.getByRole("searchbox"), "kayak");
    await waitFor(() => expect(screen.getByText("Kayak 900")).toBeInTheDocument());
    expect(screen.getByText("Pontoon")).toBeInTheDocument();
    expect(screen.getByText(/Selected:/)).toHaveTextContent("Selected: Pontoon");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Pick one to enquire/)).toBeInTheDocument();
  });

  it("shows a placeholder instead of a broken image for a record with no photo", async () => {
    stubFetch([{ data: [{ ...card("a", "Pontoon"), image: null }], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
