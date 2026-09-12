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

// The same gap, two APIs further on. Radix's Select uses pointer capture to
// track a press that leaves the trigger, and scrolls the highlighted option
// into view when its listbox opens; jsdom implements neither, so *opening* a
// Select in a test throws rather than failing an assertion. No-ops are enough
// — nothing under test asserts on capture or on scroll position.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
});
