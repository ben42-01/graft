/**
 * GRAFT-11.5 Test Contract — `EmptyState` (AC1).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("AC1 — renders its title, description and action", () => {
    render(
      <EmptyState
        title="No entities yet"
        description="Create your first one to get started."
        action={<button type="button">Create entity</button>}
      />,
    );

    expect(screen.getByText("No entities yet")).toBeInTheDocument();
    expect(screen.getByText("Create your first one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create entity" })).toBeInTheDocument();
  });
});
