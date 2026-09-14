/**
 * The guided setup flow — which steps a run has, in which order, and what
 * blocks each one.
 *
 * Why this exists at all: setting up a first entity by hand hits five
 * confusions that are all *sequencing or visibility* problems rather than
 * missing features. Taking bookings needs two entities (the thing, and the
 * request for it), not one. The record a submission creates *is* the
 * customer, so there is no Customers entity to link. Capacity is computed
 * from a pool, not held in a field. The pool attaches to a record, so it
 * cannot be configured before records exist. And a field the engine never
 * reads still looks operational. This module encodes the order that makes
 * those facts unsurprising, and nothing else knows the order.
 *
 * **Domain-agnostic by construction.** The flow never knows what the thing
 * is. Every piece of copy takes the noun the user typed — "Boats", "Tutoring
 * slots", "Gear hire", "Rehearsal rooms" — and the steps branch only on what
 * the user wants to *happen* with it. There is no boat-shaped, room-shaped or
 * appointment-shaped path; there is one path whose shape follows the intent.
 *
 * Pure: no React, no fetch, no mongodb. The page renders it, the service
 * persists it, and both agree on what "step 4" means because neither decides.
 */

/** What the user wants to happen with the thing they are setting up. */
export const SETUP_INTENTS = ["list", "enquiries", "bookings"] as const;
export type SetupIntent = (typeof SETUP_INTENTS)[number];

export const SETUP_STEPS = [
  "thing",
  "intent",
  "shape",
  "records",
  "bookable",
  "request",
  "form",
  "done",
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

/**
 * What a run has produced so far. Every id here points at an ordinary object
 * created through the ordinary endpoints — the run remembers *which* ones,
 * it never owns them. Abandoning a run therefore leaves real, usable entities
 * behind rather than debris.
 */
export type SetupRunState = {
  /** The plural noun the user typed. Drives copy everywhere. */
  thingLabel: string;
  intent: SetupIntent | null;
  /** The entity holding the things themselves. */
  resourceEntityId: string | null;
  /** How many records it has — the run's own count, confirmed against the
   * entity when the page loads, so a record added elsewhere still counts. */
  recordCount: number;
  /** Records made bookable so far (one inventory pool each). */
  bookableRecordCount: number;
  /** The second entity: one record per incoming request. Null until the
   * intent needs one. */
  requestEntityId: string | null;
  formId: string | null;
  /** True once the form is published — the run's finish line. */
  formPublished: boolean;
};

export const emptyRunState = (): SetupRunState => ({
  thingLabel: "",
  intent: null,
  resourceEntityId: null,
  recordCount: 0,
  bookableRecordCount: 0,
  requestEntityId: null,
  formId: null,
  formPublished: false,
});

/**
 * The steps each intent actually has.
 *
 * `records` sits before `bookable` on purpose: a pool attaches to a record id,
 * so "how many can be booked at once" is unanswerable until the records it
 * describes exist. That single ordering is the fix for the confusion that
 * capacity ought to be a field on the entity.
 */
const STEPS_BY_INTENT: Record<SetupIntent, readonly SetupStepId[]> = {
  list: ["thing", "intent", "shape", "records", "done"],
  enquiries: ["thing", "intent", "shape", "records", "request", "form", "done"],
  bookings: ["thing", "intent", "shape", "records", "bookable", "request", "form", "done"],
};

/** Before an intent is chosen, only the first two steps are known to exist. */
export function stepsFor(intent: SetupIntent | null): readonly SetupStepId[] {
  return intent ? STEPS_BY_INTENT[intent] : (["thing", "intent"] as const);
}

export type StepCopy = {
  /** Sidebar label — short, no interpolation, so the rail stays scannable. */
  label: string;
  /** The question the step asks, in the user's own noun. */
  title: string;
  /** One line of why, which is where the invisible rules get said out loud. */
  blurb: string;
};

/**
 * Copy for one step of one run.
 *
 * `thing` is whatever the user typed, lowercased into sentences and left alone
 * in titles. When they have typed nothing yet it falls back to "them" rather
 * than a placeholder like "your items": a sentence that reads naturally with
 * no noun beats one with a fake one.
 */
export function stepCopy(step: SetupStepId, state: SetupRunState): StepCopy {
  const thing = state.thingLabel.trim() || "them";

  switch (step) {
    case "thing":
      return {
        label: "What",
        title: "What are you setting up?",
        blurb:
          "Whatever your business keeps track of — boats, rooms, courses, tools, clients. Name it the way you say it out loud, in the plural.",
      };
    case "intent":
      return {
        label: "Purpose",
        title: `What should happen with ${thing}?`,
        blurb:
          "This decides the rest of the steps, so it is the only one worth thinking about.",
      };
    case "shape":
      return {
        label: "Details",
        title: `What do you record about ${thing}?`,
        blurb:
          "These become the columns you fill in, and the details a customer sees. You can add and remove them later.",
      };
    case "records":
      return {
        label: "Add them",
        title: `Add your first ${thing}`,
        blurb:
          "Real ones, not examples — the next steps attach settings to each one individually, so they need to exist first.",
      };
    case "bookable":
      return {
        label: "Availability",
        title: `How many of each can be booked at once?`,
        blurb:
          "Availability is worked out per booking, from what is already taken — which is why it is set here, on each one, and not as a field you fill in.",
      };
    case "request":
      return {
        label: "Requests",
        title: `What do you need from someone asking about ${thing}?`,
        blurb:
          "This is a second, separate list: one record per request. That record is the customer — there is no separate customer list to link up.",
      };
    case "form":
      return {
        label: "Form",
        title: "Publish the form people fill in",
        blurb:
          "It shows your list, takes the request, and tells us which of your fields mean what — so nothing is read by guesswork.",
      };
    case "done":
      return {
        label: "Done",
        title: "That is the whole loop",
        blurb: "Here is what you built, and where each piece lives from now on.",
      };
  }
}

export const INTENT_COPY: Record<SetupIntent, { label: string; blurb: string }> = {
  list: {
    label: "Just keep a list",
    blurb: "Somewhere to record them and search them. Nothing public, no forms.",
  },
  enquiries: {
    label: "Let people ask about them",
    blurb: "A public page showing what you have, and a form that sends you the enquiry.",
  },
  bookings: {
    label: "Let people book them for a time",
    blurb:
      "The same, plus availability: each booking is checked against what is already taken, and priced.",
  },
};

/**
 * Why a step cannot be done yet, in the user's terms, or `null` when it is
 * ready. The page uses this both to gate "Next" and to explain the gate —
 * a disabled button with no reason is the thing this whole flow exists to
 * stop happening.
 */
export function blockingReason(step: SetupStepId, state: SetupRunState): string | null {
  const thing = state.thingLabel.trim() || "them";

  switch (step) {
    case "thing":
      return state.thingLabel.trim() ? null : "Give them a name first.";
    case "intent":
      return state.intent ? null : "Pick one to carry on.";
    case "shape":
      return state.resourceEntityId ? null : `Create the list of ${thing} first.`;
    case "records":
      return state.recordCount > 0 ? null : `Add at least one of your ${thing}.`;
    case "bookable":
      // One is enough to carry on: a business with forty boats should not
      // have to configure all forty before it can see a form work. The step
      // says so rather than waiting.
      return state.bookableRecordCount > 0
        ? null
        : "Set availability on at least one, so a booking has something to check against.";
    case "request":
      return state.requestEntityId ? null : "Create the list that holds incoming requests.";
    case "form":
      if (!state.formId) return "Create the form.";
      return state.formPublished ? null : "Publish the form to finish.";
    case "done":
      return null;
  }
}

/** Steps in this run, each with its position, copy and whether it is done. */
export type StepProgress = {
  id: SetupStepId;
  index: number;
  copy: StepCopy;
  complete: boolean;
  /** Reachable means every step before it is complete — a run is a path, not
   * a menu, but a completed step stays open to go back to. */
  reachable: boolean;
};

export function progressFor(state: SetupRunState): StepProgress[] {
  const steps = stepsFor(state.intent);
  let reachable = true;

  return steps.map((id, index) => {
    const complete = blockingReason(id, state) === null;
    const entry: StepProgress = {
      id,
      index,
      copy: stepCopy(id, state),
      complete,
      reachable,
    };
    // Everything after the first incomplete step is out of reach.
    if (!complete) reachable = false;
    return entry;
  });
}

/** The step a run should open on: the first one not yet done, or the last. */
export function currentStep(state: SetupRunState): SetupStepId {
  const steps = stepsFor(state.intent);
  return steps.find((id) => blockingReason(id, state) !== null) ?? steps[steps.length - 1];
}

/** The step after `step` in this run, or null at the end. */
export function nextStep(step: SetupStepId, state: SetupRunState): SetupStepId | null {
  const steps = stepsFor(state.intent);
  const index = steps.indexOf(step);
  if (index < 0) return null;
  return steps[index + 1] ?? null;
}

export function previousStep(step: SetupStepId, state: SetupRunState): SetupStepId | null {
  const steps = stepsFor(state.intent);
  const index = steps.indexOf(step);
  if (index <= 0) return null;
  return steps[index - 1] ?? null;
}

/** True once every step of the run's own path is complete. */
export function isRunComplete(state: SetupRunState): boolean {
  return stepsFor(state.intent).every((id) => blockingReason(id, state) === null);
}
