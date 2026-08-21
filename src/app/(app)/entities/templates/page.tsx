"use client";

/**
 * Entity templates — ready-made shapes to start from (2026-08-21).
 *
 * A blank "New entity" form asks a question most people can't answer on
 * their first day: which fields does a customer need? These are fifteen
 * answers, grouped by what part of a business they belong to. Picking one
 * opens the ordinary create dialog pre-filled, so a template is a starting
 * point and never a commitment — rename it, drop fields, add your own, and
 * what gets created is yours.
 *
 * The library itself is JSON (@/lib/entity-templates), validated in the test
 * run against the same schema the API applies.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NewEntityDialog } from "@/components/entities/new-entity-dialog";
import { templatesByCategory, type EntityTemplate } from "@/lib/entity-templates";

/** Field types, as a word that means something to a non-technical reader. */
const TYPE_HINT: Record<string, string> = {
  text: "text",
  number: "number",
  date: "date",
  select: "choice",
  checkbox: "yes/no",
  email: "email",
  phone: "phone",
};

export default function EntityTemplatesPage() {
  const router = useRouter();
  const [chosen, setChosen] = useState<EntityTemplate | null>(null);
  const groups = templatesByCategory();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <Link
          href="/entities"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; Entities
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Entity templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from a shape that already fits, then change anything you like before it is
          created. Nothing here is locked in.
        </p>
      </div>

      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.category}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.templates.map((template) => (
              <Card key={template.id} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="text-base">{template.name}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
                </CardHeader>
                <CardContent className="mt-auto flex flex-col gap-3">
                  <ul className="flex flex-wrap gap-1.5">
                    {template.entity.fields.map((field) => (
                      <li
                        key={field.key}
                        className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                        title={`${TYPE_HINT[field.type] ?? field.type}${field.required ? ", required" : ""}`}
                      >
                        {field.label}
                        {field.required ? (
                          <span className="text-graft-green dark:text-graft-green-light">
                            *
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => setChosen(template)}
                  >
                    Use this template <ArrowRightIcon />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      <p className="flex items-center gap-2 border-t pt-6 text-sm text-muted-foreground">
        <SparklesIcon className="size-4 shrink-0" />
        Nothing here fits?{" "}
        <Link href="/entities" className="underline underline-offset-4 hover:text-foreground">
          Build one from scratch
        </Link>{" "}
        — a template is only a head start.
      </p>

      <NewEntityDialog
        open={chosen !== null}
        onOpenChange={(open) => {
          if (!open) setChosen(null);
        }}
        template={chosen}
        onCreated={(entity) => router.push(`/entities/${entity.id}`)}
      />
    </div>
  );
}
