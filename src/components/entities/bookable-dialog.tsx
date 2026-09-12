"use client";

/**
 * Making one record bookable — the inventory pool of docs/BMS_EXTENSION.md
 * §2.1, asked as three questions a business can answer.
 *
 * This is the screen the booking path was missing. Every endpoint it calls has
 * existed since BMS Step 1, but nothing in the product ever created a pool, so
 * a record could never become a resource: a booking form raised the order and
 * no allocation, which means it also performed no capacity check. A boat
 * without a pool can be booked by ten people for the same morning.
 *
 * Three things about its shape follow from the server rather than taste:
 *
 *   - **Strategy is chosen once and never edited.** `updatePool` refuses to
 *     patch it, because reinterpreting allocations already written against the
 *     pool — four booked kayaks, under a pool that now claims to be one named
 *     asset — has no right answer. So it is a choice on creation and a fact
 *     afterwards, with the honest path (stop, then start again) spelled out.
 *   - **Quantity is not asked for an individual asset.** "How many of this
 *     specific boat are there" is not a question anyone should be made to
 *     answer; the server normalises it to 1 rather than validating it.
 *   - **Stopping bookings does not erase history.** `deletePool` soft-deletes
 *     and deliberately leaves allocations alone — last season's bookings stay
 *     readable — so the confirmation says that rather than implying a purge.
 *
 * `autoLockOnCheckout` is deliberately not offered here. It governs the
 * short-lived `/holds` lease a checkout flow takes, and no checkout flow
 * exists in the product yet; a booking form's hold is a different thing and
 * does not lapse. A toggle for a mechanism nothing reaches is noise.
 */
import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Mirrors `INVENTORY_STRATEGIES` in src/server/services/inventory.ts. */
export const STRATEGIES = [
  {
    value: "individual_asset",
    label: "One specific thing",
    hint: "A named item you have exactly one of — Boat #4, room 12, a particular van.",
  },
  {
    value: "pooled_quantity",
    label: "A stock of identical things",
    hint: "Interchangeable units you hold several of — fifty kayaks, twenty tents.",
  },
  {
    value: "time_slot",
    label: "Capacity at a time",
    hint: "How many bookings can run at once — consulting hours, tour guide slots.",
  },
] as const;

export type Strategy = (typeof STRATEGIES)[number]["value"];

export type PoolView = {
  id: string;
  entityId: string;
  recordId: string;
  strategy: Strategy;
  totalQuantity: number;
  bufferMinutes: number;
};

const DEFAULT_QUANTITY = 10;

export function BookableDialog({
  open,
  onOpenChange,
  entityId,
  recordId,
  recordLabel,
  /** The record's existing pool, or `null` if it is not bookable yet. */
  pool,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  recordId: string;
  recordLabel: string;
  pool: PoolView | null;
  onSaved: () => void;
}) {
  const [strategy, setStrategy] = useState<Strategy>("individual_asset");
  const [quantity, setQuantity] = useState<string>(String(DEFAULT_QUANTITY));
  const [buffer, setBuffer] = useState<string>("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);

  // Re-seed whenever the dialog opens, so it never shows the last record's
  // answers against this one.
  useEffect(() => {
    if (!open) return;
    setStrategy(pool?.strategy ?? "individual_asset");
    setQuantity(String(pool?.totalQuantity ?? DEFAULT_QUANTITY));
    setBuffer(String(pool?.bufferMinutes ?? 0));
    setError(null);
    setConfirmingStop(false);
  }, [open, pool]);

  const needsQuantity = strategy !== "individual_asset";
  const chosen = STRATEGIES.find((option) => option.value === strategy) ?? STRATEGIES[0];

  async function send(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        credentials: "include",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? "We couldn't save this.");
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const bufferMinutes = Number(buffer) || 0;
    if (pool) {
      // Strategy is absent on purpose: the server refuses to patch it.
      return send(`/api/v1/inventory/pools/${pool.id}`, "PATCH", {
        bufferMinutes,
        ...(pool.strategy === "individual_asset" ? {} : { totalQuantity: Number(quantity) }),
      });
    }
    return send("/api/v1/inventory/pools", "POST", {
      entityId,
      recordId,
      strategy,
      bufferMinutes,
      ...(needsQuantity ? { totalQuantity: Number(quantity) } : {}),
    });
  }

  const quantityValid = !needsQuantity || Number(quantity) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bookable — {recordLabel}</DialogTitle>
          <DialogDescription>
            {pool
              ? "This resource takes bookings. A booking form holds it for the time a customer asks for, and refuses anyone who asks for the same slot."
              : "Make this resource bookable, so a booking form holds it for the time a customer asks for — and turns anyone away who asks for a slot that is already taken."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-1">
          <div>
            <Label htmlFor="pool-strategy" className="mb-1 block text-xs">
              What is it?
            </Label>
            <Select
              value={strategy}
              onValueChange={(value) => setStrategy(value as Strategy)}
              disabled={pool !== null}
            >
              <SelectTrigger id="pool-strategy" aria-label="What is it?" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {pool
                ? "This cannot be changed — bookings already taken were counted this way. To switch, stop taking bookings and set it up again."
                : chosen.hint}
            </p>
          </div>

          {needsQuantity ? (
            <div>
              <Label htmlFor="pool-quantity" className="mb-1 block text-xs">
                How many
              </Label>
              <Input
                id="pool-quantity"
                type="number"
                min={1}
                className="w-32"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The most that can be out at once. Bookings are refused past it.
              </p>
            </div>
          ) : null}

          <div>
            <Label htmlFor="pool-buffer" className="mb-1 block text-xs">
              Time needed in between
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="pool-buffer"
                type="number"
                min={0}
                className="w-32"
                value={buffer}
                onChange={(event) => setBuffer(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Cleaning, refuelling, turnaround. Blocked either side of every booking, so
              back-to-back hires cannot be booked closer than this.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {confirmingStop ? (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
              Stop taking bookings for {recordLabel}? Bookings already taken stay exactly as
              they are — this only stops new ones.
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          {pool ? (
            <Button
              type="button"
              variant={confirmingStop ? "destructive" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() =>
                confirmingStop
                  ? void send(`/api/v1/inventory/pools/${pool.id}`, "DELETE")
                  : setConfirmingStop(true)
              }
            >
              {confirmingStop ? "Yes, stop bookings" : "Stop taking bookings"}
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" disabled={busy || !quantityValid} onClick={() => void save()}>
            {busy ? "Saving…" : pool ? "Save changes" : "Make bookable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
