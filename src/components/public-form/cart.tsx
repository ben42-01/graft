"use client";

/**
 * Cart mode on the public page (GRAFT-30.3, docs/Graft.md §4.4) — the visible
 * half of `catalogue.multiple`.
 *
 * The cart lives with the form, not with the catalogue list, so it survives
 * paging and searching the list and is still there on the details step. It
 * lives only in this page's memory: there is no cart across visits or devices.
 *
 * **The client is display-only for money.** What leaves this page is
 * `cartPayload` — `{ recordId, quantity }` per line and nothing else. The
 * estimated total is arithmetic over the public card values, shown only when
 * the server said how the order is priced (`rateBasis: "flat"` and a public
 * `rateKey`), labelled as an estimate, and never sent anywhere.
 */
import { useCallback, useState } from "react";
import {
  MAX_CART_LINES,
  QuantityStepper,
  nameOf,
  type CartApi,
  type CartLine,
  type CatalogueCard,
} from "@/components/public-form/catalogue-browser";

/** The public pricing hint (`PublicCartPricing`, GRAFT-30.1 AC7). */
export type CartPricing = { rateBasis: string; rateKey: string } | null;

export type Cart = CartApi & {
  /** Per-line server errors, by record id — so they follow the line, not an index. */
  errors: Record<string, string>;
  /** Maps the server's `_cart.<i>` errors onto the lines that were sent. */
  applyServerErrors: (fields: Record<string, string>, sent: CartLine[]) => boolean;
  /** The last change, for the polite live region (AC7). */
  announcement: string;
};

/** The only thing sent: which record, how many. Never a price or a total. */
export function cartPayload(lines: CartLine[]): { recordId: string; quantity: number }[] {
  return lines.map((line) => ({ recordId: line.card.id, quantity: line.quantity }));
}

/**
 * The estimate, or `null` when there is nothing honest to show: no pricing
 * hint, a basis other than flat (a daily or hourly price depends on dates not
 * chosen yet), or a line whose rate is not a readable number.
 */
export function estimatedTotal(lines: CartLine[], pricing: CartPricing): number | null {
  if (!pricing || pricing.rateBasis !== "flat" || lines.length === 0) return null;
  let total = 0;
  for (const line of lines) {
    const raw = line.card.values.find((value) => value.key === pricing.rateKey)?.value;
    const rate = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(rate)) return null;
    total += rate * line.quantity;
  }
  return total;
}

export function useCart(): Cart {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");

  const add = useCallback(
    (card: CatalogueCard) => {
      if (lines.length >= MAX_CART_LINES || lines.some((line) => line.card.id === card.id))
        return;
      setLines([...lines, { card, quantity: 1 }]);
      setAnnouncement(`Added ${nameOf(card)} to your cart. ${countLabel(lines.length + 1)}.`);
    },
    [lines],
  );

  const remove = useCallback(
    (id: string) => {
      const line = lines.find((entry) => entry.card.id === id);
      if (!line) return;
      setLines(lines.filter((entry) => entry.card.id !== id));
      setErrors((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setAnnouncement(
        `Removed ${nameOf(line.card)} from your cart. ${countLabel(lines.length - 1)}.`,
      );
    },
    [lines],
  );

  const setQuantity = useCallback(
    (id: string, quantity: number) => {
      const line = lines.find((entry) => entry.card.id === id);
      if (!line || line.quantity === quantity) return;
      setLines(lines.map((entry) => (entry.card.id === id ? { ...entry, quantity } : entry)));
      setAnnouncement(`${nameOf(line.card)}: quantity ${quantity}.`);
    },
    [lines],
  );

  const applyServerErrors = useCallback((fields: Record<string, string>, sent: CartLine[]) => {
    const next: Record<string, string> = {};
    for (const [key, message] of Object.entries(fields)) {
      const [head, index] = key.split(".");
      if (head !== "_cart" || index === undefined || !/^\d+$/.test(index)) continue;
      const line = sent[Number(index)];
      if (line && !(line.card.id in next)) next[line.card.id] = message;
    }
    setErrors(next);
    return Object.keys(next).length > 0;
  }, []);

  return { lines, add, remove, setQuantity, errors, applyServerErrors, announcement };
}

const countLabel = (n: number) =>
  n === 0 ? "Your cart is empty" : `${n} ${n === 1 ? "item" : "items"} in your cart`;

const formatAmount = (amount: number) =>
  amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The cart as the visitor reviews it: each line with its quantity (editable),
 * a remove button, and any error the server raised against it; then the
 * estimate, or just the count.
 */
export function CartSummary({ cart, pricing }: { cart: Cart; pricing: CartPricing }) {
  const total = estimatedTotal(cart.lines, pricing);
  return (
    <section
      aria-label="Your cart"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">Your cart</h2>
      {cart.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet — add items from the list to continue.
        </p>
      ) : (
        <ul aria-label="Cart items" className="flex flex-col gap-2">
          {cart.lines.map((line) => {
            const error = cart.errors[line.card.id];
            const errorId = `cart-error-${line.card.id}`;
            return (
              <li
                key={line.card.id}
                aria-describedby={error ? errorId : undefined}
                className={`flex flex-col gap-1 rounded-lg p-2 ${error ? "border border-destructive" : ""}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-sm font-medium">{nameOf(line.card)}</span>
                  <QuantityStepper line={line} cart={cart} />
                </div>
                {error ? (
                  <p id={errorId} className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="flex justify-between gap-2 border-t pt-3 text-sm">
        {total !== null ? (
          <>
            <span className="text-muted-foreground">
              Estimated total, confirmed at checkout
            </span>
            <span className="font-semibold" data-testid="cart-estimate">
              {formatAmount(total)}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{countLabel(cart.lines.length)}</span>
        )}
      </p>
      <p aria-live="polite" className="sr-only">
        {cart.announcement}
      </p>
    </section>
  );
}
