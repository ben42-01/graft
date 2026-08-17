import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

/**
 * GRAFT-11.3 AC1 — extends the token->component wiring pattern GRAFT-11.1
 * established (src/components/ui/button.test.ts) and GRAFT-11.2 continued
 * (src/components/ui/tabs.test.ts) to this batch's primitives (sheet, table,
 * calendar, sonner — see issue #39 Test Contract). Table is the one of the
 * four that renders without a Portal or client-only mount, so it's the one
 * we can assert against with `renderToStaticMarkup` in the node test
 * environment; sheet wraps its styled content in `DialogPrimitive.Portal`,
 * calendar relies on react-day-picker's client-side layout, and sonner's
 * Toaster is a client-only portal — none render meaningful markup under
 * static SSR.
 *
 * The claim under test is the same as GRAFT-11.1's and GRAFT-11.2's: Table
 * is styled by referencing Graft's theme tokens (the CSS variables wired in
 * src/app/globals.css), never a per-component colour literal. The proof is
 * structural: the rendered markup carries the Tailwind utility classes that
 * resolve to those CSS variables (`bg-muted/50`, `text-foreground`), and
 * carries no inline style or hard-coded hex/oklch colour of its own.
 */
describe("Table token wiring", () => {
  it("renders header, body and footer using theme-token utility classes, not a literal colour", () => {
    const html = renderToStaticMarkup(
      createElement(
        Table,
        null,
        createElement(
          TableHeader,
          null,
          createElement(TableRow, null, createElement(TableHead, null, "Name")),
        ),
        createElement(
          TableBody,
          null,
          createElement(TableRow, null, createElement(TableCell, null, "Alice")),
        ),
        createElement(
          TableFooter,
          null,
          createElement(TableRow, null, createElement(TableCell, null, "Total")),
        ),
      ),
    );

    // References the tokens (indirectly, via the Tailwind utilities that
    // compile to `var(--color-muted)` / `var(--color-foreground)` per the
    // @theme inline block in globals.css) ...
    expect(html).toContain("bg-muted/50");
    expect(html).toContain("text-foreground");

    // ... and does not hard-code a colour on the component itself. Changing
    // the --muted token in globals.css therefore repaints this table without
    // touching table.tsx.
    expect(html).not.toMatch(/style="[^"]*(#[0-9a-fA-F]{3,8}|rgb\(|oklch\()/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
