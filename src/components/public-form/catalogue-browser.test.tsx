/**
 * The customer-facing catalogue.
 *
 * The rules worth pinning are the ones that keep a catalogue an *enhancement*
 * to a form rather than a gate in front of one: a failed or empty catalogue
 * renders nothing and says so, so the form can show its fields; choosing a
 * row hands the whole card up to the form; and a large catalogue is browsed a
 * page at a time — by scrolling, "Show more", or search — never all at once.
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
  accent: "#16a34a",
  onSelect: vi.fn(),
};

describe("CatalogueBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a page of resources row by row, naming each and labelling its details", async () => {
    stubFetch([{ data: [card("a", "Pontoon"), card("b", "Kayak")], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Items" }).children).toHaveLength(2);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    // The first value stands alone as the name; the rest carry their label,
    // because "120" on its own says nothing.
    expect(screen.getAllByText("Price")).toHaveLength(2);
    expect(screen.getAllByText("120")).toHaveLength(2);
  });

  it("never sends cookies to the public endpoint", async () => {
    const fetchMock = stubFetch([{ data: [card("a", "Pontoon")], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: "omit" });
  });

  it("renders nothing when the catalogue is empty — the form below still works", async () => {
    stubFetch([{ data: [], meta: { cursor: null } }]);

    const onUnavailable = vi.fn();
    const { container } = render(<CatalogueBrowser {...props} onUnavailable={onUnavailable} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the fetch fails, rather than an error the visitor can't act on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );

    const onUnavailable = vi.fn();
    const { container } = render(<CatalogueBrowser {...props} onUnavailable={onUnavailable} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("hands the whole chosen card to the form", async () => {
    const user = userEvent.setup();
    stubFetch([{ data: [card("a", "Pontoon"), card("b", "Kayak")], meta: { cursor: null } }]);
    const onSelect = vi.fn();

    render(<CatalogueBrowser {...props} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("Kayak")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Choose Kayak" }));
    expect(onSelect).toHaveBeenCalledWith(card("b", "Kayak"));
  });

  it("fetches the next page on 'Show more', with the server's cursor, appending", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([
      { data: [card("a", "Pontoon")], meta: { cursor: "CURSOR_1" } },
      { data: [card("b", "Kayak")], meta: { cursor: null } },
    ]);

    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Show more" }));

    await waitFor(() => expect(screen.getByText("Kayak")).toBeInTheDocument());
    expect(screen.getByText("Pontoon")).toBeInTheDocument();
    expect(urls(fetchMock)[1]).toContain("cursor=CURSOR_1");

    // Exhausted: no cursor came back, so there is nothing more to offer.
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches the next page as the end of the list scrolls into view", async () => {
    let trigger: (() => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          trigger = () =>
            callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        }
        observe() {}
        disconnect() {}
      },
    );
    const fetchMock = stubFetch([
      { data: [card("a", "Pontoon")], meta: { cursor: "CURSOR_1" } },
      { data: [card("b", "Kayak")], meta: { cursor: null } },
    ]);

    render(<CatalogueBrowser {...props} />);
    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    trigger!();

    await waitFor(() => expect(screen.getByText("Kayak")).toBeInTheDocument());
    expect(urls(fetchMock)[1]).toContain("cursor=CURSOR_1");
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

  it("shows a placeholder instead of a broken image for a record with no photo", async () => {
    stubFetch([{ data: [{ ...card("a", "Pontoon"), image: null }], meta: { cursor: null } }]);

    render(<CatalogueBrowser {...props} />);

    await waitFor(() => expect(screen.getByText("Pontoon")).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
