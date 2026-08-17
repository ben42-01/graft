/**
 * GRAFT-11.5 Test Contract — `ErrorBoundary` (AC2): swallows a thrown error
 * and renders the fallback, never the raw error.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./error-boundary";

function Bomb(): never {
  throw new Error("boom: secret-stack-trace");
}

describe("ErrorBoundary", () => {
  it("AC2 — renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div>safe content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("safe content")).toBeInTheDocument();
  });

  it("AC2 — swallows a thrown error and renders the fallback, never the raw error", () => {
    // React logs the caught error to the console by default; silence it so
    // the expected throw doesn't pollute test output.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.queryByText(/secret-stack-trace/)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("secret-stack-trace");

    consoleError.mockRestore();
  });
});
