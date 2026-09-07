"use client";

/**
 * Privacy & data — the in-app half of the privacy statement, plus the two
 * things a reader actually wants to *do* with it (2026-08-21 UI refinement):
 * keep a copy of the version they agreed to, and take their data with them.
 *
 * Both downloads are built in the browser from what the page can already
 * read — the statement is imported data, the export walks the tenant-scoped
 * API (see @/lib/account-export for why that is not a new endpoint) — so
 * neither adds a server surface that hands out bulk data.
 */
import { useState } from "react";
import Link from "next/link";
import { DownloadIcon, FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PrivacyMeta, PrivacyStatement } from "@/components/legal/privacy-statement";
import { buildWorkspaceExport } from "@/lib/account-export";
import { downloadTextFile } from "@/lib/download";
import { PRIVACY_CONTACT_EMAIL, VERSION, privacyMarkdown } from "@/lib/legal/privacy";
import { useMe } from "@/lib/session";

/** A filename-safe stem, so an export lands as `graft-acme-2026-08-21.json`. */
function fileStem(workspaceSlug: string | undefined): string {
  const date = new Date().toISOString().slice(0, 10);
  return `graft-${workspaceSlug ?? "workspace"}-${date}`;
}

export default function PrivacyPage() {
  const { me } = useMe();
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  function downloadStatement() {
    downloadTextFile(
      `graft-privacy-statement-v${VERSION}.md`,
      "text/markdown",
      privacyMarkdown(),
    );
  }

  async function downloadData() {
    setExporting(true);
    setExportError(null);
    try {
      const data = await buildWorkspaceExport(setProgress);
      downloadTextFile(
        `${fileStem(me?.tenant.slug)}.json`,
        "application/json",
        JSON.stringify(data, null, 2),
      );
      setProgress(
        data.truncated.length > 0
          ? "Exported. Some collections were too large to include in full — the file lists which."
          : "Exported.",
      );
    } catch {
      setExportError("We couldn't build your export. Please try again.");
      setProgress(null);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy &amp; data</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What Graft does with your data, and how to take a copy of it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your copies</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-56 flex-1">
              <p className="text-sm font-medium">Privacy statement</p>
              <p className="text-sm text-muted-foreground">
                Version {VERSION}, as a Markdown file you can keep.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={downloadStatement}>
              <FileTextIcon /> Download statement
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="min-w-56 flex-1">
              <p className="text-sm font-medium">Your workspace data</p>
              <p className="text-sm text-muted-foreground">
                Your account, entities, records, dashboards and forms as one JSON file. Large
                workspaces take a moment — it is read page by page.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={exporting}
              onClick={() => void downloadData()}
            >
              <DownloadIcon /> {exporting ? "Preparing…" : "Download my data"}
            </Button>
          </div>

          {progress ? (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {progress}
            </p>
          ) : null}
          {exportError ? (
            <p role="alert" className="text-sm text-destructive">
              {exportError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deleting your account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Self-service deletion isn&apos;t built yet. Email{" "}
            <a
              href={`mailto:${PRIVACY_CONTACT_EMAIL}?subject=Delete my Graft account`}
              className="font-medium underline underline-offset-4 hover:text-foreground"
            >
              {PRIVACY_CONTACT_EMAIL}
            </a>{" "}
            and we will delete your account and workspace data, keeping only the billing records
            the law requires. Export your data first — deletion is not reversible.
          </p>
        </CardContent>
      </Card>

      <div className="border-t pt-6">
        <PrivacyMeta />
        <div className="mt-4">
          <PrivacyStatement />
        </div>
        <p className="mt-8 text-xs text-muted-foreground">
          This statement is also{" "}
          <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
            published publicly
          </Link>{" "}
          for people who reach Graft through one of your forms.
        </p>
      </div>
    </div>
  );
}
