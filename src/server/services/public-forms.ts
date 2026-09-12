/**
 * Public form submission — the only unauthenticated write surface in the
 * product (GRAFT-09, docs/BACKEND.md §5, §6, docs/TIERS.md §2.2). Highest-risk
 * endpoint in the MVP: assume every request is hostile.
 *
 * Three things matter enough to call out:
 *
 *   - **There is no ctx on the way in.** A public submitter presents a
 *     `publicSlug`, not a token, so the tenant is discovered by
 *     `forms.findByPublicSlug` (which reads the collection directly, the same
 *     reasoning as accounts-store.ts) and a ctx is synthesised from what that
 *     lookup returns. `PUBLIC_SUBMITTER_ID` is not a real user — nothing here
 *     needs one, since this path never calls `assertPermission`.
 *   - **Spam is scored before anything is written, not after.** A filled
 *     honeypot or a too-fast submit returns the same 201 a real submission
 *     gets (indistinguishable to whatever produced it) but touches no
 *     collection at all — not `form_submissions`, not `records`, not the
 *     meter (AC3, AC4, AC5).
 *   - **Submission, record and meter increment are one transaction.** Quota is
 *     reserved first (the guarded `$inc`, same shape as meters.ts's, just
 *     session-bound), then the submission and the record — an abort after any
 *     step undoes all of them, which is the whole of AC2 and the reason this
 *     issue needs a MongoDB replica set (see docker-compose.dev.yml).
 *     meters.ts's own `checkQuota` isn't reused directly for this: it has no
 *     session parameter, and pairing it with a second, unrelated transaction
 *     would not be atomic with it.
 */
import { ObjectId, type ClientSession } from "mongodb";
import { z } from "zod";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import {
  compileEntitySchema,
  getEntity as getEntityDefault,
  type EntityView,
} from "./entities";
import {
  findByPublicSlug as findByPublicSlugDefault,
  formSlugSchema,
  isFormServable,
  type FormDoc,
} from "./forms";
import {
  bridgeBooking as bridgeBookingDefault,
  mongoBookingBridgeStore,
  type BridgeResult,
} from "./booking-bridge";
import { isReadOnly, loadEntitlements, type Entitlements } from "./entitlements";
import { periodFor, type Meter } from "./meters";
import type { RecordDoc } from "./records";

/**
 * A sentinel, not a user — this path never authenticates anyone, so no real
 * `userId` exists. All-zero because it is instantly recognisable as a
 * placeholder in a log line or a document dump, never a real Mongo `_id`
 * minted by the driver (those embed a timestamp and are never all-zero).
 */
export const PUBLIC_SUBMITTER_ID = "000000000000000000000000";

const METER: Meter = "form_submissions";

/**
 * How long a human plausibly takes to fill the shortest real form. Below
 * this, `_t` (the client-supplied render timestamp) says the submit followed
 * the page load too closely to have been typed (AC4). Generous on purpose —
 * false positives cost a real submission, false negatives cost nothing since
 * the honeypot is the first line of defence.
 */
export const MIN_FILL_MS = 1_500;

export const submitFormSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  /** Honeypot — a real browser never fills this (AC3). */
  _hp: z.string().optional(),
  /** Client-supplied render timestamp, ms since epoch (AC4). */
  _t: z.number(),
  /**
   * Which catalogue record the visitor picked, on a form in catalogue mode.
   * Carried out-of-band rather than inside `data` so it can never be confused
   * with something the visitor typed: whatever `data` says about the
   * selection key is discarded and replaced with the record this names, after
   * that record has been proved to exist in this form's own catalogue.
   */
  _selection: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, "Not a valid selection")
    .optional(),
});

export type SubmitFormInput = z.input<typeof submitFormSchema>;

export type SubmitFormResult = { submissionId: string };

/** AC3, AC4 — a filled honeypot or a too-fast submit, either is spam. */
export function isSpamSubmission(input: {
  hp?: string;
  renderedAt: number;
  now: number;
}): boolean {
  if (input.hp !== undefined && input.hp.length > 0) return true;
  return input.now - input.renderedAt < MIN_FILL_MS;
}

/**
 * The tenant slug half of `publicSlug` follows the same alphabet as a form
 * slug (both are produced by src/server/services/slugs.ts's `slugify`), so
 * the same schema validates either segment.
 */
function reconstructPublicSlug(segments: readonly string[]): string | null {
  const [tenantSlug, formSlug] = segments;
  if (!tenantSlug || !formSlug) return null;
  const tenant = formSlugSchema.safeParse(tenantSlug);
  const form = formSlugSchema.safeParse(formSlug);
  if (!tenant.success || !form.success) return null;
  return `${tenant.data}/${form.data}`;
}

/** No `assertPermission` runs on this path — see module docs for why a
 * placeholder ctx is safe here. */
function buildCtx(requestId: string, tenantId: string): Ctx {
  return createContext({
    requestId,
    tenantId,
    userId: PUBLIC_SUBMITTER_ID,
    roles: ["member"],
    tier: "free",
  });
}

export type PublicFormDeps = {
  findByPublicSlug: (publicSlug: string) => Promise<(FormDoc & { _id: ObjectId }) | null>;
  getEntity: (ctx: Ctx, entityId: string) => Promise<EntityView>;
  /** Proves a selection names a live record of *this form's* catalogue entity.
   * No ctx: this path has no authenticated user, and the tenant comes from the
   * form, never from the request. */
  findCatalogueRecord: (
    tenantId: ObjectId,
    entityDefId: ObjectId,
    recordId: string,
  ) => Promise<boolean>;
  loadEntitlements: (ctx: Ctx) => Promise<Entitlements>;
  store: PublicFormWriteStore;
  /** The order-and-allocation half of a booking form (booking-bridge.ts),
   * injected as one function because it is a whole subsystem this module
   * calls into and a whole subsystem a test of *this* module should be able
   * to stand in for. */
  bridgeBooking: (
    session: ClientSession,
    input: {
      tenantId: ObjectId;
      booking: FormDoc["booking"];
      selectedRecordId: ObjectId | null;
      submissionRecordId: ObjectId;
      data: Record<string, unknown>;
      now: Date;
      requestId: string;
    },
  ) => Promise<BridgeResult | null>;
  now: () => Date;
};

function resolveDeps(overrides: Partial<PublicFormDeps> = {}): PublicFormDeps {
  return {
    findByPublicSlug: overrides.findByPublicSlug ?? findByPublicSlugDefault,
    getEntity: overrides.getEntity ?? ((ctx, entityId) => getEntityDefault(ctx, entityId)),
    findCatalogueRecord:
      overrides.findCatalogueRecord ??
      (async (tenantId, entityDefId, recordId) => {
        if (!ObjectId.isValid(recordId)) return false;
        const db = await getDb();
        const found = await db.collection<RecordDoc>("records").findOne(
          {
            _id: new ObjectId(recordId),
            tenantId,
            entityDefId,
            deletedAt: null,
          },
          { projection: { _id: 1 } },
        );
        return found !== null;
      }),
    loadEntitlements: overrides.loadEntitlements ?? ((ctx) => loadEntitlements(ctx)),
    store: overrides.store ?? mongoPublicFormWriteStore(),
    bridgeBooking:
      overrides.bridgeBooking ??
      ((session, input) =>
        bridgeBookingDefault(session, { ...input, store: mongoBookingBridgeStore() })),
    now: overrides.now ?? (() => new Date()),
  };
}

/**
 * The write half of the transaction, behind a port — same reasoning as
 * `MeterStore` (meters.ts) and `EntitlementStore` (entitlements.ts): the
 * atomicity claim is about the database, so it has to be provable against a
 * real one, and a port is what lets a test induce a failure *between* two
 * genuine, session-bound writes without mocking the transaction itself away.
 */
export type PublicFormWriteStore = {
  /** Create-if-absent via upsert (see the implementation for why this can't
   * be an `insertOne` that swallows a duplicate-key error, unlike
   * `mongoMeterStore.ensure`, which isn't session-bound). */
  ensureMeterDoc(
    session: ClientSession,
    tenantId: ObjectId,
    period: string,
    now: Date,
  ): Promise<void>;
  /** The guarded `$inc`: `null` limit means unlimited, no ceiling passed at
   * all (AC8's convention, carried over from meters.ts). False means refused
   * and, since this runs inside the transaction, nothing else in it survives. */
  incrementMeter(
    session: ClientSession,
    tenantId: ObjectId,
    period: string,
    limit: number | null,
    now: Date,
  ): Promise<boolean>;
  insertRecord(session: ClientSession, doc: RecordDoc & { _id: ObjectId }): Promise<void>;
  insertSubmission(
    session: ClientSession,
    doc: {
      _id: ObjectId;
      tenantId: ObjectId;
      formId: ObjectId;
      recordId: ObjectId;
      /** The catalogue record this submission is *about* — distinct from
       * `recordId`, which is the record the submission itself became. Null on
       * an ordinary form. This is what lets an order be raised against the
       * thing the customer actually picked. */
      selectedRecordId: ObjectId | null;
      /** The order this submission raised, on a booking form (§3.1's
       * `CustomerAction.order_id`). Null on every other form. */
      orderId: ObjectId | null;
      /** The capacity it reserved, if the resource had a pool. */
      allocationId: ObjectId | null;
      deletedAt: null;
      createdAt: Date;
      updatedAt: Date;
    },
  ): Promise<void>;
};

export function mongoPublicFormWriteStore(): PublicFormWriteStore {
  return {
    async ensureMeterDoc(session, tenantId, period, now) {
      const db = await getDb();
      // `upsert` + `$setOnInsert`, not `insertOne` swallowing E11000: MongoDB
      // does not auto-abort a transaction on a write error the way it does a
      // Postgres one, so a caught-and-ignored duplicate-key error still
      // leaves the transaction unable to commit — `session.withTransaction`
      // then sees that as transient and retries the *whole* callback, which
      // hits the identical duplicate key again and loops until its own
      // retry budget (120s by default) is exhausted. An upsert on the same
      // unique key is a single atomic match-or-create with nothing to catch.
      await db.collection("usage_meters").updateOne(
        { tenantId, meter: METER, period, deletedAt: null },
        {
          $setOnInsert: { count: 0, warnedAt: null, createdAt: now },
          $set: { updatedAt: now },
        },
        { session, upsert: true },
      );
    },

    async incrementMeter(session, tenantId, period, limit, now) {
      const db = await getDb();
      const filter: Record<string, unknown> = {
        tenantId,
        meter: METER,
        period,
        deletedAt: null,
      };
      if (limit !== null) filter.count = { $lte: limit - 1 };
      const incremented = await db
        .collection("usage_meters")
        .findOneAndUpdate(
          filter,
          { $inc: { count: 1 }, $set: { updatedAt: now } },
          { session, returnDocument: "after" },
        );
      return incremented !== null;
    },

    async insertRecord(session, doc) {
      const db = await getDb();
      await db.collection<RecordDoc>("records").insertOne(doc, { session });
    },

    async insertSubmission(session, doc) {
      const db = await getDb();
      await db.collection("form_submissions").insertOne(doc, { session });
    },
  };
}

/**
 * Catalogue selection, resolved before validation so the compiled schema sees
 * the finished record.
 *
 * Exported and pure-ish (its one dependency is passed in) because everything
 * that makes it safe is decided here, before the transaction: the module's
 * own convention is that the transactional write is proven against a real
 * replica set in the integration suite, and everything provable without one
 * is a function a unit test can call.
 *
 * The selection key is *always* overwritten — set from `_selection` or deleted
 * outright — never merged. A visitor who puts their own value under that key
 * in `data` is writing into a field the server owns, and letting the two
 * compete would make "which product is this order for" something the customer
 * could forge. That value is what an order gets raised against downstream.
 */
export async function resolveSelection(
  form: Pick<FormDoc, "catalogue" | "tenantId">,
  data: Record<string, unknown>,
  selection: string | undefined,
  findCatalogueRecord: PublicFormDeps["findCatalogueRecord"],
): Promise<{ data: Record<string, unknown>; selectedRecordId: ObjectId | null }> {
  const selectionKey = form.catalogue?.selectionKey ?? null;
  const resolved: Record<string, unknown> = { ...data };

  if (!selectionKey) return { data: resolved, selectedRecordId: null };

  delete resolved[selectionKey];
  if (!selection) return { data: resolved, selectedRecordId: null };

  const exists = await findCatalogueRecord(
    form.tenantId,
    form.catalogue!.entityDefId,
    selection,
  );
  // A selection naming something that is not in this form's catalogue is a
  // 400, not a silently dropped field: the visitor asked for a specific thing
  // and is entitled to know it could not be honoured.
  if (!exists) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { _selection: "That item is no longer available" },
    });
  }

  resolved[selectionKey] = selection;
  return { data: resolved, selectedRecordId: new ObjectId(selection) };
}

/**
 * AC1, AC2, AC7 — the guarded increment first (reserve before write, the same
 * convention as entities.ts and forms.ts), then the record, then the
 * submission. `session.withTransaction` aborts and retries the whole
 * callback on a transient error and aborts outright on anything else, so a
 * throw at any point here undoes every write already made inside it — that
 * is AC2 in its entirety.
 */
async function writeSubmissionTransactionally(
  session: ClientSession,
  deps: PublicFormDeps,
  ctx: Ctx,
  form: FormDoc & { _id: ObjectId },
  entity: EntityView,
  entitlements: Entitlements,
  data: Record<string, unknown>,
  selectedRecordId: ObjectId | null,
  now: Date,
): Promise<SubmitFormResult> {
  const store = deps.store;
  const tenantId = new ObjectId(ctx.tenantId);
  const period = periodFor(METER, entitlements, now);

  if (isReadOnly(entitlements, METER)) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "This is read-only on your current plan. Upgrade to make changes; nothing has been deleted.",
      { meter: METER, reason: "read_only" },
    );
  }

  await store.ensureMeterDoc(session, tenantId, period, now);

  const limit = entitlements.limits.submissionsPerMonth;
  const allowed = await store.incrementMeter(session, tenantId, period, limit, now);
  if (!allowed) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "You have reached your plan's limit. Upgrade to continue.",
      { meter: METER, limit, reason: "quota_exceeded" },
    );
  }

  const recordId = new ObjectId();
  await store.insertRecord(session, {
    _id: recordId,
    tenantId,
    entityDefId: form.entityDefId,
    schemaVersion: entity.schemaVersion,
    data,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // The bridge runs *after* the record exists, because the order it raises
  // points back at it — and inside this transaction, so a capacity conflict
  // takes the record and the meter increment down with it rather than
  // leaving a booking nobody can honour (booking-bridge.ts).
  const bridged = await deps.bridgeBooking(session, {
    tenantId,
    booking: form.booking,
    selectedRecordId,
    submissionRecordId: recordId,
    data,
    now,
    requestId: ctx.requestId,
  });

  const submissionId = new ObjectId();
  await store.insertSubmission(session, {
    _id: submissionId,
    tenantId,
    formId: form._id,
    recordId,
    selectedRecordId,
    orderId: bridged?.orderId ?? null,
    allocationId: bridged?.allocationId ?? null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  return { submissionId: submissionId.toHexString() };
}

/**
 * AC1–AC10. Returns `{ submissionId }` on a genuine or a spam-scored
 * submission alike — the caller (the route) always answers 201, so a bot
 * filling the honeypot cannot distinguish acceptance from rejection.
 */
export async function submitPublicForm(
  requestId: string,
  publicSlugSegments: readonly string[],
  input: unknown,
  overrides: Partial<PublicFormDeps> = {},
): Promise<SubmitFormResult> {
  const deps = resolveDeps(overrides);

  const publicSlug = reconstructPublicSlug(publicSlugSegments);
  if (!publicSlug) throw new AppError("NOT_FOUND", "Form not found");

  const form = await deps.findByPublicSlug(publicSlug);
  // AC9 — unpublished, killed and unknown are all the same 404.
  if (!form || !isFormServable(form)) throw new AppError("NOT_FOUND", "Form not found");

  const ctx = buildCtx(requestId, form.tenantId.toHexString());

  const parsed = parse(submitFormSchema, input, "body");

  const { data: rawData, selectedRecordId } = await resolveSelection(
    form,
    parsed.data,
    parsed._selection,
    deps.findCatalogueRecord,
  );

  // AC6 — validated against the *form's* field list (a real subset of the
  // entity's), not the entity's own schema: a public submitter only ever
  // sees the fields the form chose to expose.
  const compiled = compileEntitySchema(form.fields);
  const data = parse(compiled, rawData, "body") as Record<string, unknown>;

  const now = deps.now();
  // AC3, AC4, AC5 — scored before anything is written, and indistinguishable
  // from a real acceptance either way.
  if (isSpamSubmission({ hp: parsed._hp, renderedAt: parsed._t, now: now.getTime() })) {
    return { submissionId: new ObjectId().toHexString() };
  }

  const entity = await deps.getEntity(ctx, form.entityDefId.toHexString()).catch((error) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      throw new AppError("NOT_FOUND", "Form not found");
    }
    throw error;
  });
  const entitlements = await deps.loadEntitlements(ctx);

  const client = await getMongoClient();
  const session = client.startSession();
  try {
    return await session.withTransaction(() =>
      writeSubmissionTransactionally(
        session,
        deps,
        ctx,
        form,
        entity,
        entitlements,
        data,
        selectedRecordId,
        now,
      ),
    );
  } finally {
    await session.endSession();
  }
}
