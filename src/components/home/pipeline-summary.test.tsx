/**
 * The pipeline as a shape. The rule under test is which statuses get a row:
 * terminal ones (`completed`, `cancelled`) only ever grow, so given a few
 * months of trading they would dominate the chart and say nothing about today.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { countByStatus, PipelineSummary } from "./pipeline-summary";
import type { BoardOrder, OrderStatus } from "@/components/operations/order-board";

function order(id: string, status: OrderStatus): BoardOrder {
  return {
    id,
    status,
    currency: "USD",
    totalMinor: 1000,
    balanceMinor: 0,
    customerLabel: null,
    lineSummary: "A thing",
    createdAt: new Date().toISOString(),
  };
}

describe("countByStatus", () => {
  it("reports a zero for statuses with no orders, not a missing key", () => {
    expect(countByStatus([order("a", "draft")])).toMatchObject({
      draft: 1,
      confirmed: 0,
      cancelled: 0,
    });
  });
});

describe("PipelineSummary", () => {
  it("gives each live stage a row that links into the board", () => {
    render(
      <PipelineSummary
        orders={[order("a", "draft"), order("b", "confirmed"), order("c", "confirmed")]}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("href", "/operations");
    }
  });

  it("summarises terminal statuses on one line instead of charting them", () => {
    render(
      <PipelineSummary
        orders={[order("a", "completed"), order("b", "completed"), order("c", "cancelled")]}
      />,
    );

    expect(screen.getByText("2 completed · 1 cancelled")).toBeInTheDocument();
    expect(screen.getByText("Nothing in the pipeline right now.")).toBeInTheDocument();
  });

  it("says the pipeline is empty rather than rendering four zero-width bars", () => {
    render(<PipelineSummary orders={[]} />);

    expect(screen.getByText("Nothing in the pipeline right now.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
