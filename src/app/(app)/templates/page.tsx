"use client";

/**
 * Business templates — a whole workspace in one go ("Graft Hotel", "Graft
 * Salon", …).
 *
 * The entity templates at `/entities/templates` answer "which fields does a
 * customer need?". These answer the question before it: "what does a hotel
 * need?" — the list of rooms, where reservations land, a public booking page
 * wired to both, and the deposit, payment and terms decisions — asked as a
 * handful of plain questions rather than as data modelling.
 *
 * Everything a template creates is ordinary afterwards: entities, records
 * and forms the owner edits like any other.
 */
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WORKSPACE_TEMPLATES } from "@/lib/workspace-templates";

export default function WorkspaceTemplatesPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your business</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Pick the kind of business closest to yours. We&apos;ll ask a few questions — can
          customers book online, do you take a deposit — and build everything: your list of what
          you offer, where requests land, and a public page customers use. You can change all of
          it afterwards.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {WORKSPACE_TEMPLATES.map((template) => (
          <Card key={template.id} className="flex flex-col">
            <CardHeader>
              <div className="flex items-start gap-3">
                <span className="text-3xl leading-none" aria-hidden="true">
                  {template.icon}
                </span>
                <div className="min-w-0">
                  <CardTitle className="text-base">{template.name}</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">{template.tagline}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="mt-auto flex flex-col gap-4">
              <ul className="flex flex-col gap-1.5">
                {template.highlights.map((highlight) => (
                  <li key={highlight} className="flex gap-2 text-sm">
                    <CheckIcon className="mt-0.5 size-4 shrink-0 text-graft-green dark:text-graft-green-light" />
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
              <Button asChild size="sm" className="self-start">
                <Link href={`/templates/${template.id}`}>
                  Set up {template.name.replace(/^Graft /, "")} <ArrowRightIcon />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="flex flex-wrap items-center gap-2 border-t pt-6 text-sm text-muted-foreground">
        <SparklesIcon className="size-4 shrink-0" />
        Not quite your business?{" "}
        <Link href="/setup" className="underline underline-offset-4 hover:text-foreground">
          Let us walk you through it step by step
        </Link>{" "}
        or{" "}
        <Link
          href="/entities/templates"
          className="underline underline-offset-4 hover:text-foreground"
        >
          start from a single list
        </Link>
        .
      </p>
    </div>
  );
}
