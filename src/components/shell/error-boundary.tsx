"use client";

/**
 * Catch-all error boundary (GRAFT-11.5 AC2) — React only offers this via a
 * class component's `getDerivedStateFromError`/`componentDidCatch`; there is
 * no hook equivalent. Swallows whatever it catches and renders `ErrorState`
 * — the caught error/stack is never interpolated into the fallback, so it
 * can never reach the rendered UI (docs/GO-LIVE.md §7).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/components/shell/error-state";

export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorState
          title="Something went wrong"
          description="This section couldn't be displayed. Please try again."
        />
      );
    }
    return this.props.children;
  }
}
