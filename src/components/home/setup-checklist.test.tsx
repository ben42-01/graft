/**
 * The Overview's day-one path. Two things are worth pinning: done-ness is
 * derived from real data (never a stored onboarding flag that can drift), and
 * exactly one step carries a call to action — a column of four equal buttons
 * is a menu, not a path.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildSetupSteps, hasOutstandingStep, SetupChecklist } from "./setup-checklist";

const empty = { entityCount: 0, recordCount: 0, formCount: 0, orderCount: 0 };

describe("buildSetupSteps", () => {
  it("marks nothing done for a brand-new tenant", () => {
    expect(buildSetupSteps(empty).every((step) => step.status === "todo")).toBe(true);
  });

  it("derives each step from the data rather than from step order", () => {
    // A tenant who created an order through the API without publishing a form
    // is not told to go back and do step 3 again.
    const steps = buildSetupSteps({ ...empty, entityCount: 2, orderCount: 1 });
    expect(Object.fromEntries(steps.map((s) => [s.id, s.status]))).toEqual({
      entity: "done",
      record: "todo",
      form: "todo",
      order: "done",
    });
  });

  it("counts records via the meter, not the entity count", () => {
    expect(buildSetupSteps({ ...empty, entityCount: 3 })[1]!.status).toBe("todo");
    expect(buildSetupSteps({ ...empty, entityCount: 3, recordCount: 1 })[1]!.status).toBe(
      "done",
    );
  });

  it("says it couldn't check, rather than 'not done', when the read failed", () => {
    // `/api/v1/forms` 500s against seeded dev data today. Telling a tenant to
    // go publish the form they already published is worse than saying nothing.
    const steps = buildSetupSteps({ ...empty, entityCount: 1, formCount: null });
    expect(steps.find((s) => s.id === "form")!.status).toBe("unknown");
  });
});

describe("SetupChecklist", () => {
  it("never points at a step it couldn't verify", () => {
    const steps = buildSetupSteps({ ...empty, entityCount: 1, recordCount: null });
    render(<SetupChecklist steps={steps} />);

    // "Add your first records" is unknown, so the path skips to the next step
    // it can actually vouch for.
    expect(screen.getByRole("link")).toHaveAccessibleName("Build a form");
    expect(screen.getByText(/couldn't check this one/i)).toBeInTheDocument();
    // An unverifiable step is not counted against the total either.
    expect(screen.getByText("1 of 3 done")).toBeInTheDocument();
  });

  it("reports nothing outstanding when every knowable step is done", () => {
    const steps = buildSetupSteps({
      entityCount: 1,
      recordCount: 1,
      formCount: null,
      orderCount: 1,
    });
    expect(hasOutstandingStep(steps)).toBe(false);
  });

  it("shows progress and puts the call to action on the first unfinished step", () => {
    render(<SetupChecklist steps={buildSetupSteps({ ...empty, entityCount: 1 })} />);

    expect(screen.getByText("1 of 4 done")).toBeInTheDocument();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Open entities");
    expect(links[0]).toHaveAttribute("href", "/entities");
  });

  it("announces done-ness to a screen reader, not only with a line-through", () => {
    render(<SetupChecklist steps={buildSetupSteps({ ...empty, entityCount: 1 })} />);

    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText(/Done:/)).toBeInTheDocument();
    expect(within(items[1]!).getByText(/To do:/)).toBeInTheDocument();
  });

  it("offers nothing further once every step is done", () => {
    const steps = buildSetupSteps({
      entityCount: 1,
      recordCount: 1,
      formCount: 1,
      orderCount: 1,
    });
    render(<SetupChecklist steps={steps} />);

    expect(screen.getByText("4 of 4 done")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
