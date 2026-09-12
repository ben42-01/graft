"use client";

/**
 * Adding the first records, and — on a booking run — the step after it that
 * says how many of each can be booked at once.
 *
 * These are one file because they are one screen twice: the same list of real
 * records, with a different question asked about each row. Splitting them
 * would duplicate the loading, the empty state and the row rendering to no
 * benefit.
 *
 * The ordering they encode is the whole reason the flow exists. An inventory
 * pool attaches to a `recordId`, so availability cannot be configured while
 * the entity is still an empty shape — which is exactly what someone building
 * by hand tries to do, by adding a "quantity" field that nothing ever reads.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BookableDialog,
  STRATEGIES,
  type PoolView,
} from "@/components/entities/bookable-dialog";
import { RecordDialog, type RecordRow } from "@/components/entities/record-dialog";
import { formatCell, type FieldLike } from "@/lib/entities/record-values";

/** Enough rows to prove the point; the entity's own page is where a real
 * catalogue gets filled in. */
const PAGE_SIZE = 25;

export type RecordsStepMode = "add" | "bookable";

function labelOf(row: RecordRow, fields: FieldLike[]): string {
  const first = fields.find((field) => field.type === "text");
  const value = first ? formatCell(row.data[first.key], first) : "";
  return value || "Untitled";
}

export function RecordsStep({
  mode,
  entityId,
  entityName,
  fields,
  /** Told the counts the flow gates on, whenever they change. */
  onCounts,
}: {
  mode: RecordsStepMode;
  entityId: string;
  entityName: string;
  fields: FieldLike[];
  onCounts: (counts: { recordCount: number; bookableRecordCount: number }) => void;
}) {
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [pools, setPools] = useState<Map<string, PoolView>>(new Map());
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [bookableFor, setBookableFor] = useState<RecordRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [recordsResponse, poolsResponse] = await Promise.all([
        fetch(`/api/v1/entities/${entityId}/records?limit=${PAGE_SIZE}`, {
          credentials: "include",
        }),
        // Only a booking run has pools; asking anyway keeps one code path,
        // and a failure here costs the column rather than the step.
        mode === "bookable"
          ? fetch(`/api/v1/inventory/pools?entityId=${entityId}&limit=100`, {
              credentials: "include",
            })
          : Promise.resolve(null),
      ]);

      const nextRows = recordsResponse.ok
        ? ((await recordsResponse.json()) as { data: RecordRow[] }).data
        : [];
      const nextPools =
        poolsResponse && poolsResponse.ok
          ? ((await poolsResponse.json()) as { data: PoolView[] }).data
          : [];

      setRows(nextRows);
      setPools(new Map(nextPools.map((pool) => [pool.recordId, pool])));
      onCounts({ recordCount: nextRows.length, bookableRecordCount: nextPools.length });
    } finally {
      setLoading(false);
    }
  }, [entityId, mode, onCounts]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 && !loading ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing in {entityName} yet.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((row) => {
            const pool = pools.get(row.id);
            const strategy = STRATEGIES.find((option) => option.value === pool?.strategy);

            return (
              <li key={row.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm">{labelOf(row, fields)}</span>

                {mode === "bookable" ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {pool
                        ? pool.strategy === "individual_asset"
                          ? (strategy?.label ?? "Bookable")
                          : `${strategy?.label ?? "Bookable"} · ${pool.totalQuantity} at once`
                        : "Not bookable yet"}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setBookableFor(row)}>
                      <CalendarClockIcon className="size-4" aria-hidden="true" />
                      {pool ? "Change" : "Set availability"}
                    </Button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {mode === "add" ? (
        <div>
          <Button type="button" onClick={() => setAdding(true)}>
            <PlusIcon className="size-4" aria-hidden="true" />
            Add one
          </Button>
        </div>
      ) : null}

      <RecordDialog
        open={adding}
        onOpenChange={setAdding}
        entityId={entityId}
        entityName={entityName}
        fields={fields}
        editing={null}
        onSaved={() => void load()}
      />

      {bookableFor ? (
        <BookableDialog
          open
          onOpenChange={(open) => {
            if (!open) setBookableFor(null);
          }}
          entityId={entityId}
          recordId={bookableFor.id}
          recordLabel={labelOf(bookableFor, fields)}
          pool={pools.get(bookableFor.id) ?? null}
          onSaved={() => {
            setBookableFor(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
