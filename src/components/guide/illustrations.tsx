/**
 * Small explanatory diagrams for the getting-started guide.
 *
 * Inline SVG rather than images: they must read in both themes, so the
 * strokes are `currentColor` and only the accents carry brand green — the
 * same rule the logo follows (`@/components/brand/graft-logo`). They are
 * decorative restatements of the prose beside them, so each is `aria-hidden`
 * and the text carries the meaning.
 *
 * Deliberately schematic. These illustrate *what a thing is* — a schema is a
 * named list of fields, records are rows under it — not what the UI looks
 * like, so they don't rot the moment a button moves.
 */
const FRAME = "stroke-current text-muted-foreground/40";
const INK = "fill-current text-muted-foreground/30";
const ACCENT = "fill-current text-graft-green";

function Svg({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg
      viewBox="0 0 200 120"
      role="img"
      aria-hidden="true"
      data-illustration={label}
      className="h-28 w-full max-w-56"
      fill="none"
      strokeWidth="1.5"
    >
      {children}
    </svg>
  );
}

/** An entity: a named box with a list of typed fields. */
export function EntityIllustration() {
  return (
    <Svg label="entity">
      <rect x="30" y="14" width="140" height="92" rx="8" className={FRAME} />
      <rect x="30" y="14" width="140" height="22" rx="8" className={ACCENT} opacity="0.12" />
      <rect x="42" y="22" width="52" height="6" rx="3" className={ACCENT} />
      {[48, 66, 84].map((y) => (
        <g key={y}>
          <rect x="42" y={y} width="46" height="6" rx="3" className={INK} />
          <rect x="100" y={y} width="58" height="6" rx="3" className={INK} opacity="0.5" />
        </g>
      ))}
    </Svg>
  );
}

/** Records: rows accumulating under that same header. */
export function RecordsIllustration() {
  return (
    <Svg label="records">
      <rect x="20" y="14" width="160" height="92" rx="8" className={FRAME} />
      <line x1="20" y1="38" x2="180" y2="38" className={FRAME} />
      {[30, 46, 90, 134].map((x) => (
        <rect key={x} x={x} y="22" width="30" height="6" rx="3" className={INK} />
      ))}
      {[48, 68, 88].map((y, index) => (
        <g key={y} opacity={index === 2 ? 0.45 : 1}>
          <rect
            x="30"
            y={y}
            width="30"
            height="6"
            rx="3"
            className={index === 2 ? ACCENT : INK}
          />
          <rect x="76" y={y} width="44" height="6" rx="3" className={INK} opacity="0.6" />
          <rect x="134" y={y} width="30" height="6" rx="3" className={INK} opacity="0.6" />
        </g>
      ))}
    </Svg>
  );
}

/** A public form feeding rows into the entity. */
export function FormIllustration() {
  return (
    <Svg label="form">
      <rect x="14" y="18" width="70" height="84" rx="8" className={FRAME} />
      {[30, 48, 66].map((y) => (
        <rect key={y} x="26" y={y} width="46" height="7" rx="3.5" className={INK} />
      ))}
      <rect x="26" y="84" width="30" height="9" rx="4.5" className={ACCENT} />
      <path d="M92 60 H124" className="stroke-current text-graft-green" />
      <path d="M118 54 L124 60 L118 66" className="stroke-current text-graft-green" />
      <rect x="132" y="26" width="54" height="68" rx="8" className={FRAME} />
      {[38, 54, 70].map((y, index) => (
        <rect
          key={y}
          x="142"
          y={y}
          width="34"
          height="6"
          rx="3"
          className={index === 0 ? ACCENT : INK}
          opacity={index === 0 ? 1 : 0.6}
        />
      ))}
    </Svg>
  );
}

/** A dashboard: widgets reading the records back out. */
export function DashboardIllustration() {
  return (
    <Svg label="dashboard">
      <rect x="16" y="14" width="80" height="42" rx="6" className={FRAME} />
      <rect x="28" y="26" width="34" height="12" rx="3" className={ACCENT} />
      <rect x="28" y="44" width="52" height="5" rx="2.5" className={INK} />
      <rect x="104" y="14" width="80" height="42" rx="6" className={FRAME} />
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={index}
          x={116 + index * 16}
          y={44 - index * 7}
          width="9"
          height={4 + index * 7}
          rx="2"
          className={ACCENT}
          opacity={0.35 + index * 0.2}
        />
      ))}
      <rect x="16" y="64" width="168" height="42" rx="6" className={FRAME} />
      <line x1="16" y1="80" x2="184" y2="80" className={FRAME} />
      {[72, 88, 96].map((y) => (
        <rect key={y} x="28" y={y} width="40" height="5" rx="2.5" className={INK} />
      ))}
      {[72, 88, 96].map((y) => (
        <rect
          key={`b${y}`}
          x="82"
          y={y}
          width="88"
          height="5"
          rx="2.5"
          className={INK}
          opacity="0.5"
        />
      ))}
    </Svg>
  );
}

/** How the pieces fit: forms and people write records; dashboards read them. */
export function FlowIllustration() {
  const box = (x: number, label: string) => (
    <g key={label}>
      <rect x={x} y="34" width="46" height="34" rx="6" className={FRAME} />
      <rect x={x + 10} y="46" width="26" height="6" rx="3" className={INK} />
      <rect x={x + 10} y="56" width="16" height="4" rx="2" className={INK} opacity="0.5" />
    </g>
  );

  return (
    <svg
      viewBox="0 0 320 100"
      role="img"
      aria-hidden="true"
      className="h-24 w-full max-w-md"
      fill="none"
      strokeWidth="1.5"
    >
      {box(12, "form")}
      {box(137, "entity")}
      {box(262, "dashboard")}
      <rect
        x="137"
        y="34"
        width="46"
        height="34"
        rx="6"
        className="stroke-current text-graft-green"
      />
      <path d="M62 51 H131" className="stroke-current text-graft-green" />
      <path d="M125 45 L131 51 L125 57" className="stroke-current text-graft-green" />
      <path d="M187 51 H256" className="stroke-current text-graft-green" />
      <path d="M250 45 L256 51 L250 57" className="stroke-current text-graft-green" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Booking (2026-09-12).
 *
 * The booking section originally shipped as prose alone, which made the page's
 * own visual language say "afterthought" about the one concept readers
 * actually get wrong. The confusion is a *shape* confusion — people model one
 * entity where the product needs two — and a shape confusion is what a diagram
 * is for, so the two-entity split is drawn before it is explained.
 * ------------------------------------------------------------------------ */

/** The resource: many records under one shape, each carrying a rate. */
export function ResourceIllustration() {
  return (
    <Svg label="resource">
      {/* Two offset cards behind the front one: ten boats, not one. */}
      <rect x="38" y="12" width="140" height="82" rx="8" className={FRAME} opacity="0.35" />
      <rect x="30" y="18" width="140" height="82" rx="8" className={FRAME} opacity="0.6" />
      <rect x="22" y="24" width="140" height="82" rx="8" className={FRAME} />
      <rect x="22" y="24" width="140" height="20" rx="8" className={ACCENT} opacity="0.12" />
      <rect x="34" y="31" width="44" height="6" rx="3" className={ACCENT} />
      <rect x="34" y="56" width="38" height="6" rx="3" className={INK} />
      <rect x="82" y="56" width="66" height="6" rx="3" className={INK} opacity="0.5" />
      {/* The rate row is the one with a required key, so it is the lit one. */}
      <rect x="34" y="74" width="38" height="6" rx="3" className={ACCENT} />
      <rect x="82" y="74" width="30" height="6" rx="3" className={ACCENT} opacity="0.45" />
    </Svg>
  );
}

/** The request: one submission, which is also the customer. */
export function RequestIllustration() {
  return (
    <Svg label="request">
      <rect x="26" y="14" width="148" height="92" rx="8" className={FRAME} />
      {/* A person, because this record is a someone and not a something. */}
      <circle cx="48" cy="36" r="9" className={ACCENT} opacity="0.25" />
      <circle cx="48" cy="33" r="3.5" className={ACCENT} />
      <path
        d="M42 41 a6 6 0 0 1 12 0"
        className="stroke-current text-graft-green"
        strokeWidth="2"
      />
      <rect x="66" y="28" width="52" height="6" rx="3" className={INK} />
      <rect x="66" y="39" width="76" height="5" rx="2.5" className={INK} opacity="0.5" />
      <line x1="26" y1="56" x2="174" y2="56" className={FRAME} />
      {/* Start and end, the two fields the booking settings point at. */}
      {[66, 84].map((y, index) => (
        <g key={y}>
          <rect x="38" y={y} width="30" height="6" rx="3" className={INK} />
          <rect
            x="78"
            y={y}
            width="46"
            height="6"
            rx="3"
            className={ACCENT}
            opacity={index === 0 ? 0.8 : 0.5}
          />
        </g>
      ))}
    </Svg>
  );
}

/** Capacity: a booked window, its turnaround gap, and what is left. */
export function CapacityIllustration() {
  return (
    <Svg label="capacity">
      <line x1="16" y1="88" x2="184" y2="88" className={FRAME} />
      {[16, 58, 100, 142, 184].map((x) => (
        <line key={x} x1={x} y1="84" x2={x} y2="92" className={FRAME} />
      ))}
      {/* Taken. */}
      <rect x="30" y="40" width="52" height="20" rx="5" className={ACCENT} opacity="0.85" />
      {/* The turnaround gap the engine bakes into the stored allocation. */}
      <rect x="82" y="40" width="16" height="20" rx="3" className={ACCENT} opacity="0.18" />
      <path d="M82 66 H98" className="stroke-current text-muted-foreground/50" />
      {/* Still free, and bookable right up to the boundary. */}
      <rect
        x="104"
        y="40"
        width="60"
        height="20"
        rx="5"
        className={FRAME}
        strokeDasharray="4 3"
      />
    </Svg>
  );
}

/** The form: a catalogue pick in, an order and a held slot out. */
export function BookingFormIllustration() {
  return (
    <Svg label="booking-form">
      <rect x="10" y="18" width="64" height="84" rx="8" className={FRAME} />
      {/* The catalogue: four things, one chosen. */}
      {[0, 1].map((row) =>
        [0, 1].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={20 + col * 22}
            y={28 + row * 22}
            width="18"
            height="18"
            rx="4"
            className={row === 0 && col === 0 ? ACCENT : INK}
            opacity={row === 0 && col === 0 ? 1 : 0.35}
          />
        )),
      )}
      <rect x="20" y="80" width="30" height="9" rx="4.5" className={ACCENT} />
      <path d="M82 60 H112" className="stroke-current text-graft-green" />
      <path d="M106 54 L112 60 L106 66" className="stroke-current text-graft-green" />
      {/* One submission, two operational consequences. */}
      <rect x="120" y="26" width="70" height="30" rx="6" className={FRAME} />
      <rect x="130" y="37" width="34" height="6" rx="3" className={ACCENT} />
      <rect x="120" y="64" width="70" height="30" rx="6" className={FRAME} />
      <rect x="130" y="75" width="44" height="6" rx="3" className={ACCENT} opacity="0.5" />
    </Svg>
  );
}

/**
 * The booking shape in one line: the resource is picked, the request is
 * written, and the request *is* the customer — the edge everyone misses.
 */
export function BookingFlowIllustration() {
  return (
    <svg
      viewBox="0 0 320 116"
      role="img"
      aria-hidden="true"
      className="h-28 w-full max-w-md"
      fill="none"
      strokeWidth="1.5"
    >
      {/* Resource entity — stacked, because there are many of them. */}
      <rect x="20" y="30" width="46" height="34" rx="6" className={FRAME} opacity="0.4" />
      <rect x="14" y="36" width="46" height="34" rx="6" className={FRAME} />
      <rect x="24" y="46" width="26" height="6" rx="3" className={INK} />
      <rect x="24" y="56" width="16" height="4" rx="2" className={ACCENT} />

      {/* The form doing the picking. */}
      <rect
        x="137"
        y="36"
        width="46"
        height="34"
        rx="6"
        className="stroke-current text-graft-green"
      />
      <rect x="147" y="46" width="26" height="6" rx="3" className={ACCENT} opacity="0.55" />
      <rect x="147" y="56" width="16" height="4" rx="2" className={INK} />

      {/* Request record — one person, and the customer of the order. */}
      <rect x="260" y="36" width="46" height="34" rx="6" className={FRAME} />
      <circle cx="275" cy="49" r="3.5" className={ACCENT} />
      <path
        d="M269 57 a6 6 0 0 1 12 0"
        className="stroke-current text-graft-green"
        strokeWidth="2"
      />
      <rect x="288" y="46" width="10" height="4" rx="2" className={INK} opacity="0.6" />
      <rect x="288" y="54" width="10" height="4" rx="2" className={INK} opacity="0.6" />

      <path d="M64 53 H131" className="stroke-current text-graft-green" />
      <path d="M125 47 L131 53 L125 59" className="stroke-current text-graft-green" />
      <path d="M187 53 H254" className="stroke-current text-graft-green" />
      <path d="M248 47 L254 53 L248 59" className="stroke-current text-graft-green" />
    </svg>
  );
}
