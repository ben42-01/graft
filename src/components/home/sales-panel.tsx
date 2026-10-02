"use client";

/**
 * Sales over the last 30 days — the trend, the best sellers and where the
 * orders came from. Premium (docs/TIERS.md §2.4 Reports).
 *
 * Gated the way the Chart widget is: `allowed` comes from the features `/me`
 * reported, a tenant without it sees a locked card and never issues the
 * request, and the request is refused server-side regardless
 * (`getSalesReport`, src/server/services/sales-report.ts).
 *
 * The chart is one series — what was booked each day — so it is one hue with
 * no legend; the title names it. Collected money is a headline figure beside
 * it rather than a second set of bars: the two rise on different days and
 * read as noise when interleaved. Bars are plain elements sized in
 * percentages, so the plot reflows with its card, and every bar's figures are
 * also in a table for anyone not reading the picture.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { LockIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/bms/format";
import { getJson, type ApiSalesReport } from "@/lib/bms/reads";
import { cn } from "@/lib/utils";

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; report: ApiSalesReport };

const shortDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

export function SalesPanel({ allowed }: { allowed: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void getJson<ApiSalesReport>("/api/v1/reports/sales").then((report) => {
      if (cancelled) return;
      setState(report ? { status: "ready", report } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  return (
    <Card className="h-full gap-4 px-5 py-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Sales · last 30 days</h2>
        {allowed && state.status === "ready" && state.report.currency ? (
          <span className="text-xs text-muted-foreground">
            Booked per day, {state.report.currency}
          </span>
        ) : null}
      </div>

      {!allowed ? (
        <div className="flex flex-col items-start gap-2">
          <div className="flex h-28 w-full items-center justify-center rounded-md border border-dashed">
            <LockIcon className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <p className="text-xs text-muted-foreground">
            See your sales trend, best sellers and returning customers on Premium.{" "}
            <Link
              href="/account"
              className="font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light"
            >
              View plans
            </Link>
          </p>
        </div>
      ) : state.status === "loading" ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading sales…</p>
      ) : state.status === "error" ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Sales are unavailable.</p>
      ) : (
        <SalesReport report={state.report} />
      )}
    </Card>
  );
}

function SalesReport({ report }: { report: ApiSalesReport }) {
  const { currency, totals } = report;
  if (totals.orders === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No orders in the last 30 days.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Headline label="Booked" value={formatMoney(totals.bookedMinor, currency)} />
        <Headline label="Collected" value={formatMoney(totals.collectedMinor, currency)} />
        <Headline
          label="Average order"
          value={formatMoney(totals.averageOrderMinor, currency)}
        />
        <Headline
          label="Repeat customers"
          value={`${report.customers.repeat} of ${report.customers.total}`}
        />
      </dl>

      <DailyBars series={report.series} currency={currency} />

      <div className="grid gap-5 sm:grid-cols-2">
        <Ranked
          title="Best sellers"
          rows={report.topItems.slice(0, 5).map((item) => ({
            key: item.description,
            label: item.description,
            detail: `${item.quantity} sold`,
            valueMinor: item.revenueMinor,
          }))}
          currency={currency}
        />
        <Ranked
          title="Where orders came from"
          rows={report.bySource.slice(0, 5).map((source) => ({
            key: source.formId ?? "direct",
            label: source.formId ? (source.formName ?? "A deleted form") : "Entered by hand",
            detail: `${source.orders} ${source.orders === 1 ? "order" : "orders"}`,
            valueMinor: source.bookedMinor,
          }))}
          currency={currency}
        />
      </div>

      {report.otherCurrencies.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Orders in {report.otherCurrencies.join(", ")} are not included in these figures.
        </p>
      ) : null}
    </div>
  );
}

function Headline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function DailyBars({
  series,
  currency,
}: {
  series: ApiSalesReport["series"];
  currency: string | null;
}) {
  const [active, setActive] = useState<number | null>(null);
  const peak = Math.max(...series.map((day) => day.bookedMinor), 1);
  const focus = active === null ? null : series[active];

  return (
    <div>
      {/* The readout sits above the plot at a fixed height, so hovering a bar
       * never moves the chart under the pointer. */}
      <p className="h-5 text-xs text-muted-foreground" aria-live="polite">
        {focus ? (
          <>
            <span className="font-medium text-foreground">{shortDay(focus.date)}</span> ·{" "}
            {formatMoney(focus.bookedMinor, currency)} booked · {focus.orders}{" "}
            {focus.orders === 1 ? "order" : "orders"}
          </>
        ) : (
          <>Peak day {formatMoney(peak, currency)}</>
        )}
      </p>

      <div
        className="mt-1 flex h-28 items-end gap-0.5 border-b border-border"
        onMouseLeave={() => setActive(null)}
        aria-hidden
      >
        {series.map((day, index) => (
          // The hit target is the full column, not the bar: a zero day and a
          // short bar are as easy to point at as the peak.
          <div
            key={day.date}
            className="flex h-full min-w-0 flex-1 items-end"
            onMouseEnter={() => setActive(index)}
          >
            <div
              className={cn(
                "w-full rounded-t-[3px] bg-graft-green transition-opacity dark:bg-graft-green-light",
                active !== null && active !== index && "opacity-40",
              )}
              style={{
                height:
                  day.bookedMinor === 0
                    ? "0"
                    : `${Math.max((day.bookedMinor / peak) * 100, 3)}%`,
              }}
            />
          </div>
        ))}
      </div>

      <div className="mt-1 flex justify-between text-xs text-muted-foreground" aria-hidden>
        <span>{shortDay(series[0].date)}</span>
        <span>{shortDay(series[Math.floor(series.length / 2)].date)}</span>
        <span>{shortDay(series[series.length - 1].date)}</span>
      </div>

      <table className="sr-only">
        <caption>Booked per day, last 30 days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Booked</th>
            <th scope="col">Orders</th>
          </tr>
        </thead>
        <tbody>
          {series.map((day) => (
            <tr key={day.date}>
              <th scope="row">{shortDay(day.date)}</th>
              <td>{formatMoney(day.bookedMinor, currency)}</td>
              <td>{day.orders}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RankedRow = { key: string; label: string; detail: string; valueMinor: number };

function Ranked({
  title,
  rows,
  currency,
}: {
  title: string;
  rows: RankedRow[];
  currency: string | null;
}) {
  const peak = Math.max(...rows.map((row) => row.valueMinor), 1);
  return (
    <div>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="mt-2 flex flex-col gap-2.5">
        {rows.map((row) => (
          <li key={row.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatMoney(row.valueMinor, currency)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span
                  className="block h-full rounded-full bg-graft-green dark:bg-graft-green-light"
                  style={{ width: `${Math.max((row.valueMinor / peak) * 100, 2)}%` }}
                />
              </span>
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                {row.detail}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
