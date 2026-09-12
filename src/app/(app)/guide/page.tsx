/**
 * Getting started — the guide (2026-08-21 UI refinement).
 *
 * Written because the product assumed knowledge it never taught: someone who
 * signs up, creates an entity and lands back on an empty screen has no way
 * to know that an entity is a *shape* and that records are what fill it, or
 * that forms write records and dashboards read them. Every step below ends
 * in a link to the screen that performs it, so the guide is a route into the
 * product rather than a page about it.
 *
 * 2026-09-12 — "Taking bookings" was added. The booking path asks a tenant to
 * model *two* entities (the resource and the request) and nothing said so, so
 * the obvious reading — one "Boats" entity that somehow also holds the
 * customer — produced a form that could not be bridged. The section states the
 * two-entity shape, names the exact field keys the pricing and bridge code
 * match on, and calls out the two settings that cannot be changed later.
 *
 * A server component — static explanation, no session needed.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  BookingFlowIllustration,
  BookingFormIllustration,
  CapacityIllustration,
  DashboardIllustration,
  EntityIllustration,
  FlowIllustration,
  FormIllustration,
  RecordsIllustration,
  RequestIllustration,
  ResourceIllustration,
} from "@/components/guide/illustrations";

export const metadata: Metadata = { title: "Getting started — Graft" };

type Step = {
  title: string;
  what: string;
  detail: string;
  /** A step only carries a CTA when the product has a screen that performs
   * it — a step that sends you somewhere that cannot do the thing is worse
   * than a step with no button. */
  href?: string;
  cta?: string;
  note?: string;
  detailExtra?: string;
  illustration: () => React.ReactElement;
};

const STEPS: Step[] = [
  {
    title: "Define an entity",
    what: "An entity is a kind of thing you track — customers, jobs, invoices, bookings.",
    detail:
      "You give it a name and a list of fields, and those fields become the columns everything else uses. It holds no data itself: it is the shape the data takes. Most workspaces need two or three, not twenty — start with the one thing you look up most often. If you are not sure which fields you need, start from a template and edit it.",
    href: "/entities/templates",
    cta: "Browse templates",
    illustration: EntityIllustration,
  },
  {
    title: "Add records to it",
    what: "A record is one customer, one job, one booking — a single row under that shape.",
    detail:
      "Open the entity and use Add record. The form you get is generated from the fields you defined, so it always matches the entity, and required fields are enforced before anything is saved. This is where your actual data lives.",
    href: "/entities",
    cta: "Open an entity",
    illustration: RecordsIllustration,
  },
  {
    title: "Let other people fill it in",
    what: "A form is a public page that writes records into one of your entities.",
    detail:
      "Publish one and share the link: anyone can submit without an account, and each submission arrives as a record you can see and edit like any other. Nobody filling in a form can read what is already there.",
    detailExtra:
      "Pick the entity it writes into and tick the fields it should ask for — a form can only collect fields its entity already has. Public forms start as drafts and go live when you publish; there is also a kill switch that stops a live form instantly without giving up its address.",
    href: "/forms",
    cta: "Build a form",
    illustration: FormIllustration,
  },
  {
    title: "Watch it on a dashboard",
    what: "Dashboards read your records back out as widgets.",
    detail:
      "Add a Record List to see the latest rows, a KPI to watch a number against your plan's limit, a Calendar to plot a date field. Widgets are bound to an entity you have already made, which is why entities come first.",
    href: "/dashboards",
    cta: "Build a dashboard",
    illustration: DashboardIllustration,
  },
];

/**
 * Deliberately not merged into STEPS: these are not a fifth thing everyone
 * does, they are a branch most workspaces never take. Presenting them as
 * "step 5" would imply the core loop is incomplete without them. They get the
 * same cards and the same illustrations, though — the section is optional, not
 * secondary, and rendering it as bare prose read as an afterthought.
 */
const BOOKING_STEPS: Step[] = [
  {
    title: "Make the resource entity",
    what: "One entity for the things you rent out, with one record per thing.",
    illustration: ResourceIllustration,
    detail:
      "One record per thing that can be booked — ten boats means ten records. Give it a text field for its name and a number field for its price, in whole currency units, so 150 means 150.00. Call them whatever suits you: the booking form asks which field is which, so there are no special names to get right. A resource that leaves its price blank still books; it just prices at zero.",
    href: "/entities",
    cta: "Open Entities",
  },
  {
    title: "Make the request entity",
    what: "A second, separate entity for what the customer tells you.",
    illustration: RequestIllustration,
    detail:
      "This is the one people miss. It is a separate entity holding what the customer tells you — their name, email and phone, the start date, the end date. Each submission becomes one record here, and that record is the customer. You do not need a Customers entity, and linking one will not help: the booking path reads the submission itself.",
    href: "/entities",
    cta: "Open Entities",
  },
  {
    title: "Make each resource bookable",
    what: "Start bookings on each record so it has capacity that can run out.",
    illustration: CapacityIllustration,
    detail:
      "Open a resource record and start bookings on it. Until you do, it has no capacity: the request is still accepted and still raises an order, but nothing checks whether the boat is free, so ten people can take the same morning. Choose how it is counted — one specific thing, a quantity of interchangeable ones, or concurrent slots — and set a turnaround gap if you need one between bookings.",
    href: "/entities",
    cta: "Open a record",
  },
  {
    title: "Build the booking form",
    what: "One form on the request entity, showing the resources as a catalogue.",
    illustration: BookingFormIllustration,
    detail:
      "Create a form on the request entity, not the resource entity. Its catalogue lists the resource entity so the visitor picks which boat. Its booking settings are where every field is matched up: which of your date fields is the start and which is the end, and — on the resource — which field holds the price and which holds the name to print on the order. Publish it, and a submission writes the record, blocks the boat for that window and opens a draft order in one go.",
    href: "/forms",
    cta: "Build a form",
  },
];

/**
 * One step, as a card. Shared by the core loop and the booking branch so the
 * two cannot drift apart visually — the moment they do, one of them starts
 * looking like the real documentation and the other like a footnote.
 */
function StepCard({
  step,
  eyebrow,
  // The core steps sit directly under the page h1; the booking ones sit under
  // that section's own h2, so they are a level deeper.
  as: Heading = "h2",
}: {
  step: Step;
  eyebrow: string;
  as?: "h2" | "h3";
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex shrink-0 justify-center sm:w-56">
          <step.illustration />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-graft-green uppercase dark:text-graft-green-light">
            {eyebrow}
          </p>
          <Heading className="text-lg font-semibold tracking-tight">{step.title}</Heading>
          <p className="text-sm font-medium">{step.what}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
          {step.detailExtra ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{step.detailExtra}</p>
          ) : null}
          {step.note ? (
            <p className="mt-1 rounded-md border border-graft-warn/40 bg-graft-warn/5 px-3 py-2 text-xs text-muted-foreground">
              {step.note}
            </p>
          ) : null}
          {step.href && step.cta ? (
            <Button asChild size="sm" variant="outline" className="mt-1 self-start">
              <Link href={step.href}>
                {step.cta} <ArrowRightIcon />
              </Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function GuidePage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10">
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Getting started</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Graft has four moving parts, and they fit together in one direction: you define an{" "}
          <strong className="font-medium text-foreground">entity</strong>, records fill it,
          forms write records into it, and dashboards read them back. Everything else in the
          product hangs off that.
        </p>
        <div className="flex justify-center rounded-lg border bg-graft-green/[0.03] p-4">
          <FlowIllustration />
        </div>
        <p className="text-center text-xs text-muted-foreground">
          A form writes records · an entity holds them · a dashboard reads them
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Renting something out by the hour or the day — boats, rooms, equipment, a
          person&apos;s time? The four parts still apply, and there is one more shape to learn:{" "}
          <Link href="#taking-bookings" className="underline underline-offset-4">
            taking bookings
          </Link>{" "}
          needs two entities rather than one.
        </p>
      </header>

      <ol className="flex flex-col gap-5">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <StepCard step={step} eyebrow={`Step ${index + 1}`} />
          </li>
        ))}
      </ol>

      <section id="taking-bookings" className="flex scroll-mt-6 flex-col gap-4 border-t pt-6">
        <h2 className="text-lg font-semibold tracking-tight">Taking bookings</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Booking needs{" "}
          <strong className="font-medium text-foreground">two entities, not one</strong> — and
          that is the whole of what trips people up. Here is the shape before the steps.
        </p>

        <div className="flex flex-col items-center gap-2 rounded-lg border bg-graft-green/[0.03] p-4">
          <BookingFlowIllustration />
          <p className="text-center text-xs text-muted-foreground">
            Your boats live in one entity · the form picks one · the request lands in the other,
            and <strong className="font-medium text-foreground">that</strong> record is the
            customer
          </p>
        </div>

        <div className="rounded-lg border border-graft-green/30 bg-graft-green/[0.04] px-4 py-3">
          <p className="text-sm leading-relaxed">
            <strong className="font-medium">The thing being booked</strong> and{" "}
            <strong className="font-medium">the request to book it</strong> are separate shapes.
            A boat has a name and an hourly rate; a request has a customer, a start and an end.
            One entity cannot be both, because ten boats and forty requests are not the same
            list.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            There is no third entity for customers. The record a submission creates <em>is</em>{" "}
            the customer — it is where their name and email already are — and that is the record
            the resulting order points back at.
          </p>
        </div>

        <ol className="flex flex-col gap-5">
          {BOOKING_STEPS.map((step, index) => (
            <li key={step.title}>
              <StepCard step={step} eyebrow={`Booking step ${index + 1}`} as="h3" />
            </li>
          ))}
        </ol>

        <p className="rounded-md border border-graft-warn/40 bg-graft-warn/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Two things here cannot be changed afterwards. A field&apos;s key is permanent once
          saved — you can rename its label freely, but replacing the key means adding a new
          field. And how a resource is counted is fixed when you start bookings on it, because
          bookings already taken cannot be reinterpreted under a different counting rule;
          changing it means stopping bookings and starting again, which leaves past bookings
          readable but frees the resource.
        </p>
      </section>

      <section className="flex flex-col gap-3 border-t pt-6">
        <h2 className="text-lg font-semibold tracking-tight">Answers to the usual questions</h2>
        <dl className="flex flex-col gap-4 text-sm">
          <div>
            <dt className="font-medium">
              I made an entity and nothing happened. What did I actually do?
            </dt>
            <dd className="mt-1 text-muted-foreground">
              You defined a shape, not data. Open it from{" "}
              <Link href="/entities" className="underline underline-offset-4">
                Entities
              </Link>{" "}
              and add a record — that is the part you can see and search.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Can I change an entity after creating it?</dt>
            <dd className="mt-1 text-muted-foreground">
              Yes — rename it, add fields, change labels and required flags under{" "}
              <em>Fields &amp; settings</em> on the entity&apos;s page. A saved field&apos;s key
              is permanent, because your records are stored under it. Removing a field leaves
              data already stored under that key unreachable, and the editor warns you before
              you save.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Why is the Chart widget locked?</dt>
            <dd className="mt-1 text-muted-foreground">
              Charts read the reports API, which is a Premium feature. Everything else here
              works on the Free plan — see{" "}
              <Link href="/account" className="underline underline-offset-4">
                your plan
              </Link>{" "}
              for what your limits are.
            </dd>
          </div>
          <div>
            <dt className="font-medium">
              My booking form saved the request but nothing was reserved. Why?
            </dt>
            <dd className="mt-1 text-muted-foreground">
              The resource it picked has no capacity set — nobody started bookings on that
              record. The submission and its order are kept on purpose, because the customer did
              nothing wrong, but no slot was held and nothing stopped a second person taking the
              same one. Open the resource record and start bookings on it.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Why was a booking refused as unavailable?</dt>
            <dd className="mt-1 text-muted-foreground">
              Something already holds that resource for part of that window — a confirmed
              booking, a pending request, or the turnaround gap either side of one. Times are
              treated as up-to-but-not-including the end, so a 10:00–12:00 booking leaves 12:00
              free for the next one.
            </dd>
          </div>
          <div>
            <dt className="font-medium">How do I get my data out?</dt>
            <dd className="mt-1 text-muted-foreground">
              <Link href="/account/privacy" className="underline underline-offset-4">
                Privacy &amp; data
              </Link>{" "}
              exports your whole workspace — entities, records, dashboards and forms — as one
              JSON file, whenever you want it.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
