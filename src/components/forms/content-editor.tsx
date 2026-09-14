"use client";

/**
 * Notes and links for customers — what a business wants read before a form is
 * sent: a cancellation policy, a link to the terms, the website
 * (src/lib/content-blocks.ts).
 *
 * Each block is placed after one of the form's fields, or at the top, so a
 * policy can sit beside the date it is about. A link can require the customer
 * to tick "I agree"; the public form will not send until they do, and what
 * they agreed to is kept with their submission.
 *
 * The URL rule is the shared `isSafeLinkUrl`, applied here so a paste the
 * server would refuse is refused visibly beside the input.
 */
import { useEffect, useState } from "react";
import { LinkIcon, MessageSquareTextIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_BLOCK_TITLE,
  MAX_CONTENT_BLOCKS,
  MAX_NOTICE_BODY,
  isSafeLinkUrl,
  type ContentBlock,
} from "@/lib/content-blocks";
import type { FieldLike } from "@/lib/entities/record-values";

const CONTROL_CLASS =
  "w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none";

/** Lowercase letters and digits — the server's block id alphabet. */
const newId = () =>
  Math.random()
    .toString(36)
    .replace(/[^a-z0-9]/g, "")
    .slice(2, 12) || "block";

export function blockProblem(block: ContentBlock): string | null {
  if (block.kind === "notice") {
    return block.body.trim() ? null : "Write the message customers should read.";
  }
  if (!block.label.trim()) return "Give the link a label, like “Terms of hire”.";
  return isSafeLinkUrl(block.url.trim())
    ? null
    : "Use a full web address, starting with https://";
}

export function ContentEditor({
  content,
  fields,
  busy,
  onSave,
}: {
  content: ContentBlock[];
  fields: FieldLike[];
  busy: boolean;
  onSave: (next: ContentBlock[]) => void;
}) {
  const [blocks, setBlocks] = useState<ContentBlock[]>(content);

  // Re-seed when the server's answer arrives or changes under us.
  useEffect(() => {
    setBlocks(content);
  }, [content]);

  const update = (id: string, patch: Partial<ContentBlock>) =>
    setBlocks((prev) =>
      prev.map((block) => (block.id === id ? ({ ...block, ...patch } as ContentBlock) : block)),
    );

  const add = (kind: ContentBlock["kind"]) =>
    setBlocks((prev) => [
      ...prev,
      kind === "notice"
        ? { id: newId(), kind, title: "", body: "", after: null }
        : // A terms link most often belongs just above the submit button.
          {
            id: newId(),
            kind,
            label: "",
            url: "",
            requireAgreement: false,
            after: fields.at(-1)?.key ?? null,
          },
    ]);

  const problems = blocks.map(blockProblem);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareTextIcon className="size-4" aria-hidden="true" /> Notes &amp; links for
          customers
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Things customers should read before they send this form, like a cancellation policy,
          and links to your terms or website.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes or links on this form yet.</p>
        ) : null}

        {blocks.map((block, index) => {
          const name = `${block.kind === "notice" ? "message" : "link"} ${index + 1}`;
          return (
            <fieldset key={block.id} className="flex flex-col gap-3 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium capitalize">{name}</legend>

              {block.kind === "notice" ? (
                <>
                  <div>
                    <Label htmlFor={`${block.id}-title`} className="mb-1 block text-xs">
                      Heading (optional)
                    </Label>
                    <Input
                      id={`${block.id}-title`}
                      value={block.title}
                      maxLength={MAX_BLOCK_TITLE}
                      disabled={busy}
                      placeholder="Cancellation policy"
                      onChange={(event) => update(block.id, { title: event.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`${block.id}-body`} className="mb-1 block text-xs">
                      Message
                    </Label>
                    <textarea
                      id={`${block.id}-body`}
                      rows={3}
                      value={block.body}
                      maxLength={MAX_NOTICE_BODY}
                      disabled={busy}
                      className={CONTROL_CLASS}
                      onChange={(event) => update(block.id, { body: event.target.value })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <Label htmlFor={`${block.id}-label`} className="mb-1 block text-xs">
                      Link text
                    </Label>
                    <Input
                      id={`${block.id}-label`}
                      value={block.label}
                      maxLength={MAX_BLOCK_TITLE}
                      disabled={busy}
                      placeholder="Terms of hire"
                      onChange={(event) => update(block.id, { label: event.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`${block.id}-url`} className="mb-1 block text-xs">
                      Web address
                    </Label>
                    <Input
                      id={`${block.id}-url`}
                      inputMode="url"
                      value={block.url}
                      disabled={busy}
                      placeholder="https://"
                      onChange={(event) => update(block.id, { url: event.target.value })}
                    />
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={block.requireAgreement}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        update(block.id, { requireAgreement: checked === true })
                      }
                    />
                    <span>
                      Customer must tick “I agree” to send the form
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        For terms or a cancellation policy. What they agreed to is saved with
                        their submission.
                      </span>
                    </span>
                  </label>
                </>
              )}

              <div className="flex flex-wrap items-end justify-between gap-2">
                <label className="flex min-w-48 flex-col gap-1 text-xs">
                  <span className="font-medium">Show it</span>
                  <select
                    aria-label={`Where to show ${name}`}
                    value={block.after ?? ""}
                    disabled={busy}
                    className={CONTROL_CLASS}
                    onChange={(event) =>
                      update(block.id, { after: event.target.value || null })
                    }
                  >
                    <option value="">At the top of the form</option>
                    {fields.map((field) => (
                      <option key={field.key} value={field.key}>
                        After “{field.label}”
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${name}`}
                  onClick={() => setBlocks((prev) => prev.filter((b) => b.id !== block.id))}
                >
                  <Trash2Icon /> Remove
                </Button>
              </div>

              {problems[index] ? (
                <p role="alert" className="text-xs text-destructive">
                  {problems[index]}
                </p>
              ) : null}
            </fieldset>
          );
        })}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || blocks.length >= MAX_CONTENT_BLOCKS}
            onClick={() => add("notice")}
          >
            <MessageSquareTextIcon /> Add a message
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || blocks.length >= MAX_CONTENT_BLOCKS}
            onClick={() => add("link")}
          >
            <LinkIcon /> Add a link
          </Button>
        </div>

        <div>
          <Button
            type="button"
            size="sm"
            disabled={busy || problems.some(Boolean)}
            onClick={() =>
              onSave(
                blocks.map((block) =>
                  block.kind === "notice"
                    ? { ...block, title: block.title.trim(), body: block.body.trim() }
                    : { ...block, label: block.label.trim(), url: block.url.trim() },
                ),
              )
            }
          >
            {busy ? "Saving…" : "Save notes & links"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
