/**
 * FormCarousel — component coverage.
 *
 * The behaviour worth pinning is what changes with the number of images: one
 * photo must not render controls that can do nothing, and two or three must be
 * navigable by button, by dot and by keyboard, with the active slide announced
 * rather than merely styled.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FormCarousel, type CarouselImage } from "./form-carousel";

const image = (n: number): CarouselImage => ({
  mediaId: `media-${n}`,
  alt: `Product photo ${n}`,
  url: `/api/v1/public/media/media-${n}`,
});

const visibleSlide = () =>
  screen.getAllByRole("img").find((img) => img.getAttribute("aria-hidden") !== "true");

describe("FormCarousel", () => {
  it("renders nothing at all when there are no images", () => {
    const { container } = render(<FormCarousel images={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a single image with no navigation controls", () => {
    render(<FormCarousel images={[image(1)]} />);

    expect(screen.getByRole("img", { name: "Product photo 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous image" })).not.toBeInTheDocument();
  });

  it("keeps every slide mounted, hiding the inactive ones from assistive tech", () => {
    render(<FormCarousel images={[image(1), image(2), image(3)]} />);

    const slides = screen.getAllByRole("img", { hidden: true });
    expect(slides).toHaveLength(3);
    expect(slides.filter((s) => s.getAttribute("aria-hidden") !== "true")).toHaveLength(1);
  });

  it("advances with the next button and wraps at the end", async () => {
    const user = userEvent.setup();
    render(<FormCarousel images={[image(1), image(2)]} />);

    expect(visibleSlide()).toHaveAttribute("alt", "Product photo 1");

    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(visibleSlide()).toHaveAttribute("alt", "Product photo 2");

    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(visibleSlide()).toHaveAttribute("alt", "Product photo 1");
  });

  it("jumps straight to a slide from its dot, and marks it current", async () => {
    const user = userEvent.setup();
    render(<FormCarousel images={[image(1), image(2), image(3)]} />);

    await user.click(screen.getByRole("button", { name: "Show image 3 of 3" }));

    expect(visibleSlide()).toHaveAttribute("alt", "Product photo 3");
    expect(screen.getByRole("button", { name: "Show image 3 of 3" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("moves with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<FormCarousel images={[image(1), image(2)]} />);

    // Focus something inside the carousel so the key lands on its handler.
    await user.click(screen.getByRole("button", { name: "Show image 1 of 2" }));
    await user.keyboard("{ArrowRight}");
    expect(visibleSlide()).toHaveAttribute("alt", "Product photo 2");

    await user.keyboard("{ArrowLeft}");
    expect(visibleSlide()).toHaveAttribute("alt", "Product photo 1");
  });

  it("announces the position for screen readers", async () => {
    const user = userEvent.setup();
    render(<FormCarousel images={[image(1), image(2)]} />);

    expect(screen.getByText("Image 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByText("Image 2 of 2")).toBeInTheDocument();
  });
});
