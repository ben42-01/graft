/**
 * The guided setup flow model — the orderings and gates that the five
 * hand-setup confusions turn into rules.
 */
import { describe, expect, it } from "vitest";
import {
  blockingReason,
  currentStep,
  emptyRunState,
  INTENT_COPY,
  isRunComplete,
  nextStep,
  previousStep,
  progressFor,
  SETUP_INTENTS,
  stepCopy,
  stepsFor,
  type SetupRunState,
} from "./flow";

/** A run that has got as far as the caller says, for whatever intent. */
function runState(patch: Partial<SetupRunState> = {}): SetupRunState {
  return { ...emptyRunState(), ...patch };
}

describe("stepsFor", () => {
  it("offers only what is known before an intent is chosen", () => {
    expect(stepsFor(null)).toEqual(["thing", "intent"]);
  });

  it("gives a plain list no form and no availability steps", () => {
    expect(stepsFor("list")).toEqual(["thing", "intent", "shape", "records", "done"]);
  });

  it("gives enquiries a second entity and a form, but no availability", () => {
    const steps = stepsFor("enquiries");
    expect(steps).toContain("request");
    expect(steps).toContain("form");
    expect(steps).not.toContain("bookable");
  });

  it("puts adding records before setting availability, because a pool attaches to a record", () => {
    const steps = stepsFor("bookings");
    expect(steps.indexOf("records")).toBeLessThan(steps.indexOf("bookable"));
  });

  it("gives bookings a second entity for the request itself", () => {
    // The resource and the request are separate shapes; one entity cannot be
    // both the boat and the person asking for it.
    expect(stepsFor("bookings")).toContain("request");
  });

  it("every intent starts the same way and ends at done", () => {
    for (const intent of SETUP_INTENTS) {
      const steps = stepsFor(intent);
      expect(steps.slice(0, 2)).toEqual(["thing", "intent"]);
      expect(steps[steps.length - 1]).toBe("done");
    }
  });
});

describe("blockingReason", () => {
  it("blocks naming until something is typed", () => {
    expect(blockingReason("thing", runState())).toMatch(/name/i);
    expect(blockingReason("thing", runState({ thingLabel: "Boats" }))).toBeNull();
  });

  it("blocks the shape step until the entity is actually created", () => {
    const state = runState({ thingLabel: "Rehearsal rooms", intent: "list" });
    expect(blockingReason("shape", state)).toContain("Rehearsal rooms");
    expect(blockingReason("shape", runState({ resourceEntityId: "e1" }))).toBeNull();
  });

  it("blocks availability until at least one record has it, but not all of them", () => {
    expect(blockingReason("bookable", runState({ bookableRecordCount: 0 }))).not.toBeNull();
    expect(blockingReason("bookable", runState({ bookableRecordCount: 1 }))).toBeNull();
  });

  it("treats an unpublished form as unfinished, and says which half is missing", () => {
    expect(blockingReason("form", runState())).toMatch(/create/i);
    expect(blockingReason("form", runState({ formId: "f1" }))).toMatch(/publish/i);
    expect(blockingReason("form", runState({ formId: "f1", formPublished: true }))).toBeNull();
  });

  it("never blocks the closing step", () => {
    expect(blockingReason("done", runState())).toBeNull();
  });
});

describe("progressFor", () => {
  it("makes only the first incomplete step and its predecessors reachable", () => {
    const state = runState({
      thingLabel: "Tutoring slots",
      intent: "list",
      resourceEntityId: "e1",
    });
    const progress = progressFor(state);
    const byId = Object.fromEntries(progress.map((step) => [step.id, step]));

    expect(byId.shape.complete).toBe(true);
    expect(byId.records.complete).toBe(false);
    expect(byId.records.reachable).toBe(true);
    // "done" sits behind an incomplete step, so it is not yet reachable even
    // though nothing blocks the step itself.
    expect(byId.done.reachable).toBe(false);
  });

  it("numbers the steps of the run it is in, not of some global list", () => {
    const listRun = progressFor(runState({ intent: "list" }));
    const bookingRun = progressFor(runState({ intent: "bookings" }));
    expect(listRun.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
    expect(bookingRun).toHaveLength(8);
  });
});

describe("currentStep", () => {
  it("opens on the first thing not done", () => {
    expect(currentStep(runState())).toBe("thing");
    expect(currentStep(runState({ thingLabel: "Vans" }))).toBe("intent");
    expect(currentStep(runState({ thingLabel: "Vans", intent: "list" }))).toBe("shape");
  });

  it("opens a finished run on its last step rather than looping", () => {
    const finished = runState({
      thingLabel: "Vans",
      intent: "list",
      resourceEntityId: "e1",
      recordCount: 3,
    });
    expect(currentStep(finished)).toBe("done");
    expect(isRunComplete(finished)).toBe(true);
  });
});

describe("nextStep / previousStep", () => {
  it("walks the run's own path, skipping steps this intent does not have", () => {
    const state = runState({ intent: "enquiries" });
    expect(nextStep("records", state)).toBe("request");
    expect(previousStep("request", state)).toBe("records");
  });

  it("walks through availability when the intent has it", () => {
    const state = runState({ intent: "bookings" });
    expect(nextStep("records", state)).toBe("bookable");
  });

  it("has no step before the first or after the last", () => {
    const state = runState({ intent: "list" });
    expect(previousStep("thing", state)).toBeNull();
    expect(nextStep("done", state)).toBeNull();
  });
});

describe("copy", () => {
  it("speaks the user's noun back, whatever it is", () => {
    for (const thingLabel of ["Boats", "Rehearsal rooms", "Dog grooming slots"]) {
      const copy = stepCopy("records", runState({ thingLabel }));
      expect(copy.title).toContain(thingLabel);
    }
  });

  it("reads naturally before a noun has been typed", () => {
    const copy = stepCopy("intent", runState());
    expect(copy.title).toBe("What should happen with them?");
  });

  it("names no industry anywhere — the flow fits whatever the thing is", () => {
    // Examples are fine ("boats, rooms, courses"); a step that only makes
    // sense for one trade is not.
    const state = runState({ thingLabel: "Kilns", intent: "bookings" });
    for (const id of stepsFor("bookings")) {
      const copy = stepCopy(id, state);
      expect(copy.label.length).toBeLessThanOrEqual(14);
      expect(copy.blurb.length).toBeGreaterThan(0);
    }
  });

  it("says out loud that the request record is the customer", () => {
    expect(stepCopy("request", runState()).blurb).toMatch(/customer/i);
  });

  it("says out loud that availability is not a field", () => {
    expect(stepCopy("bookable", runState()).blurb).toMatch(/not a field|worked out/i);
  });

  it("describes every intent it offers", () => {
    for (const intent of SETUP_INTENTS) {
      expect(INTENT_COPY[intent].label.length).toBeGreaterThan(0);
      expect(INTENT_COPY[intent].blurb.length).toBeGreaterThan(0);
    }
  });
});
