/**
 * The rail — a path, not a menu. The rules worth pinning are that it shows
 * only this run's steps, and that nothing ahead of where you are is clickable.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StepRail } from "./step-rail";
import { emptyRunState, progressFor } from "@/lib/setup/flow";

const runAt = (patch: Parameters<typeof Object.assign>[1] = {}) =>
  progressFor({ ...emptyRunState(), ...patch });

describe("StepRail", () => {
  it("shows the steps of this run, not of every run", () => {
    render(
      <StepRail
        steps={runAt({ thingLabel: "Kilns", intent: "list" })}
        current="shape"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText("Availability")).not.toBeInTheDocument();
  });

  it("includes availability once the run is about bookings", () => {
    render(
      <StepRail
        steps={runAt({ thingLabel: "Kilns", intent: "bookings" })}
        current="shape"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Availability")).toBeInTheDocument();
  });

  it("lets you go back to a finished step but not skip ahead to an unreachable one", async () => {
    const onSelect = vi.fn();
    render(
      <StepRail
        steps={runAt({ thingLabel: "Kilns", intent: "bookings", resourceEntityId: "e1" })}
        current="records"
        onSelect={onSelect}
      />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: /What/ }));
    expect(onSelect).toHaveBeenCalledWith("thing");

    expect(screen.getByRole("button", { name: /Availability/ })).toBeDisabled();
  });

  it("marks where you are for a screen reader, not only with a background", () => {
    render(
      <StepRail
        steps={runAt({ thingLabel: "Kilns", intent: "list" })}
        current="shape"
        onSelect={vi.fn()}
      />,
    );

    const current = screen.getByRole("button", { current: "step" });
    expect(current).toHaveTextContent("Details");
  });
});
