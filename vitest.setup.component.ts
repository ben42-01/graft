/** Component test setup: jest-dom matchers + per-test DOM cleanup. */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom has no layout engine, so it never implements ResizeObserver — Radix's
// Select (first exercised by a component test in GRAFT-10) measures its
// trigger with one on mount. A minimal no-op stub is enough since nothing
// under test asserts on a resize callback firing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
});
