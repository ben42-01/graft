/**
 * GRAFT-11.5 Test Contract — `ErrorState` (AC1, AC2).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  it("AC1 — renders an accessible alert with title and description", () => {
    render(<ErrorState title="Couldn't load entities" description="Please try again." />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load entities");
    expect(alert).toHaveTextContent("Please try again.");
  });

  it("AC2 — has no prop through which a raw error/stack could be rendered", () => {
    // The component's props are `title`/`description`/`action` only — there
    // is no `error` prop, so nothing can pass a caught Error through to it.
    // @ts-expect-error — `error` is not a valid prop, proving the contract.
    render(<ErrorState error={new Error("boom: secret-stack-trace")} />);

    expect(screen.queryByText(/secret-stack-trace/)).not.toBeInTheDocument();
  });
});
