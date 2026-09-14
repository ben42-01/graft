/**
 * Notes and links a business leaves for its customers on a public form — a
 * cancellation policy to read, a link to the terms, a website.
 *
 * Neither is a field. Nothing a customer types lands in them, so they are not
 * entity fields and never reach a record's `data`: they are stored on the form
 * (`FormDoc.content`) and rendered between its fields.
 *
 * Three rules live here, so the server's schema, the builder and the public
 * page cannot disagree about them:
 *
 *   - **A link is a web address and nothing else.** `http:` or `https:` only,
 *     with no credentials in it. `javascript:` and `data:` URLs are how a link
 *     on a page someone else controls becomes a script, and this page is shown
 *     to anonymous visitors.
 *   - **A notice is plain text.** It is rendered as text, never as HTML or
 *     markdown, so a tenant cannot put markup on a public page by accident or
 *     on purpose.
 *   - **A block is placed after a field, or at the top.** A block whose field
 *     has since left the form is shown at the end rather than dropped: losing
 *     a cancellation policy silently is worse than showing it lower down.
 *
 * Pure data and pure functions, no `"use client"` — safe on either side.
 */

export const MAX_CONTENT_BLOCKS = 20;
export const MAX_BLOCK_TITLE = 120;
export const MAX_NOTICE_BODY = 2_000;
export const MAX_LINK_URL = 2_048;

export type NoticeBlock = {
  id: string;
  kind: "notice";
  /** Optional heading; `""` when there is none. */
  title: string;
  body: string;
  /** The field this block follows, or `null` for the top of the form. */
  after: string | null;
};

export type LinkBlock = {
  id: string;
  kind: "link";
  label: string;
  url: string;
  /** The customer must tick "I agree" before the form will send. */
  requireAgreement: boolean;
  after: string | null;
};

export type ContentBlock = NoticeBlock | LinkBlock;

export function isSafeLinkUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_LINK_URL) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    // A bare "localhost" or an intranet name is not a link a customer can open.
    url.hostname.includes(".")
  );
}

export type FormItem<F> = { kind: "field"; field: F } | { kind: "block"; block: ContentBlock };

/** The form in the order a customer reads it: top blocks, then each field
 * followed by its blocks, then any block whose field is no longer on the form. */
export function placeContent<F extends { key: string }>(
  fields: readonly F[],
  content: readonly ContentBlock[],
): FormItem<F>[] {
  const keys = new Set(fields.map((field) => field.key));
  const items: FormItem<F>[] = content
    .filter((block) => block.after === null)
    .map((block) => ({ kind: "block", block }));
  for (const field of fields) {
    items.push({ kind: "field", field });
    for (const block of content) {
      if (block.after === field.key) items.push({ kind: "block", block });
    }
  }
  for (const block of content) {
    if (block.after !== null && !keys.has(block.after)) items.push({ kind: "block", block });
  }
  return items;
}
