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
 * A server component — static explanation, no session needed.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DashboardIllustration,
  EntityIllustration,
  FlowIllustration,
  FormIllustration,
  RecordsIllustration,
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
      </header>

      <ol className="flex flex-col gap-5">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <Card>
              <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
                <div className="flex shrink-0 justify-center sm:w-56">
                  <step.illustration />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="text-xs font-medium tracking-wide text-graft-green uppercase dark:text-graft-green-light">
                    Step {index + 1}
                  </p>
                  <h2 className="text-lg font-semibold tracking-tight">{step.title}</h2>
                  <p className="text-sm font-medium">{step.what}</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
                  {step.detailExtra ? (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {step.detailExtra}
                    </p>
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
          </li>
        ))}
      </ol>

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
