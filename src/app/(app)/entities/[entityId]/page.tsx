"use client";

/**
 * One entity: its records, and its schema (2026-08-21 UI refinement).
 *
 * This is the screen the product was missing. An entity existed only as a
 * row in a picker — there was no way to add a record to it, change a field,
 * rename it or delete it, even though every one of those endpoints has
 * existed since GRAFT-06/07. Records come first on the page because that is
 * what an entity is *for*; the schema editor sits below, collapsed by
 * default, because changing a schema is the rarer and more dangerous act.
 *
 * Two server behaviours the UI has to be honest about:
 *   - Removing a field does not delete its stored data immediately: records
 *     migrate lazily and drop unknown keys on their next write
 *     (src/server/services/records.ts). The editor names the keys a save
 *     would orphan rather than letting them vanish quietly.
 *   - Deleting an entity is a soft delete that also unpublishes any form
 *     bound to it (GRAFT-06 AC7). The confirmation says so.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  CalendarCheckIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { FieldRowsEditor } from "@/components/entities/field-rows-editor";
import { RecordDialog, type RecordRow } from "@/components/entities/record-dialog";
import { BookableDialog, type PoolView } from "@/components/entities/bookable-dialog";
import {
  draftFieldsFrom,
  removedKeys,
  toFieldPayload,
  validateFields,
  type DraftField,
} from "@/lib/entities/draft-fields";
import { formatCell, isImageField, type FieldLike } from "@/lib/entities/record-values";
import { recordImageUrl } from "@/components/entities/image-field";

type EntityView = {
  id: string;
  key: string;
  name: string;
  fields: FieldLike[];
  schemaVersion: number;
};

type PageMeta = { limit: number; hasMore: boolean; cursor: string | null };

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; entity: EntityView };

const PAGE_SIZE = 25;

export default function EntityPage() {
  const params = useParams<{ entityId: string }>();
  const router = useRouter();
  const entityId = params.entityId;

  const [state, setState] = useState<State>({ status: "loading" });
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingRows, setLoadingRows] = useState(true);
  const [recordDialog, setRecordDialog] = useState<{
    open: boolean;
    editing: RecordRow | null;
  }>({
    open: false,
    editing: null,
  });

  /**
   * The pools of this entity, by record id. Loaded once for the page rather
   * than per row: pools cluster onto very few entity types (a rental business
   * has "Rental Items", not one entity per boat), so this is a single request
   * however many records are on screen.
   */
  const [pools, setPools] = useState<Map<string, PoolView>>(new Map());
  const [bookableFor, setBookableFor] = useState<RecordRow | null>(null);

  const [schemaOpen, setSchemaOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftFields, setDraftFields] = useState<DraftField[]>([]);
  const [savingSchema, setSavingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaSaved, setSchemaSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const loadEntity = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/entities/${entityId}`, { credentials: "include" });
      if (!response.ok) {
        setState({ status: "error" });
        return;
      }
      const body = (await response.json()) as { data: EntityView };
      setState({ status: "ready", entity: body.data });
      setDraftName(body.data.name);
      setDraftFields(draftFieldsFrom(body.data.fields));
    } catch {
      setState({ status: "error" });
    }
  }, [entityId]);

  const loadRecords = useCallback(
    async (nextCursor: string | null) => {
      setLoadingRows(true);
      try {
        const query = `limit=${PAGE_SIZE}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`;
        const response = await fetch(`/api/v1/entities/${entityId}/records?${query}`, {
          credentials: "include",
        });
        if (!response.ok) return;
        const body = (await response.json()) as { data: RecordRow[]; meta?: PageMeta };
        setRows((prev) => (nextCursor ? [...prev, ...body.data] : body.data));
        setCursor(body.meta?.hasMore ? body.meta.cursor : null);
      } finally {
        setLoadingRows(false);
      }
    },
    [entityId],
  );

  const loadPools = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/inventory/pools?entityId=${entityId}&limit=100`, {
        credentials: "include",
      });
      // A failure here costs the bookable column, not the page: records are
      // what this screen is for, and they loaded.
      if (!response.ok) return;
      const body = (await response.json()) as { data: PoolView[] };
      setPools(new Map(body.data.map((pool) => [pool.recordId, pool])));
    } catch {
      // Same reasoning.
    }
  }, [entityId]);

  useEffect(() => {
    void loadEntity();
    void loadRecords(null);
    void loadPools();
  }, [loadEntity, loadRecords, loadPools]);

  async function deleteRecord(recordId: string) {
    const response = await fetch(`/api/v1/entities/${entityId}/records/${recordId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (response.ok) setRows((prev) => prev.filter((row) => row.id !== recordId));
  }

  async function saveSchema() {
    if (state.status !== "ready") return;
    const fieldError = validateFields(draftFields);
    if (!draftName.trim()) {
      setSchemaError("Give this entity a name.");
      return;
    }
    if (fieldError) {
      setSchemaError(fieldError);
      return;
    }

    setSavingSchema(true);
    setSchemaError(null);
    setSchemaSaved(false);
    try {
      const response = await fetch(`/api/v1/entities/${entityId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draftName.trim(), fields: toFieldPayload(draftFields) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error: { message: string };
        } | null;
        setSchemaError(body?.error.message ?? "We couldn't save these changes.");
        return;
      }
      setSchemaSaved(true);
      await loadEntity();
      await loadRecords(null);
    } catch {
      setSchemaError("Network error. Try again.");
    } finally {
      setSavingSchema(false);
    }
  }

  async function deleteEntity() {
    setDeleting(true);
    try {
      const response = await fetch(`/api/v1/entities/${entityId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (response.ok) {
        router.push("/entities");
        return;
      }
      setSchemaError("We couldn't delete this entity.");
    } finally {
      setDeleting(false);
    }
  }

  if (state.status === "loading") return <LoadingState label="Loading entity…" />;
  if (state.status === "error") {
    return <ErrorState description="We couldn't load this entity." />;
  }

  const { entity } = state;
  const orphaned = removedKeys(entity.fields, draftFields);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <Link
          href="/entities"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          &larr; Entities
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{entity.name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {entity.key} · {entity.fields.length}{" "}
              {entity.fields.length === 1 ? "field" : "fields"} · schema v{entity.schemaVersion}
            </p>
          </div>
          <div className="flex gap-2">
            {/* Collecting records from other people is the other half of what
             * an entity is for, and `/forms?entity=` opens the create dialog
             * already pointed at this one. */}
            <Button asChild variant="outline" size="sm">
              <Link href={`/forms?entity=${entityId}`}>
                <FileTextIcon /> Collect with a form
              </Link>
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setRecordDialog({ open: true, editing: null })}
            >
              <PlusIcon /> Add record
            </Button>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Records</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingRows && rows.length === 0 ? <LoadingState label="Loading records…" /> : null}

          {!loadingRows && rows.length === 0 ? (
            <EmptyState
              title="No records yet"
              description="Add your first record and it will show up here, and in any dashboard widget or form bound to this entity."
            />
          ) : null}

          {rows.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {entity.fields.map((field) => (
                      <TableHead key={field.key}>{field.label}</TableHead>
                    ))}
                    <TableHead className="w-28">Bookable</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      {entity.fields.map((field) => (
                        <TableCell key={field.key}>
                          {/* A picture is the one value worth showing as
                           * itself: "Image" in a cell tells the reader
                           * nothing they could not infer from the column. */}
                          {isImageField(field) ? (
                            <RecordThumbnail
                              mediaId={row.data[field.key]}
                              label={field.label}
                            />
                          ) : (
                            formatCell(row.data[field.key], field)
                          )}
                        </TableCell>
                      ))}
                      <TableCell>
                        <BookableCell pool={pools.get(row.id) ?? null} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={
                            pools.has(row.id) ? "Edit booking setup" : "Make bookable"
                          }
                          onClick={() => setBookableFor(row)}
                        >
                          <CalendarCheckIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Edit record"
                          onClick={() => setRecordDialog({ open: true, editing: row })}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Delete record"
                          onClick={() => void deleteRecord(row.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {cursor ? (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingRows}
                onClick={() => void loadRecords(cursor)}
              >
                {loadingRows ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <button
            type="button"
            aria-expanded={schemaOpen}
            onClick={() => setSchemaOpen((prev) => !prev)}
            className="flex items-center gap-2 text-left"
          >
            {schemaOpen ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
            <CardTitle className="text-base">Fields &amp; settings</CardTitle>
          </button>
        </CardHeader>

        {schemaOpen ? (
          <CardContent className="flex flex-col gap-4">
            <div className="max-w-sm">
              <Label htmlFor="entity-rename" className="mb-1 block text-xs">
                Name
              </Label>
              <Input
                id="entity-rename"
                value={draftName}
                maxLength={120}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </div>

            <div>
              <Label className="mb-2 block text-xs">Fields</Label>
              <FieldRowsEditor
                fields={draftFields}
                onChange={setDraftFields}
                lockPersistedKeys
              />
            </div>

            {orphaned.length > 0 ? (
              <p className="text-xs text-graft-warn">
                Removing {orphaned.join(", ")} leaves the data already stored under{" "}
                {orphaned.length === 1 ? "that key" : "those keys"} unreachable — existing
                records drop it the next time they are saved.
              </p>
            ) : null}

            {schemaError ? (
              <p role="alert" className="text-sm text-destructive">
                {schemaError}
              </p>
            ) : null}
            {schemaSaved ? <p className="text-xs text-muted-foreground">Saved.</p> : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <Button type="button" disabled={savingSchema} onClick={() => void saveSchema()}>
                {savingSchema ? "Saving…" : "Save changes"}
              </Button>

              {confirmingDelete ? (
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground">
                    Delete {entity.name}? Any form bound to it is unpublished.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={deleting}
                    onClick={() => void deleteEntity()}
                  >
                    {deleting ? "Deleting…" : "Delete entity"}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2Icon /> Delete entity
                </Button>
              )}
            </div>
          </CardContent>
        ) : null}
      </Card>

      <RecordDialog
        open={recordDialog.open}
        onOpenChange={(open) => setRecordDialog((prev) => ({ ...prev, open }))}
        entityId={entityId}
        entityName={entity.name}
        fields={entity.fields}
        editing={recordDialog.editing}
        onSaved={() => void loadRecords(null)}
      />

      {/* Keyed on the record so the dialog re-seeds per row rather than
       * showing the last one's answers against this one. */}
      {bookableFor ? (
        <BookableDialog
          key={bookableFor.id}
          open
          onOpenChange={(open) => {
            if (!open) setBookableFor(null);
          }}
          entityId={entityId}
          recordId={bookableFor.id}
          recordLabel={recordLabel(bookableFor, entity.fields)}
          pool={pools.get(bookableFor.id) ?? null}
          onSaved={() => void loadPools()}
        />
      ) : null}
    </div>
  );
}

/**
 * What to call a record in a dialog title. Mirrors the precedence the
 * operations timeline and the booking bridge use (`resourceName`), falling
 * back to the first text value rather than to an id — an ObjectId in a title
 * tells the reader nothing about which boat they are configuring.
 */
function recordLabel(row: RecordRow, fields: FieldLike[]): string {
  for (const key of ["name", "title", "label"]) {
    const value = row.data[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const firstText = fields.find((field) => field.type === "text");
  const fallback = firstText ? row.data[firstText.key] : undefined;
  return typeof fallback === "string" && fallback.trim() !== ""
    ? fallback.trim()
    : "this record";
}

/** The bookable state of one record, as a word rather than a bare tick. */
function BookableCell({ pool }: { pool: PoolView | null }) {
  if (!pool) return <span className="text-xs text-muted-foreground">Not bookable</span>;
  return (
    <span className="text-xs">
      {pool.strategy === "individual_asset" ? "Bookable" : `Bookable · ${pool.totalQuantity}`}
      {pool.bufferMinutes > 0 ? (
        <span className="text-muted-foreground"> · +{pool.bufferMinutes}m</span>
      ) : null}
    </span>
  );
}

/** A record's image field in a table cell — the thumbnail, or a dash. */
function RecordThumbnail({ mediaId, label }: { mediaId: unknown; label: string }) {
  if (typeof mediaId !== "string" || !/^[0-9a-f]{24}$/i.test(mediaId)) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the byte route 307s to a presigned URL; next/image cannot follow that
    <img
      src={recordImageUrl(mediaId)}
      alt={label}
      className="size-10 rounded-md border object-cover"
    />
  );
}
