import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

/**
 * GRAFT-11.2 AC1 — extends the token->component wiring pattern GRAFT-11.1
 * established (src/components/ui/button.test.ts) to this batch's primitives
 * (select, dialog, tabs — see issue #38 Test Contract). Tabs is the one of
 * the three that renders without a Portal, so it's the one we can assert
 * against with `renderToStaticMarkup` in the node test environment; select
 * and dialog wrap their styled content in `SelectPrimitive.Portal` /
 * `DialogPrimitive.Portal`, which defer to a client-only mount and render
 * nothing under static SSR.
 *
 * The claim under test is the same as GRAFT-11.1's: Tabs is styled by
 * referencing Graft's theme tokens (the CSS variables wired in
 * src/app/globals.css), never a per-component colour literal. The proof is
 * structural: the rendered markup carries the Tailwind utility classes that
 * resolve to those CSS variables (`bg-muted`, `text-muted-foreground`), and
 * carries no inline style or hard-coded hex/oklch colour of its own.
 */
describe("Tabs token wiring", () => {
  it("renders the tab list and trigger using theme-token utility classes, not a literal colour", () => {
    const html = renderToStaticMarkup(
      createElement(
        Tabs,
        { defaultValue: "one" },
        createElement(
          TabsList,
          null,
          createElement(TabsTrigger, { value: "one" }, "One"),
          createElement(TabsTrigger, { value: "two" }, "Two"),
        ),
        createElement(TabsContent, { value: "one" }, "Panel one"),
      ),
    );

    // References the tokens (indirectly, via the Tailwind utilities that
    // compile to `var(--color-muted)` / `var(--color-muted-foreground)` per
    // the @theme inline block in globals.css) ...
    expect(html).toContain("bg-muted");
    expect(html).toContain("text-muted-foreground");

    // ... and does not hard-code a colour on the component itself. Changing
    // the --muted token in globals.css therefore repaints these tabs without
    // touching tabs.tsx.
    expect(html).not.toMatch(/style="[^"]*(#[0-9a-fA-F]{3,8}|rgb\(|oklch\()/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
