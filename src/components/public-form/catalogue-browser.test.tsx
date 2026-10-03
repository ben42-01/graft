/**
 * The customer-facing catalogue.
 *
 * The rules worth pinning are the ones that keep a catalogue an *enhancement*
 * to a form rather than a gate in front of one: a failed or empty catalogue
 * renders nothing and says so, so the form can show its fields; choosing a
 * row hands the whole card up to the form; and a large catalogue is browsed a
 * page at a time — by scrolling, "Show more", or search — never all at once.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogueBrowser,
  MAX_CART_LINES,
  MAX_CART_QUANTITY,
  type CatalogueCard,
} from "./catalogue-browser";
import type { CartPricing } from "./cart";
import { PublicFormRenderer } from "./public-form-renderer";
import type { FieldDef } from "@/server/services/entities";

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

    // The observer is created in an effect that runs after the first page has
    // rendered; on a loaded machine the card is on screen a tick before it.
    await waitFor(() => expect(trigger).not.toBeNull());
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

/**
 * Cart mode (GRAFT-30.3). Rendered through the form, because the cart lives
 * with the form — that is what lets it survive paging this list — and because
 * what matters most is what the form finally sends.
 */
describe("CatalogueBrowser — cart mode", () => {
  const FIELDS: FieldDef[] = [
    { key: "customer", label: "Customer", type: "text", required: true },
  ];

  function cartServer(pages: Page[]) {
    let call = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("/submissions")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { submissionId: "s1" } }), { status: 201 }),
        );
      }
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const renderCart = (cartPricing: CartPricing = null, multiple = true) =>
    render(
      <PublicFormRenderer
        tenantSlug="bakery"
        formSlug="shop"
        fields={FIELDS}
        primaryColor={null}
        catalogue={{ selectionKey: null, multiple }}
        cartPricing={cartPricing}
      />,
    );

  const cartList = () => within(screen.getByRole("list", { name: "Cart items" }));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("AC1 — keeps a cart across pages and sends exactly { recordId, quantity } per line, no money", async () => {
    const user = userEvent.setup();
    const fetchMock = cartServer([
      { data: [card("a", "Loaf")], meta: { cursor: "CURSOR_1" } },
      { data: [card("b", "Veg box")], meta: { cursor: null } },
    ]);
    renderCart({ rateBasis: "flat", rateKey: "price" });

    await user.click(await screen.findByRole("button", { name: "Add Loaf" }));
    await user.click(cartList().getByRole("button", { name: "Increase quantity of Loaf" }));

    // Page two: the cart does not care which page an item came from.
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await user.click(await screen.findByRole("button", { name: "Add Veg box" }));

    expect(cartList().getAllByRole("listitem")).toHaveLength(2);
    expect(cartList().getByRole("spinbutton", { name: "Quantity of Loaf" })).toHaveValue(2);
    expect(cartList().getByRole("spinbutton", { name: "Quantity of Veg box" })).toHaveValue(1);

    await user.click(screen.getByRole("button", { name: "Continue to your details" }));
    await user.type(screen.getByLabelText(/Customer/), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText(/your submission was received/);

    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/submissions"),
    )!;
    const body = JSON.parse(String(init!.body));
    // The exact shape: nothing beside the answers, the render timestamp and
    // the cart — no `_selection`, and no price, rate or total anywhere.
    expect(Object.keys(body).sort()).toEqual(["_cart", "_t", "data"]);
    expect(typeof body._t).toBe("number");
    expect(body.data).toEqual({ customer: "Ada" });
    expect(body._cart).toEqual([
      { recordId: "a", quantity: 2 },
      { recordId: "b", quantity: 1 },
    ]);
    for (const line of body._cart) {
      expect(Object.keys(line).sort()).toEqual(["quantity", "recordId"]);
    }
    // The estimate was on screen (360.00), and it goes nowhere. `_t` is left
    // out of this check: a millisecond timestamp can contain any digits.
    const rest = { data: body.data, _cart: body._cart };
    expect(JSON.stringify(rest)).not.toMatch(/price|total|amount|rate|120|360/i);
  });

  it("AC2 — shows an estimated total only for flat pricing with a public rate", async () => {
    const user = userEvent.setup();
    cartServer([{ data: [card("a", "Loaf")], meta: { cursor: null } }]);
    const { unmount } = renderCart({ rateBasis: "flat", rateKey: "price" });

    await user.click(await screen.findByRole("button", { name: "Add Loaf" }));
    await user.click(cartList().getByRole("button", { name: "Increase quantity of Loaf" }));
    expect(screen.getByText("Estimated total, confirmed at checkout")).toBeInTheDocument();
    expect(screen.getByTestId("cart-estimate")).toHaveTextContent("240.00");
    unmount();

    for (const pricing of [{ rateBasis: "daily", rateKey: "price" }, null]) {
      const view = renderCart(pricing);
      await user.click(await screen.findByRole("button", { name: "Add Loaf" }));
      expect(screen.queryByText(/Estimated total/)).not.toBeInTheDocument();
      expect(screen.queryByTestId("cart-estimate")).not.toBeInTheDocument();
      expect(
        within(screen.getByRole("region", { name: "Your cart" })).getByText(
          "1 item in your cart",
        ),
      ).toBeInTheDocument();
      view.unmount();
    }
  });

  it("AC3 — continue needs an item; quantity stays between 1 and the server's bound", async () => {
    const user = userEvent.setup();
    cartServer([{ data: [card("a", "Loaf")], meta: { cursor: null } }]);
    renderCart();

    const next = await screen.findByRole("button", { name: "Continue to your details" });
    expect(next).toBeDisabled();

    await user.click(await screen.findByRole("button", { name: "Add Loaf" }));
    expect(next).toBeEnabled();

    expect(
      cartList().getByRole("button", { name: "Decrease quantity of Loaf" }),
    ).toBeDisabled();

    const quantity = cartList().getByRole("spinbutton", { name: "Quantity of Loaf" });
    fireEvent.change(quantity, { target: { value: String(MAX_CART_QUANTITY + 5) } });
    expect(quantity).toHaveValue(MAX_CART_QUANTITY);
    expect(
      cartList().getByRole("button", { name: "Increase quantity of Loaf" }),
    ).toBeDisabled();

    fireEvent.change(quantity, { target: { value: "0" } });
    expect(quantity).toHaveValue(1);

    // Removing the only line empties the cart and disables continue again.
    await user.click(cartList().getByRole("button", { name: "Remove Loaf" }));
    expect(next).toBeDisabled();
  });

  it(`AC3 — at ${MAX_CART_LINES} lines further adds are disabled, with a message`, async () => {
    const cards = Array.from({ length: MAX_CART_LINES + 1 }, (_, i) =>
      card(`r${i}`, `Item ${i}`),
    );
    cartServer([{ data: cards, meta: { cursor: null } }]);
    renderCart();

    await screen.findByRole("button", { name: "Add Item 0" });
    for (let i = 0; i < MAX_CART_LINES; i += 1) {
      // fireEvent, not userEvent: twenty full pointer sequences would crowd the
      // default test timeout on a slow CI runner, and nothing here is about the pointer.
      fireEvent.click(screen.getByRole("button", { name: `Add Item ${i}` }));
    }

    expect(screen.getByRole("button", { name: `Add Item ${MAX_CART_LINES}` })).toBeDisabled();
    expect(screen.getByText(/Your cart is full/)).toBeInTheDocument();
    // Twenty-one rows re-rendered twenty times is slow in jsdom, not in a browser.
  }, 15_000);

  it("AC5 — a single-choice form keeps its rows as choose buttons and shows no cart", async () => {
    cartServer([{ data: [card("a", "Loaf")], meta: { cursor: null } }]);
    renderCart(null, false);

    expect(await screen.findByRole("button", { name: "Choose Loaf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Loaf" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your cart" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue to your details" }),
    ).not.toBeInTheDocument();
  });

  it("AC7 — names the item on every control and announces changes politely", async () => {
    const user = userEvent.setup();
    cartServer([{ data: [card("a", "Loaf")], meta: { cursor: null } }]);
    renderCart();

    await user.click(await screen.findByRole("button", { name: "Add Loaf" }));
    const live = screen.getByText(/Added Loaf to your cart/);
    expect(live).toHaveAttribute("aria-live", "polite");

    await user.click(cartList().getByRole("button", { name: "Increase quantity of Loaf" }));
    expect(live).toHaveTextContent("Loaf: quantity 2.");

    await user.click(cartList().getByRole("button", { name: "Remove Loaf" }));
    expect(live).toHaveTextContent(/Removed Loaf from your cart/);
  });
});
