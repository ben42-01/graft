"use client";

/**
 * The product carousel on a public form page — up to three photos the business
 * attached to its own form (docs/Graft.md §4.4, "the link looks like a proper
 * advert").
 *
 * Three things matter enough to call out:
 *
 *   - **One image is not a carousel.** With a single slide the controls are not
 *     rendered at all rather than rendered disabled: a next button that can
 *     never do anything is noise for a sighted visitor and a lie to a screen
 *     reader.
 *   - **Every slide stays in the DOM.** Inactive slides are hidden with
 *     `aria-hidden` and pointer-events rather than unmounted, so the browser
 *     keeps them decoded and moving between them is instant — the whole point
 *     of a three-image strip on a page someone may be viewing over mobile data.
 *   - **`next/image` is deliberately not used.** These are tenant uploads
 *     served through `/api/v1/public/media/:id`, which 307s to a presigned
 *     bucket URL; the optimiser would need every possible bucket host
 *     allow-listed in next.config, and would re-fetch a URL that expires. Same
 *     reasoning the page already applies to `branding.logoUrl`.
 */
import { useEffect, useId, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type CarouselImage = { mediaId: string; alt: string; url: string };

export function FormCarousel({
  images,
  className,
}: {
  images: readonly CarouselImage[];
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const labelId = useId();

  // A carousel whose images changed under it (a builder preview re-rendering)
  // must not keep pointing past the end of the new array.
  useEffect(() => {
    setIndex((current) => (current < images.length ? current : 0));
  }, [images.length]);

  if (images.length === 0) return null;

  const many = images.length > 1;
  const go = (delta: number) => setIndex((c) => (c + delta + images.length) % images.length);

  return (
    <section
      aria-roledescription={many ? "carousel" : undefined}
      aria-labelledby={many ? labelId : undefined}
      className={cn("flex flex-col gap-3", className)}
      onKeyDown={
        many
          ? (event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                go(-1);
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                go(1);
              }
            }
          : undefined
      }
    >
      {many ? (
        <h2 id={labelId} className="sr-only">
          Product images
        </h2>
      ) : null}

      <div className="relative overflow-hidden rounded-xl border border-graft-green/20 bg-muted ring-1 ring-graft-green/5">
        {/* A fixed aspect box, so a tall photo and a wide one produce the same
         * page height and the fields below never jump as slides change. */}
        <div className="relative aspect-[4/3] w-full">
          {images.map((image, i) => (
            <img
              key={image.mediaId}
              src={image.url}
              alt={image.alt}
              // The first slide is what the page is judged on; the rest can
              // wait until the browser has drawn something.
              loading={i === 0 ? "eager" : "lazy"}
              aria-hidden={i !== index}
              className={cn(
                "absolute inset-0 size-full object-cover transition-opacity duration-300",
                i === index ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            />
          ))}
        </div>

        {many ? (
          <>
            <CarouselButton side="left" onClick={() => go(-1)} label="Previous image" />
            <CarouselButton side="right" onClick={() => go(1)} label="Next image" />
          </>
        ) : null}
      </div>

      {many ? (
        <div className="flex items-center justify-center gap-2">
          {images.map((image, i) => (
            <button
              key={image.mediaId}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Show image ${i + 1} of ${images.length}`}
              aria-current={i === index}
              className={cn(
                "size-2 rounded-full transition-all focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:ring-offset-2 focus-visible:outline-none",
                i === index
                  ? "w-5 bg-graft-green"
                  : "bg-muted-foreground/40 hover:bg-muted-foreground/70",
              )}
            />
          ))}
        </div>
      ) : null}

      {/* Announced on change, so a screen-reader user moving through slides is
       * told where they landed without the image itself stealing focus. */}
      <div aria-live="polite" className="sr-only">
        {many ? `Image ${index + 1} of ${images.length}` : null}
      </div>
    </section>
  );
}

function CarouselButton({
  side,
  onClick,
  label,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
}) {
  const Icon = side === "left" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 rounded-full bg-background/85 p-1.5 text-foreground shadow-sm backdrop-blur-sm transition-colors",
        "hover:bg-background focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
