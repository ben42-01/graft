/**
 * The progress bar starts only on clicks that will actually navigate
 * client-side — anything else would leave a bar running with nothing loading.
 */
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationProgress, navigationTarget } from "./navigation-progress";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));

function clickOn(html: string, init: MouseEventInit = {}) {
  document.body.innerHTML = html;
  const target = document.querySelector("[data-click]")!;
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  let seen: URL | null = null;
  const probe = (e: MouseEvent) => {
    seen = navigationTarget(e, window.location);
  };
  document.addEventListener("click", probe);
  target.dispatchEvent(event);
  document.removeEventListener("click", probe);
  return seen as URL | null;
}

describe("navigationTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns the URL for a plain click on an internal link to another page", () => {
    const url = clickOn('<a href="/entities" data-click>Entities</a>');
    expect(url?.pathname).toBe("/entities");
  });

  it("follows the click up from an element inside the link", () => {
    const url = clickOn('<a href="/forms"><span data-click>Forms</span></a>');
    expect(url?.pathname).toBe("/forms");
  });

  it("ignores external links, new tabs, downloads and modifier clicks", () => {
    expect(clickOn('<a href="https://example.com/x" data-click>x</a>')).toBeNull();
    expect(clickOn('<a href="/forms" target="_blank" data-click>x</a>')).toBeNull();
    expect(clickOn('<a href="/export.csv" download data-click>x</a>')).toBeNull();
    expect(clickOn('<a href="/forms" data-click>x</a>', { metaKey: true })).toBeNull();
    expect(clickOn('<a href="/forms" data-click>x</a>', { ctrlKey: true })).toBeNull();
  });

  it("ignores links to the current page and non-link clicks", () => {
    const here = window.location.pathname;
    expect(clickOn(`<a href="${here}#section" data-click>x</a>`)).toBeNull();
    expect(clickOn("<button data-click>Save</button>")).toBeNull();
  });
});

describe("NavigationProgress", () => {
  it("shows the bar after an internal link click and not before", () => {
    vi.useFakeTimers();
    const { container } = render(
      <>
        <NavigationProgress />
        {/* A raw anchor on purpose: the bar listens for real link clicks. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/entities">Entities</a>
      </>,
    );
    const bar = () => container.querySelector("[data-phase]");
    act(() => {
      vi.runAllTimers();
    });
    expect(bar()).toHaveAttribute("data-phase", "idle");

    act(() => {
      fireEvent.click(container.querySelector("a")!);
    });
    expect(bar()).toHaveAttribute("data-phase", "loading");
    vi.useRealTimers();
  });
});
