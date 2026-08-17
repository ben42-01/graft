/**
 * GRAFT-11.5 Test Contract — `LoadingState` (AC1).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingState } from "./loading-state";

describe("LoadingState", () => {
  it("AC1 — renders an accessible status with its label", () => {
    render(<LoadingState label="Loading your entities…" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading your entities…");
  });

  it("AC1 — defaults to a generic label", () => {
    render(<LoadingState />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });
});
