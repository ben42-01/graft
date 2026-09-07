/**
 * The public privacy statement (2026-08-21 UI refinement).
 *
 * It exists for the people who never see the app: anyone who fills in a
 * customer's public Graft form (`/f/:tenantSlug/:formSlug`) hands over data
 * to a system they have no account on, and a privacy statement they cannot
 * reach is not one. Linked from the landing footer and the public form
 * badge; the in-app copy at `/account/privacy` renders the same source.
 *
 * A server component — static text, no session, so it is prerenderable.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { GraftLockup } from "@/components/brand/graft-logo";
import { PrivacyMeta, PrivacyStatement } from "@/components/legal/privacy-statement";

export const metadata: Metadata = {
  title: "Privacy — Graft",
  description: "What personal data Graft handles, why, and what you can do about it.",
};

export default function PublicPrivacyPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-4">
        <Link href="/" aria-label="Graft home" className="self-start">
          <GraftLockup className="h-7" />
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Privacy statement</h1>
        <PrivacyMeta />
      </header>

      <PrivacyStatement />

      <footer className="border-t pt-6">
        <Link
          href="/"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          &larr; Back to home
        </Link>
      </footer>
    </div>
  );
}
