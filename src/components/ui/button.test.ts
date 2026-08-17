import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

/**
 * GRAFT-11.1 AC1 — establishes the token->component wiring pattern GRAFT-11.2
 * and GRAFT-11.3 reuse for their own primitive batches (see Test Contract).
 *
 * The claim under test: a shadcn primitive is styled by referencing Graft's
 * theme tokens (the `--primary` / `--primary-foreground` CSS variables wired
 * in src/app/globals.css), never a per-component colour literal. We can't
 * assert computed colour without a browser, so the proof is structural: the
 * rendered markup carries the Tailwind utility classes that resolve to those
 * CSS variables (`bg-primary`, `text-primary-foreground`), and carries no
 * inline style or hard-coded hex/oklch colour of its own.
 */
describe("Button token wiring", () => {
  it("renders the default variant using theme-token utility classes, not a literal colour", () => {
    const html = renderToStaticMarkup(createElement(Button, null, "Save"));

    // References the tokens (indirectly, via the Tailwind utilities that
    // compile to `var(--color-primary)` / `var(--color-primary-foreground)`
    // per the @theme inline block in globals.css) ...
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");

    // ... and does not hard-code a colour on the component itself. Changing
    // the --primary token in globals.css therefore repaints this button
    // without touching button.tsx.
    expect(html).not.toMatch(/style="[^"]*(#[0-9a-fA-F]{3,8}|rgb\(|oklch\()/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
