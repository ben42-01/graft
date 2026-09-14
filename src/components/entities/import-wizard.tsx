"use client";

/**
 * The record import wizard (GRAFT-25.2, docs/TIERS.md §2.3): pick a file, map
 * its columns, preview a real dry run, then commit.
 *
 * The dry run is why this is a wizard and not a file input. A tenant moving
 * 300 products in needs to see what will happen before it happens — an import
 * that quietly drops 40 rows is worse than one that refuses, because nobody
 * notices until a product is missing.
 *
 * Four things about its shape follow from the server rather than taste:
 *
 *   - **The gate is the server's.** Whether the file picker renders at all is
 *     `/me`'s resolved `features.csv_import` (tier plus any per-tenant
 *     override), and a `403 FEATURE_NOT_AVAILABLE` from any call flips the
 *     wizard to the same upgrade prompt. The client never works it out from
 *     the tier; a client that skipped this screen still gets the 403.
 *   - **The file goes to the bucket, never through the app.** Ticket, direct
 *     `PUT` without cookies, confirm — the two-call presigned upload
 *     (docs/BACKEND.md §4). Only the column names are read in the browser.
 *   - **The commit is the preview, replayed.** The body the dry run was sent
 *     with is kept and re-sent with `dryRun: false`, so the import cannot run
 *     with a mapping the preview did not show (AC6). Going back to the mapping
 *     throws the preview away.
 *   - **Nothing from a row reaches a log.** Rejections are rendered, never
 *     reported anywhere.
 *
 * Mounted only while open (the entity page renders it conditionally), so
 * every opening starts from step one with nothing left over.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FieldLike } from "@/lib/entities/record-values";
import {
  ImportMapping,
  detectColumns,
  formatOf,
  initialMapping,
  missingRequired,
  type ColumnMapping,
  type ImportFormat,
} from "./import-mapping";

/** Mirrors `ImportResult` in src/server/services/imports.ts. */
export type ImportResultView = {
  importId: string;
  dryRun: boolean;
  total: number;
  imported: number;
  rejected: { row: number; reason: string; field?: string }[];
  rejectedCount: number;
  quotaRefused: number;
  quota: { meter: string; remaining: number | null };
};

/** Mirrors `MAX_IMPORT_BYTES` in src/server/services/media.ts. Checked here
 * only to save a pointless upload; the bucket's size is the one enforced. */
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

type StartBody = {
  mediaId: string;
  format: ImportFormat;
  mapping: ColumnMapping;
  dedupeKey: string | null;
  dryRun: boolean;
};

type ChosenFile = { blob: File; format: ImportFormat; columns: string[] };

type Step =
  | { name: "file" }
  | { name: "map" }
  | { name: "preview"; result: ImportResultView }
  | { name: "done"; result: ImportResultView };

/** A failure, already in words a person can act on (AC9). */
export type Problem = { message: string; details?: string[]; code?: string };

type ErrorBody = { code?: string; message?: string; details?: unknown };

const STEP_TITLES = {
  file: "Step 1 of 4 · Choose a file",
  map: "Step 2 of 4 · Match columns to fields",
  preview: "Step 3 of 4 · Preview",
  done: "Step 4 of 4 · Done",
} as const;

const OFFLINE: Problem = {
  message: "We couldn't reach Graft. Check your connection and try again.",
};

const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

/** AC9 — every error code the import endpoints return, as itself. */
export function problemFor(error: ErrorBody | undefined, fallback: string): Problem {
  const details =
    typeof error?.details === "object" && error.details !== null
      ? (error.details as Record<string, unknown>)
      : {};

  switch (error?.code) {
    case "FEATURE_NOT_AVAILABLE":
      return {
        code: error.code,
        message: "Batch import isn't included in your plan. It's part of Premium.",
      };
    case "ROW_LIMIT_EXCEEDED": {
      const { rows, limit } = details;
      return {
        code: error.code,
        message:
          typeof rows === "number" && typeof limit === "number"
            ? `This file has ${count(rows, "row")}, and your plan imports up to ${limit.toLocaleString()} at a time. Split it into smaller files, or upgrade for unlimited imports.`
            : "This file has more rows than your plan imports at a time. Split it into smaller files, or upgrade for unlimited imports.",
      };
    }
    case "VALIDATION_FAILED": {
      const fields =
        typeof details.fields === "object" && details.fields !== null
          ? Object.values(details.fields).filter((v): v is string => typeof v === "string")
          : [];
      return {
        code: error.code,
        message:
          "This file or mapping can't be imported yet. Fix the following, then try again:",
        details: fields.length > 0 ? fields : [error.message ?? "The request was not valid."],
      };
    }
    case "QUOTA_EXCEEDED":
      return {
        code: error.code,
        message:
          error.message ?? "Your plan's record limit has been reached. Upgrade to add more.",
      };
    case "PAYLOAD_TOO_LARGE":
      return {
        code: error.code,
        message: "That file is larger than 25 MB. Split it into smaller files.",
      };
    case "RATE_LIMITED":
      return {
        code: error.code,
        message: "That was a lot of requests at once. Wait a minute, then try again.",
      };
    default:
      return { code: error?.code, message: error?.message ?? fallback };
  }
}

async function problemFrom(response: Response, fallback: string): Promise<Problem> {
  const body = (await response.json().catch(() => null)) as { error?: ErrorBody } | null;
  return problemFor(body?.error, fallback);
}

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function ImportWizard({
  open,
  onOpenChange,
  entityId,
  entityName,
  fields,
  features,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityName: string;
  fields: FieldLike[];
  /** `/me`'s resolved `tenant.features`, or `null` while it is still loading. */
  features: Record<string, boolean> | null;
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>({ name: "file" });
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dedupeKey, setDedupeKey] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<StartBody | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  // AC8 — `busy` disables the button, but only after React re-renders; a
  // second click can land before that. The ref closes that gap synchronously.
  const inFlight = useRef(false);

  const allowed = features?.csv_import === true && !refused;

  function fail(next: Problem) {
    if (next.code === "FEATURE_NOT_AVAILABLE") setRefused(true);
    setProblem(next);
  }

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await task();
    } catch {
      setProblem(OFFLINE);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function chooseFile(chosen: File | undefined) {
    setProblem(null);
    setFile(null);
    setMediaId(null);
    if (!chosen) return;
    const format = formatOf(chosen);
    if (!format) return setProblem({ message: "Choose a .csv or .json file." });
    if (chosen.size > MAX_IMPORT_BYTES) {
      return setProblem({
        message: "That file is larger than 25 MB. Split it into smaller files.",
      });
    }
    let text: string;
    try {
      text = await readText(chosen);
    } catch {
      return setProblem({ message: "We couldn't read that file. Try choosing it again." });
    }
    const detected = detectColumns(text, format);
    if ("error" in detected) return setProblem({ message: detected.error });
    setFile({ blob: chosen, format, columns: detected.columns });
    setMapping(initialMapping(detected.columns, fields));
    setDedupeKey(null);
  }

  function upload() {
    if (!file) return;
    if (mediaId) return setStep({ name: "map" });
    return run(async () => {
      const base = `/api/v1/entities/${entityId}/import-uploads`;
      const contentType = file.format === "csv" ? "text/csv" : "application/json";
      const ticketResponse = await fetch(base, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, sizeBytes: file.blob.size }),
      });
      if (!ticketResponse.ok) {
        return fail(
          await problemFrom(ticketResponse, "We couldn't start the upload. Try again."),
        );
      }
      const ticket = (
        (await ticketResponse.json()) as {
          data: { mediaId: string; uploadUrl: string; contentType: string };
        }
      ).data;

      // Straight to the bucket, without the app's cookies: the signature is
      // the only credential this request needs, and the bucket is not us.
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        credentials: "omit",
        headers: { "Content-Type": ticket.contentType },
        body: file.blob,
      });
      if (!put.ok) return fail({ message: "The file didn't finish uploading. Try again." });

      const confirm = await fetch(`${base}/${ticket.mediaId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!confirm.ok) {
        return fail(await problemFrom(confirm, "We couldn't confirm the upload. Try again."));
      }
      setMediaId(ticket.mediaId);
      setStep({ name: "map" });
    });
  }

  async function send(body: StartBody): Promise<ImportResultView | null> {
    const response = await fetch(`/api/v1/entities/${entityId}/imports`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      fail(
        await problemFrom(
          response,
          body.dryRun
            ? "We couldn't preview this import. Try again."
            : "We couldn't run this import. Try again.",
        ),
      );
      return null;
    }
    return ((await response.json()) as { data: ImportResultView }).data;
  }

  function preview() {
    if (!file || !mediaId) return;
    const used = new Set(Object.values(mapping));
    const body: StartBody = {
      mediaId,
      format: file.format,
      mapping,
      dedupeKey: dedupeKey !== null && used.has(dedupeKey) ? dedupeKey : null,
      dryRun: true,
    };
    return run(async () => {
      const result = await send(body);
      if (!result) return;
      setPreviewed(body);
      setStep({ name: "preview", result });
    });
  }

  function commit() {
    if (!previewed) return;
    return run(async () => {
      const result = await send({ ...previewed, dryRun: false });
      if (!result) return;
      setStep({ name: "done", result });
      onImported();
    });
  }

  function backToMapping() {
    setPreviewed(null);
    setProblem(null);
    setStep({ name: "map" });
  }

  const missing = missingRequired(mapping, fields);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {entityName}</DialogTitle>
          <DialogDescription>
            {allowed ? STEP_TITLES[step.name] : "Bring in many records at once"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-1">
          {features === null ? (
            <p className="text-sm text-muted-foreground">Checking your plan…</p>
          ) : !allowed ? (
            <UpgradePrompt />
          ) : step.name === "file" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="import-file" className="text-xs">
                File to import
              </Label>
              <Input
                id="import-file"
                type="file"
                accept=".csv,.json,text/csv,application/json"
                disabled={busy}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <p className="text-xs text-muted-foreground">
                A CSV with a header row, or a JSON list of records. Up to 25 MB.
              </p>
              {file ? (
                <p className="text-sm">
                  {file.blob.name} · {count(file.columns.length, "column")} found
                </p>
              ) : null}
            </div>
          ) : step.name === "map" && file ? (
            <ImportMapping
              columns={file.columns}
              fields={fields}
              mapping={mapping}
              onChange={setMapping}
              dedupeKey={dedupeKey}
              onDedupeKeyChange={setDedupeKey}
            />
          ) : step.name === "preview" ? (
            <PreviewSummary result={step.result} />
          ) : step.name === "done" ? (
            <DoneSummary result={step.result} />
          ) : null}

          {problem && allowed ? <ProblemNotice problem={problem} /> : null}
          {problem && !allowed && refused ? (
            <p className="text-xs text-muted-foreground">{problem.message}</p>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          {allowed && (step.name === "map" || step.name === "preview") ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                step.name === "map" ? setStep({ name: "file" }) : backToMapping()
              }
            >
              {step.name === "map" ? "Back" : "Back to mapping"}
            </Button>
          ) : (
            <span />
          )}

          {!allowed || step.name === "done" ? (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : step.name === "file" ? (
            <Button type="button" disabled={!file || busy} onClick={() => void upload()}>
              {busy ? "Uploading…" : "Next"}
            </Button>
          ) : step.name === "map" ? (
            <Button
              type="button"
              disabled={missing.length > 0 || busy}
              onClick={() => void preview()}
            >
              {busy ? "Checking every row…" : "Preview import"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy || step.result.imported === 0}
              onClick={() => void commit()}
            >
              {busy ? "Importing…" : `Import ${count(step.result.imported, "row")}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** docs/TIERS.md §5, moment 2 — the gated action explains itself, with the
 * tier comparison, instead of a disabled button with no reason. */
function UpgradePrompt() {
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <LockIcon className="size-4" aria-hidden="true" />
        Batch import is a Premium feature
      </p>
      <p className="text-sm text-muted-foreground">
        Bring in hundreds of records from a spreadsheet at once: match the columns, preview
        exactly what will be added, then import.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm">
        <dt className="font-medium">Free</dt>
        <dd className="text-muted-foreground">Add records one at a time</dd>
        <dt className="font-medium">Premium</dt>
        <dd>Up to 10,000 rows per import</dd>
        <dt className="font-medium">Enterprise</dt>
        <dd>Unlimited rows per import</dd>
      </dl>
      <Button asChild className="self-start">
        <Link href="/account">View plans</Link>
      </Button>
    </div>
  );
}

function ProblemNotice({ problem }: { problem: Problem }) {
  const upgrade = problem.code === "ROW_LIMIT_EXCEEDED" || problem.code === "QUOTA_EXCEEDED";
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
    >
      <p>{problem.message}</p>
      {problem.details ? (
        <ul className="list-disc pl-5">
          {problem.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {upgrade ? (
        <Link href="/account" className="font-medium underline underline-offset-4">
          View plans
        </Link>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function RejectedRows({ result }: { result: ImportResultView }) {
  if (result.rejectedCount === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Rows that won&apos;t be imported</p>
      <div className="max-h-56 overflow-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Row</th>
              <th className="px-3 py-1.5 font-medium">Field</th>
              <th className="px-3 py-1.5 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {result.rejected.map((row, index) => (
              <tr key={`${row.row}-${index}`} className="border-t">
                <td className="px-3 py-1.5 tabular-nums">{row.row}</td>
                <td className="px-3 py-1.5">{row.field ?? "—"}</td>
                <td className="px-3 py-1.5">{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.rejected.length < result.rejectedCount ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {result.rejected.length.toLocaleString()} of{" "}
          {result.rejectedCount.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}

function PreviewSummary({ result }: { result: ImportResultView }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
        Nothing has been saved yet. This preview shows what importing would do.
      </p>
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Rows in file" value={result.total.toLocaleString()} />
        <Stat label="Will be imported" value={result.imported.toLocaleString()} />
        <Stat label="Won't be imported" value={result.rejectedCount.toLocaleString()} />
      </dl>
      {result.imported === 0 ? (
        <p className="text-sm text-destructive">
          No rows would be imported. Go back to the mapping, or fix the file and start again.
        </p>
      ) : null}
      <RejectedRows result={result} />
    </div>
  );
}

function DoneSummary({ result }: { result: ImportResultView }) {
  const partial = result.quotaRefused > 0;
  return (
    <div className="flex flex-col gap-3">
      {partial ? (
        // AC7 — a partial import must never read as a clean success.
        <div role="status" className="rounded-md border border-graft-warn px-3 py-2 text-sm">
          <p className="font-medium">Only part of the file was imported.</p>
          <p>
            {count(result.imported, "row")} imported. {count(result.quotaRefused, "valid row")}{" "}
            could not be added because your plan&apos;s record limit was reached.
          </p>
          <Link href="/account" className="font-medium underline underline-offset-4">
            Upgrade to import the rest
          </Link>
        </div>
      ) : (
        <p role="status" className="text-sm font-medium">
          Import finished.
        </p>
      )}
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Imported" value={result.imported.toLocaleString()} />
        <Stat label="Not imported" value={result.rejectedCount.toLocaleString()} />
        <Stat
          label="Records you can still add"
          value={
            result.quota.remaining === null
              ? "Unlimited"
              : result.quota.remaining.toLocaleString()
          }
        />
      </dl>
      <RejectedRows result={result} />
    </div>
  );
}
